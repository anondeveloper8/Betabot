export const V1_SWING_CONFIG = Object.freeze({ leftBars: 2, rightBars: 2 });

export function detectConfirmedSwing(candles, candidateIndex, config = V1_SWING_CONFIG) {
  const { leftBars, rightBars } = config;
  if (candidateIndex < leftBars || candidateIndex + rightBars >= candles.length) return null;
  const middle = candles[candidateIndex];
  for (let i = candidateIndex - leftBars; i <= candidateIndex + rightBars; i++) {
    if (!candles[i]?.isComplete) return null;
  }
  const left = candles.slice(candidateIndex - leftBars, candidateIndex);
  const right = candles.slice(candidateIndex + 1, candidateIndex + rightBars + 1);
  const isHigh = left.every(c => middle.high > c.high) && right.every(c => middle.high > c.high);
  const isLow = left.every(c => middle.low < c.low) && right.every(c => middle.low < c.low);
  if (!isHigh && !isLow) return null;
  const type = isHigh ? "HIGH" : "LOW";
  return {
    id: `${middle.instrument}-${middle.timeframe}-${middle.timestampOpen}-${type}`,
    instrument: middle.instrument,
    timeframe: middle.timeframe,
    candleIndex: candidateIndex,
    timestamp: middle.timestampOpen,
    type,
    price: isHigh ? middle.high : middle.low,
    leftBars,
    rightBars,
    confirmationIndex: candidateIndex + rightBars,
    confirmationTimestamp: candles[candidateIndex + rightBars].timestampClose,
    confirmed: true
  };
}

const swingCache = new WeakMap();

function configKey(config) {
  return `${config.leftBars}:${config.rightBars}`;
}

/**
 * Semantically identical to the original full scan, but memoized for the
 * common monotonic-time-series use case. The input candle arrays are treated
 * as immutable by the engine, so previously confirmed swings can be retained.
 * Calls with an earlier currentClosedIndex are answered by filtering the cached
 * confirmed swings, preserving the original function's observable result.
 */
export function getConfirmedSwings(candles, currentClosedIndex, config = V1_SWING_CONFIG) {
  const latestCandidate = currentClosedIndex - config.rightBars;
  if (latestCandidate < config.leftBars) return [];

  let byConfig = swingCache.get(candles);
  if (!byConfig) {
    byConfig = new Map();
    swingCache.set(candles, byConfig);
  }

  const key = configKey(config);
  let state = byConfig.get(key);
  if (!state) {
    state = { nextCandidate: config.leftBars, swings: [], lastCurrentClosedIndex: -1 };
    byConfig.set(key, state);
  }

  const boundedLatest = Math.min(latestCandidate, candles.length - 1 - config.rightBars);
  for (let i = state.nextCandidate; i <= boundedLatest; i++) {
    const swing = detectConfirmedSwing(candles, i, config);
    if (swing && swing.confirmationIndex <= currentClosedIndex) state.swings.push(swing);
  }
  state.nextCandidate = Math.max(state.nextCandidate, boundedLatest + 1);

  // Confirmed swings are appended in increasing candle/confirmation order.
  // Return the exact prefix visible at currentClosedIndex without allocating
  // and filtering the entire historical swing list on every M15 bar.
  if (currentClosedIndex >= state.lastCurrentClosedIndex) {
    state.lastCurrentClosedIndex = currentClosedIndex;
    return state.swings;
  }

  let lo = 0, hi = state.swings.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (state.swings[mid].confirmationIndex <= currentClosedIndex) lo = mid + 1;
    else hi = mid;
  }
  return state.swings.slice(0, lo);
}
