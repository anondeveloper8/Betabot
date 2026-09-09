/**
 * Stage 29 — H4 location engine.
 *
 * Location is an observation, not a trade signal.
 * A candle is considered "at" a zone when its range overlaps the zone.
 */

export function candleOverlapsZone(candle, zone) {
  if (!candle || !zone) {
    throw new TypeError("candle and zone are required.");
  }

  return (
    candle.high >= zone.zoneLow &&
    candle.low <= zone.zoneHigh
  );
}

export function evaluateH4Location({
  candle,
  zones,
  direction = null,
  allowTouched = true
}) {
  if (!candle || candle.timeframe !== "H4") {
    throw new Error("H4 location requires an H4 candle.");
  }

  const eligible = zones.filter((zone) => {
    if (!["VALID", "TOUCHED"].includes(zone.status)) return false;
    if (!allowTouched && zone.status === "TOUCHED") return false;
    if (!candleOverlapsZone(candle, zone)) return false;

    if (direction === "BUY") return zone.type === "DEMAND";
    if (direction === "SELL") return zone.type === "SUPPLY";
    return true;
  });

  return {
    atZone: eligible.length > 0,
    zoneIds: eligible.map((z) => z.id),
    zones: eligible
  };
}
