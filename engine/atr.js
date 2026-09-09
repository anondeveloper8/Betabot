function trueRange(current, previous) {
  const high = Number(current.high), low = Number(current.low);
  if (!previous) return high - low;
  const pc = Number(previous.close);
  return Math.max(high - low, Math.abs(high - pc), Math.abs(low - pc));
}

export function calculateWilderATR(candles, period, index) {
  if (!Number.isInteger(period) || period <= 0) throw new Error("ATR period must be positive.");
  if (index < period || index >= candles.length) return null;
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += trueRange(candles[i], candles[i - 1]);
  atr /= period;
  for (let i = period + 1; i <= index; i++) atr = ((atr * (period - 1)) + trueRange(candles[i], candles[i - 1])) / period;
  return { period, index, valueInPriceUnits: atr };
}
