/**
 * POST /api/decide
 *
 * Stateless decision oracle for the signal-only Forex analysis system.
 *
 * The endpoint reuses the existing deterministic strategy modules. It never
 * places, modifies, or manages an order. A caller supplies M15/H4 candles,
 * a reference equity for sizing, and the current reference price (represented
 * by currentBid/currentAsk for backwards compatibility with the validated
 * entry model). The result is a signal decision only.
 *
 * The strategy remains the single source of truth: this file is orchestration,
 * not a second copy of the strategy rules.
 */

import { adaptDataset, buildTimeframeAlignment, h4VisibleAtM15Close } from '../src/research/dataset.js';
import { createCandidateDetector } from '../src/strategy/candidate-detector.js';
import {
  calculateAntiChase,
  calculateAtrBuffer,
  calculateStructuralStop,
  validateInitialStop,
  DEFAULT_ENTRY_STOP_CONFIG
} from '../src/strategy/entry-stop.js';
import { buildTpRiskDecision } from '../src/strategy/take-profit-risk.js';
import { evaluateFinalPermission } from '../src/strategy/final-gate.js';
import { detectConfirmedSwing } from '../engine/swings.js';
import { evaluateH4Context } from '../engine/context.js';
import { getH4Zones, DEFAULT_ZONE_CONFIG } from '../engine/zones.js';
import { calculateWilderATR } from '../engine/atr.js';
import { createPriceCodec } from '../engine/prices.js';

const codec = createPriceCodec(5);
const RISK_ATR_THRESHOLD = 7.414282863913105;

