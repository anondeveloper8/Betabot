export function evaluateH4Context(confirmedSwings, evaluatedAt) {
  const available = confirmedSwings.filter(s => s.timeframe === "H4" && s.confirmationTimestamp <= evaluatedAt);
  const highs = available.filter(s => s.type === "HIGH").sort((a, b) => a.confirmationTimestamp - b.confirmationTimestamp);
  const lows = available.filter(s => s.type === "LOW").sort((a, b) => a.confirmationTimestamp - b.confirmationTimestamp);
  const latestSwingHigh = highs.at(-1), previousSwingHigh = highs.at(-2), latestSwingLow = lows.at(-1), previousSwingLow = lows.at(-2);
  if (!latestSwingHigh || !previousSwingHigh || !latestSwingLow || !previousSwingLow) return { direction: "UNCLEAR", latestSwingHigh, previousSwingHigh, latestSwingLow, previousSwingLow, evaluatedAt, reasonCode: "INSUFFICIENT_SWINGS" };
  const bullish = latestSwingHigh.price > previousSwingHigh.price && latestSwingLow.price > previousSwingLow.price;
  const bearish = latestSwingHigh.price < previousSwingHigh.price && latestSwingLow.price < previousSwingLow.price;
  if (bullish) return { direction: "BULLISH", latestSwingHigh, previousSwingHigh, latestSwingLow, previousSwingLow, evaluatedAt, reasonCode: "HH_HL" };
  if (bearish) return { direction: "BEARISH", latestSwingHigh, previousSwingHigh, latestSwingLow, previousSwingLow, evaluatedAt, reasonCode: "LH_LL" };
  return { direction: "UNCLEAR", latestSwingHigh, previousSwingHigh, latestSwingLow, previousSwingLow, evaluatedAt, reasonCode: "MIXED_STRUCTURE" };
}
