/**
 * Stage 38 — historical dataset adapter and H4/M15 alignment contract.
 *
 * Research/backtesting only. This module normalizes raw OHLC rows to the
 * engine's fixed-point BigInt price representation and verifies chronology,
 * timeframe durations, and cross-timeframe containment without repairing data.
 */

import { createPriceCodec } from "../../engine/prices.js";
import { validateSeries, timeframeMs } from "../../engine/candles.js";

const REQUIRED_TIMEFRAMES = Object.freeze(["M15", "H4"]);

function assertRawRow(row) {
  if (!row || typeof row !== "object") throw new Error("Each raw candle must be an object.");
  for (const key of ["timestampOpen", "open", "high", "low", "close"]) {
    if (row[key] === undefined || row[key] === null) throw new Error(`Raw candle missing ${key}.`);
  }
}

function decimalString(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Numeric price must be finite.");
    return value.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  }
  if (typeof value === "bigint") return value.toString();
  throw new Error("Price must be a decimal string, finite number, or BigInt.");
}

export function normalizeCandle(raw, { timeframe, instrument = "UNKNOWN", priceScale = 5 } = {}) {
  assertRawRow(raw);
  if (timeframe !== "M15" && timeframe !== "H4") throw new Error("Stage 38 supports M15 and H4 only.");
  if (!Number.isSafeInteger(raw.timestampOpen)) throw new Error("timestampOpen must be a safe integer millisecond timestamp.");

  const duration = timeframeMs(timeframe);
  const timestampOpen = raw.timestampOpen;
  const timestampClose = raw.timestampClose ?? timestampOpen + duration;
  if (!Number.isSafeInteger(timestampClose)) throw new Error("timestampClose must be a safe integer millisecond timestamp.");

  const codec = createPriceCodec(priceScale);
  return {
    instrument: raw.instrument ?? instrument,
    timeframe,
    timestampOpen,
    timestampClose,
    open: typeof raw.open === "bigint" ? raw.open : codec.fromDecimal(decimalString(raw.open)),
    high: typeof raw.high === "bigint" ? raw.high : codec.fromDecimal(decimalString(raw.high)),
    low: typeof raw.low === "bigint" ? raw.low : codec.fromDecimal(decimalString(raw.low)),
    close: typeof raw.close === "bigint" ? raw.close : codec.fromDecimal(decimalString(raw.close)),
    isComplete: raw.isComplete !== false
  };
}

function sortChronologically(candles) {
  return [...candles].sort((a, b) => a.timestampOpen - b.timestampOpen);
}

function duplicateTimestamps(candles) {
  const seen = new Set();
  const duplicates = [];
  for (const candle of candles) {
    if (seen.has(candle.timestampOpen)) duplicates.push(candle.timestampOpen);
    seen.add(candle.timestampOpen);
  }
  return duplicates;
}

export function adaptDataset({
  instrument = "UNKNOWN",
  priceScale = 5,
  m15,
  h4
}) {
  if (!Array.isArray(m15) || !Array.isArray(h4)) throw new Error("m15 and h4 raw arrays are required.");
  const m15Candles = sortChronologically(m15.map(row => normalizeCandle(row, { timeframe: "M15", instrument, priceScale })));
  const h4Candles = sortChronologically(h4.map(row => normalizeCandle(row, { timeframe: "H4", instrument, priceScale })));

  const m15Validation = validateSeries({ instrument, timeframe: "M15", candles: m15Candles });
  const h4Validation = validateSeries({ instrument, timeframe: "H4", candles: h4Candles });
  const issues = [
    ...m15Validation.issues.map(i => ({ timeframe: "M15", ...i })),
    ...h4Validation.issues.map(i => ({ timeframe: "H4", ...i }))
  ];

  for (const [timeframe, candles] of [["M15", m15Candles], ["H4", h4Candles]]) {
    for (const timestamp of duplicateTimestamps(candles)) {
      issues.push({ severity: "ERROR", timeframe, code: "DUPLICATE_TIMESTAMP", timestamp, message: "Duplicate candle timestamp after normalization." });
    }
  }

  return Object.freeze({
    instrument,
    priceScale,
    requiredTimeframes: REQUIRED_TIMEFRAMES,
    m15Candles: Object.freeze(m15Candles),
    h4Candles: Object.freeze(h4Candles),
    validation: Object.freeze({
      m15: m15Validation,
      h4: h4Validation,
      issues: Object.freeze(issues),
      valid: !issues.some(i => i.severity === "ERROR")
    })
  });
}

function findH4ForM15(h4Candles, m15Candle) {
  return h4Candles.find(h4 => h4.timestampOpen <= m15Candle.timestampOpen && h4.timestampClose >= m15Candle.timestampClose) ?? null;
}

export function buildTimeframeAlignment(dataset, { requireCompleteH4Buckets = false } = {}) {
  if (!dataset?.m15Candles || !dataset?.h4Candles) throw new Error("adapted dataset is required.");
  const mapping = [];
  const issues = [];
  const counts = new Map();

  for (let i = 0; i < dataset.m15Candles.length; i++) {
    const m15 = dataset.m15Candles[i];
    const h4 = findH4ForM15(dataset.h4Candles, m15);
    if (!h4) {
      issues.push({ severity: "ERROR", code: "M15_NOT_CONTAINED_IN_H4", m15Index: i, timestamp: m15.timestampOpen, message: "M15 candle is not fully contained in an H4 candle." });
      mapping.push(null);
      continue;
    }
    const h4Index = dataset.h4Candles.indexOf(h4);
    mapping.push(h4Index);
    counts.set(h4Index, (counts.get(h4Index) ?? 0) + 1);
  }

  for (const [h4Index, h4] of dataset.h4Candles.entries()) {
    const count = counts.get(h4Index) ?? 0;
    if (count !== 16) {
      const issue = { severity: requireCompleteH4Buckets ? "ERROR" : "WARNING", code: "H4_M15_COUNT_MISMATCH", h4Index, timestamp: h4.timestampOpen, count, expected: 16, message: "An H4 candle does not have exactly sixteen fully-contained M15 candles." };
      issues.push(issue);
    }
  }

  // A given M15 candle may map to only one H4 candle by construction. Require
  // ordered mapping: H4 index cannot move backward through the M15 stream.
  let previousH4 = -1;
  for (let i = 0; i < mapping.length; i++) {
    const currentH4 = mapping[i];
    if (currentH4 === null) continue;
    if (currentH4 < previousH4) {
      issues.push({ severity: "ERROR", code: "CROSS_TIMEFRAME_NON_MONOTONIC", m15Index: i, message: "M15→H4 alignment moved backward in time." });
    }
    previousH4 = currentH4;
  }

  return Object.freeze({
    valid: !issues.some(i => i.severity === "ERROR"),
    issues: Object.freeze(issues),
    m15ToH4Index: Object.freeze(mapping),
    completeBuckets: [...counts.values()].filter(c => c === 16).length
  });
}

export function h4VisibleAtM15Close(h4Candles, m15Candle) {
  if (!Array.isArray(h4Candles)) throw new Error("h4Candles must be an array.");
  if (!m15Candle) throw new Error("m15Candle is required.");
  return Object.freeze(h4Candles.filter(h4 => h4.timestampClose <= m15Candle.timestampClose));
}
