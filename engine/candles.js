const DURATIONS = Object.freeze({ M15: 15 * 60_000, H4: 4 * 60 * 60_000 });

export function timeframeMs(timeframe) {
  if (!(timeframe in DURATIONS)) throw new Error(`Unsupported timeframe: ${timeframe}`);
  return DURATIONS[timeframe];
}

export function validateCandle(candle) {
  const issues = [];
  if (!candle.isComplete) issues.push({ severity: "ERROR", code: "INCOMPLETE_CANDLE", timestamp: candle.timestampOpen, message: "Core calculations require a completed candle." });
  if (candle.timestampClose <= candle.timestampOpen || candle.timestampClose - candle.timestampOpen !== timeframeMs(candle.timeframe)) {
    issues.push({ severity: "ERROR", code: "TIMEFRAME_MISMATCH", timestamp: candle.timestampOpen, message: "Candle duration does not match its timeframe." });
  }
  if (candle.open <= 0n || candle.high <= 0n || candle.low <= 0n || candle.close <= 0n || candle.high < candle.low || candle.high < candle.open || candle.high < candle.close || candle.low > candle.open || candle.low > candle.close) {
    issues.push({ severity: "ERROR", code: "INVALID_OHLC", timestamp: candle.timestampOpen, message: "OHLC ordering/positivity rule failed." });
  }
  return issues;
}

export function validateSeries(series) {
  const issues = [];
  if (!series?.candles?.length) return { valid: false, issues: [{ severity: "ERROR", code: "EMPTY_SERIES", message: "Series contains no candles." }] };
  let previous;
  series.candles.forEach((candle, index) => {
    for (const issue of validateCandle(candle)) issues.push({ ...issue, index });
    if (previous) {
      if (candle.timestampOpen <= previous.timestampOpen) issues.push({ severity: "ERROR", code: candle.timestampOpen === previous.timestampOpen ? "DUPLICATE_TIMESTAMP" : "NON_MONOTONIC_TIME", index, timestamp: candle.timestampOpen, message: "Timestamps must be strictly increasing." });
      const expected = previous.timestampOpen + timeframeMs(series.timeframe);
      if (candle.timestampOpen !== expected) issues.push({ severity: "WARNING", code: "GAP_DETECTED", index, timestamp: candle.timestampOpen, message: `Expected ${expected}, found ${candle.timestampOpen}.` });
    }
    previous = candle;
  });
  return { valid: !issues.some(i => i.severity === "ERROR"), issues };
}