function httpError(message, statusCode, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

function validateInput({ m15, h4, equity, currentBid, currentAsk }) {
  if (!Array.isArray(m15) || !Array.isArray(h4) || m15.length === 0 || h4.length === 0) {
    throw httpError('m15 and h4 arrays are required and must be non-empty', 400);
  }
  if (!(equity > 0)) throw httpError('equity must be a positive number', 400);
  if (!(currentBid > 0) || !(currentAsk > 0)) throw httpError('currentBid and currentAsk are required', 400);
  if (currentAsk < currentBid) throw httpError('currentAsk must be greater than or equal to currentBid', 400);
}

function computeFreshCandidates(dataset, alignment) {
  const detector = createCandidateDetector({ dataset, alignment });
  const latestIndex = dataset.m15Candles.length - 1;
  const freshCandidates = [];

  // Maintain the exact H4 structure visibility semantics used by the original
  // implementation, without filtering the entire H4 array for every M15 bar.
  const h4ContextSwings = [];
  let lastVisibleH4Index = -1;

  for (let i = 0; i < dataset.m15Candles.length; i++) {
    const m = dataset.m15Candles[i];

    while (
      lastVisibleH4Index + 1 < dataset.h4Candles.length &&
      dataset.h4Candles[lastVisibleH4Index + 1].timestampClose <= m.timestampClose
    ) {
      lastVisibleH4Index += 1;
      const h4CandidateIndex = lastVisibleH4Index - 2;
      if (h4CandidateIndex >= 2) {
        const swing = detectConfirmedSwing(dataset.h4Candles, h4CandidateIndex);
        if (swing && swing.confirmationIndex <= lastVisibleH4Index) {
          h4ContextSwings.push(swing);
        }
      }
    }

    const context = evaluateH4Context(h4ContextSwings, m.timestampClose);
    const found = detector({ m15Index: i, m15Candle: m, h4Context: context });
    for (const candidate of found) {
      if (candidate.bos.confirmationIndex === latestIndex) freshCandidates.push(candidate);
    }
  }

  return freshCandidates;
}

function decideCandidate({
  dataset,
  candidate,
  equity,
  currentBid,
  currentAsk,
  positionExists,
  executedSetupIds
}) {
  const direction = candidate.direction;
  const entryPrice = codec.fromDecimal(String(direction === 'BUY' ? currentAsk : currentBid));

  const atrBuffer = calculateAtrBuffer(
    dataset.m15Candles,
    candidate.bos.confirmationIndex,
    DEFAULT_ENTRY_STOP_CONFIG.atrPeriod,
    DEFAULT_ENTRY_STOP_CONFIG.slBufferAtr
  );
  if (!atrBuffer.valid) {
    return { setupId: candidate.setupId, direction, decision: 'NO_TRADE', reasons: ['DATA_INVALID'] };
  }

  const atr = calculateWilderATR(
    dataset.m15Candles,
    DEFAULT_ENTRY_STOP_CONFIG.atrPeriod,
    candidate.bos.confirmationIndex
  );
  const atrPriceUnits = atr?.valueInPriceUnits ?? null;
  if (!atrPriceUnits) {
    return { setupId: candidate.setupId, direction, decision: 'NO_TRADE', reasons: ['DATA_INVALID'] };
  }

  const reactionReference = candidate.reactionSwing?.price ?? entryPrice;
  const riskATR = Number(
    direction === 'BUY' ? entryPrice - reactionReference : reactionReference - entryPrice
  ) / atrPriceUnits;

  if (!(riskATR <= RISK_ATR_THRESHOLD)) {
    return {
      setupId: candidate.setupId,
      direction,
      decision: 'NO_TRADE',
      reasons: ['RISK_ATR_ABOVE_FROZEN_THRESHOLD'],
      riskATR
    };
  }

  const brokenReferencePrice = candidate.bos.referencePrice ?? candidate.bos.reference?.price;
  if (typeof brokenReferencePrice !== 'bigint') {
    return { setupId: candidate.setupId, direction, decision: 'NO_TRADE', reasons: ['DATA_INVALID'] };
  }

  const antiChase = calculateAntiChase({
    direction,
    entryPrice,
    brokenReferencePrice,
    atrPriceUnits,
    maxExtensionAtr: DEFAULT_ENTRY_STOP_CONFIG.maxExtensionAtr
  });

  const stop = calculateStructuralStop({
    direction,
    reactionSwing: candidate.reactionSwing,
    zone: candidate.zone,
    bufferPriceTicks: atrBuffer.bufferPriceTicks
  });

  const stopValidation = stop.valid
    ? validateInitialStop({
        direction,
        entryPrice,
        stopPrice: stop.stopPrice,
        reactionSwing: candidate.reactionSwing,
        zone: candidate.zone
      })
    : { valid: false, reasons: ['DATA_INVALID'] };

  const entryStop = {
    decision: antiChase.pass && stop.valid && stopValidation.valid ? 'TRADE_VALIDATION' : 'NO_TRADE',
    reasons: [
      ...(antiChase.pass ? [] : ['ENTRY_TOO_EXTENDED']),
      ...(stop.valid ? [] : ['DATA_INVALID']),
      ...(stop.valid && !stopValidation.valid
        ? stopValidation.reasons
            .filter((r) => r !== 'INVALID_STOP_ZONE_PROTECTION' && r !== 'INVALID_STOP_REACTION_PROTECTION')
            .concat(stopValidation.reasons.some((r) => r.startsWith('INVALID_STOP')) ? ['INVALID_STOP'] : [])
        : [])
    ],
    antiChase,
    stopValidation
  };

  const confirmationCandle = dataset.m15Candles[candidate.bos.confirmationIndex];
  const visibleH4AtConfirmation = h4VisibleAtM15Close(dataset.h4Candles, confirmationCandle);
  const swingsAtConfirmation = visibleH4AtConfirmation.length > 0
    ? (() => {
        const out = [];
        const maxCandidate = visibleH4AtConfirmation.length - 1 - 2;
        for (let i = 2; i <= maxCandidate; i++) {
          const swing = detectConfirmedSwing(visibleH4AtConfirmation, i);
          if (swing && swing.confirmationIndex <= visibleH4AtConfirmation.length - 1) out.push(swing);
        }
        return out;
      })()
    : [];

  const zonesAtConfirmation = getH4Zones(
    dataset.h4Candles,
    swingsAtConfirmation,
    visibleH4AtConfirmation.length - 1,
    DEFAULT_ZONE_CONFIG
  );

  const tpRisk = stop.valid
    ? buildTpRiskDecision({
        direction,
        entryPrice,
        stopPrice: stop.stopPrice,
        zones: zonesAtConfirmation,
        sizing: { equity, priceScale: 5, moneyPerPriceUnitPerUnit: 1, riskPercent: 1 }
      })
    : { decision: 'NO_TRADE' };

  const finalPermission = evaluateFinalPermission({
    direction,
    context: { state: candidate.upstream.context?.direction ?? 'UNCLEAR' },
    zone: { valid: true },
    location: { atZone: true },
    pullback: { confirmed: candidate.upstream.pullback?.state === 'CONFIRMED' },
    reaction: { confirmed: candidate.upstream.reaction?.state === 'CONFIRMED' },
    bos: candidate.bos,
    entryStop,
    tpRisk,
    setup: { used: executedSetupIds.includes(candidate.setupId) },
    positionExists
  });

  return {
    setupId: candidate.setupId,
    direction,
    decision: finalPermission.decision,
    reasons: finalPermission.reasons,
    riskATR,
    entryPrice: codec.toDecimal(entryPrice),
    stopPrice: stop.valid ? codec.toDecimal(stop.stopPrice) : null,
    targetPrice: tpRisk?.target?.valid ? codec.toDecimal(tpRisk.target.targetPrice) : null,
    rr: tpRisk?.rr?.rr ?? null,
    positionSize: tpRisk?.position?.size ?? null,
    actualRiskMoney: tpRisk?.position?.actualRiskMoney ?? null,
    evidence: finalPermission.evidence
  };
}

/** Pure decision function shared by HTTP callers and the live signal scanner. */
export function decideSignals({
  m15,
  h4,
  equity,
  currentBid,
  currentAsk,
  positionExists = false,
  executedSetupIds = []
}) {
  validateInput({ m15, h4, equity, currentBid, currentAsk });

  const dataset = adaptDataset({ instrument: 'EURUSD', priceScale: 5, m15, h4 });
  const alignment = buildTimeframeAlignment(dataset, { requireCompleteH4Buckets: false });
  if (!alignment.valid) {
    throw httpError('timeframe alignment invalid', 422, alignment.issues.slice(0, 10));
  }

  const latestIndex = dataset.m15Candles.length - 1;
  const latestCandle = dataset.m15Candles[latestIndex];
  if (latestCandle.isComplete === false) {
    throw httpError('latest M15 candle must be complete for signal generation', 422);
  }

  const freshCandidates = computeFreshCandidates(dataset, alignment);
  const decisions = freshCandidates.map((candidate) => decideCandidate({
    dataset,
    candidate,
    equity,
    currentBid,
    currentAsk,
    positionExists,
    executedSetupIds
  }));

  return {
    generatedAt: new Date().toISOString(),
    latestIndex,
    latestCandleTimestamp: latestCandle.timestampOpen,
    latestCandleCloseTimestamp: latestCandle.timestampClose,
    freshCandidateCount: freshCandidates.length,
    decisions
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  try {
    const result = decideSignals(req.body ?? {});
    res.status(200).json(result);
  } catch (err) {
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
    res.status(status).json({
      error: err?.message || 'Internal error',
      ...(err?.details ? { issues: err.details } : {})
    });
  }
}
