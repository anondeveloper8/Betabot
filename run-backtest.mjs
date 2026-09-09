/**
 * Canonical backtest report generator.
 *
 * Replaces replay.js as the script to run for an official report. Same
 * detection/candidate/backtest logic (UNCHANGED -- no strategy rule was
 * touched here), three bugs fixed:
 *
 *   1. BigInt serialization crash. Price fields are BigInt fixed-point
 *      throughout the engine. The old script's JSON.stringify(report) threw
 *      the instant a real completed trade appeared, because it had only
 *      ever been run against data with 0 candidates. A replacer converts
 *      BigInt -> string for JSON purposes only; nothing about the actual
 *      calculation changes.
 *
 *   2. Wrong field name in the summary stats. The old script read
 *      `r.result.R`, but the runner's field is `result.realizedR`. This
 *      silently produced totalR/wins/losses of null/0 on any run with real
 *      trades, while endingEquity (computed from the correctly-named
 *      `netMoney`) looked fine -- an easy inconsistency to miss. Fixed by
 *      deleting the hand-rolled stats block entirely and calling the
 *      project's own (already correct, already tested-looking, but
 *      previously unused) src/research/metrics.js#calculateBacktestMetrics.
 *
 *   3. Hardcoded/stale source metadata. The old script's `source` block had
 *      a fixed row count and date range string unrelated to whatever
 *      data.json was actually loaded. This version derives period and
 *      candle counts from the dataset that was actually passed in.
 *
 * Usage: node run-backtest.mjs [path/to/data.json] [runLabel]
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { adaptDataset, buildTimeframeAlignment, h4VisibleAtM15Close } from './src/research/dataset.js';
import { createCandidateDetector } from './src/strategy/candidate-detector.js';
import { DEFAULT_ENTRY_STOP_CONFIG, modelNextOpenEntry, calculateAtrBuffer, calculateStructuralStop } from './src/strategy/entry-stop.js';
import { getConfirmedSwings } from './engine/swings.js';
import { getH4Zones, DEFAULT_ZONE_CONFIG } from './engine/zones.js';
import { evaluateH4Context } from './engine/context.js';
import { calculateBacktestMetrics } from './src/research/metrics.js';
import { createPriceCodec } from './engine/prices.js';

const codec = createPriceCodec(5);

const dataPath = process.argv[2] ?? './data.json';
const runLabel = process.argv[3] ?? 'UNLABELED_RUN';

const jsonSafe = (_key, value) => (typeof value === 'bigint' ? value.toString() : value);

const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const dataset = adaptDataset({ instrument: 'EURUSD', priceScale: 5, m15: raw.m15, h4: raw.h4 });
const alignment = buildTimeframeAlignment(dataset, { requireCompleteH4Buckets: false });
if (!alignment.valid) throw new Error('alignment invalid: ' + JSON.stringify(alignment.issues.slice(0, 5)));

const detector = createCandidateDetector({ dataset, alignment });
const candidates = [];
let lastVisibleH4Index = -1;
for (let i = 0; i < dataset.m15Candles.length; i++) {
  const m = dataset.m15Candles[i];
  while (lastVisibleH4Index + 1 < dataset.h4Candles.length &&
         dataset.h4Candles[lastVisibleH4Index + 1].timestampClose <= m.timestampClose) {
    lastVisibleH4Index += 1;
  }
  const sw = lastVisibleH4Index >= 0
    ? getConfirmedSwings(dataset.h4Candles, lastVisibleH4Index)
    : [];
  const ctx = evaluateH4Context(sw, m.timestampClose);
  const c = detector({ m15Index: i, m15Candle: m, h4Context: ctx });
  for (const x of c) candidates.push(x);
}
console.log('candidates', candidates.length);

const threshold = 7.414282863913105; // Frozen risk-ATR gate -- unchanged, origin still unverified from supplied files.
const pre = [];
for (const candidate of candidates) {
  const i = candidate.bos.confirmationIndex;
  const entry = modelNextOpenEntry({ direction: candidate.direction, candles: dataset.m15Candles, confirmationIndex: i, spreadPriceTicks: 0n, slippagePriceTicks: 0n, requireNextCandleComplete: true });
  if (!entry.valid) continue;
  const buffer = calculateAtrBuffer(dataset.m15Candles, i, DEFAULT_ENTRY_STOP_CONFIG.atrPeriod, DEFAULT_ENTRY_STOP_CONFIG.slBufferAtr);
  if (!buffer.valid) continue;
  const stop = calculateStructuralStop({ direction: candidate.direction, reactionSwing: candidate.reactionSwing, zone: candidate.zone, bufferPriceTicks: buffer.bufferPriceTicks });
  if (!stop.valid) continue;
  const atr = candidate.atrPriceUnits;
  const riskATR = atr > 0 ? Number(stop.stopPrice > entry.entryPrice ? stop.stopPrice - entry.entryPrice : entry.entryPrice - stop.stopPrice) / atr : null;
  pre.push({ ...candidate, riskATR });
}
const eligible = pre.filter((c) => c.riskATR !== null && c.riskATR <= threshold);
console.log('pre candidates with geometry', pre.length, 'risk filter', eligible.length);

const frozen = eligible.sort((a, b) => a.bos.confirmationTimestamp - b.bos.confirmationTimestamp);
for (const c of frozen) {
  c.upstream.context = { ...c.upstream.context, state: c.upstream.context?.direction ?? 'UNCLEAR', directionalBias: c.upstream.context?.direction ?? 'UNCLEAR' };
  c.zone = { ...c.zone, valid: true };
  c.upstream.location = { ...c.upstream.location, atZone: true };
  c.upstream.pullback = { ...c.upstream.pullback, confirmed: c.upstream.pullback?.state === 'CONFIRMED' };
  c.upstream.reaction = { ...c.upstream.reaction, confirmed: c.upstream.reaction?.state === 'CONFIRMED' };
}
for (const c of frozen) {
  const visible = h4VisibleAtM15Close(dataset.h4Candles, dataset.m15Candles[c.bos.confirmationIndex]);
  const swings = getConfirmedSwings(visible, visible.length - 1);
  c.h4Zones = getH4Zones(dataset.h4Candles, swings, visible.length - 1, DEFAULT_ZONE_CONFIG);
}

const { runHistoricalTrade } = await import('./src/backtest-runner.js');
let equity = 10000;
const results = [];
let openUntil = -1;
for (const c of frozen) {
  const already = openUntil >= c.bos.confirmationIndex;
  const result = runHistoricalTrade({ candidate: c, m15Candles: dataset.m15Candles, h4Zones: c.h4Zones, equity, priceScale: 5, moneyPerPriceUnitPerUnit: 1, managementVariant: 'M0_NO_MANAGEMENT', managementConfig: {}, spreadPriceTicks: 0n, slippagePriceTicks: 0n, entryStopConfig: DEFAULT_ENTRY_STOP_CONFIG, setupId: c.setupId, strategyVersion: 'FROZEN-V1', instrument: 'EURUSD', onePositionOnly: true, existingPosition: already });
  results.push({
    setupId: c.setupId,
    direction: c.direction,
    detectorIndex: c.bos.confirmationIndex,
    riskATR: c.riskATR,
    decision: result.decision,
    reasons: result.reasons,
    entry: result.entry ? { valid: result.entry.valid, entryPrice: codec.toDecimal(result.entry.entryPrice), executionIndex: result.entry.executionIndex, timestamp: dataset.m15Candles[result.entry.executionIndex]?.timestampOpen ?? null } : null,
    stop: result.stop ? { valid: result.stop.valid, stopPrice: result.stop.valid ? codec.toDecimal(result.stop.stopPrice) : null } : null,
    target: result.target ? { valid: result.target.valid, targetPrice: result.target.valid ? codec.toDecimal(result.target.targetPrice) : null } : null,
    rr: result.rr ? { valid: result.rr.valid, rr: result.rr.rr ?? null } : null,
    result: result.result ?? null,
    exit: result.exit ? { ...result.exit, price: codec.toDecimal(result.exit.price), timestamp: dataset.m15Candles[result.exit.index]?.timestampOpen ?? null } : null
  });
  if (result.decision === 'TRADE_COMPLETED') {
    openUntil = result.exit.index;
    equity += result.result.netMoney;
  }
}

const backtestForMetrics = {
  results,
  candidatesProcessed: candidates.length,
  tradesRejected: results.filter((r) => r.decision === 'NO_TRADE').length,
  untestable: results.filter((r) => r.decision === 'UNTESTABLE_PERIOD').length,
  endingEquity: equity
};
const metrics = calculateBacktestMetrics(backtestForMetrics, { initialEquity: 10000 });

const m15Times = dataset.m15Candles.map((c) => c.timestampOpen);
const periodStart = m15Times.length ? new Date(Math.min(...m15Times)).toISOString().slice(0, 10) : null;
const periodEnd = m15Times.length ? new Date(Math.max(...m15Times)).toISOString().slice(0, 10) : null;

const report = {
  runLabel,
  status: 'REPLAY_COMPLETED',
  generatedAt: new Date().toISOString(),
  source: {
    instrument: 'EURUSD',
    priceSide: 'BID',
    timeframe: 'M1->M15/H4',
    dataFile: dataPath,
    period: periodStart && periodEnd ? `${periodStart} through ${periodEnd}` : 'unknown'
  },
  dataset: {
    m15: dataset.m15Candles.length,
    m15Complete: dataset.m15Candles.filter((x) => x.isComplete).length,
    h4: dataset.h4Candles.length,
    h4Complete: dataset.h4Candles.filter((x) => x.isComplete).length
  },
  frozen: { thresholdATR: threshold, management: 'M0_NO_MANAGEMENT', minRR: 2, antiChaseATR: 0.25, slBufferATR: 0.25 },
  discovery: { candidates: candidates.length, geometryEligible: pre.length, riskFiltered: eligible.length },
  metrics,
  trades: results,
  hash: null
};
report.hash = crypto.createHash('sha256').update(JSON.stringify(report, jsonSafe)).digest('hex');

const outPath = `./report-${runLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
fs.writeFileSync(outPath, JSON.stringify(report, jsonSafe, 2));
console.log(JSON.stringify(metrics, jsonSafe, 2));
console.log('hash', report.hash);
console.log('written to', outPath);
