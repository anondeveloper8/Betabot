/**
 * Stage 29 — deterministic M15 pullback engine.
 *
 * This stage deliberately implements a conservative structural pullback
 * candidate rather than claiming one candidate is empirically optimal.
 *
 * P3 candidate:
 *   After a directional impulse away from the H4 zone, price must print
 *   at least one confirmed counter-direction M15 swing.
 *
 * No subjective "deep", "healthy", or "strong" language is used by the engine.
 */

function latestConfirmedSwing(swings, type, beforeIndex = Infinity) {
  const matches = swings
    .filter(
      (s) =>
        s.timeframe === "M15" &&
        s.type === type &&
        s.confirmationIndex <= beforeIndex
    )
    .sort((a, b) => a.confirmationIndex - b.confirmationIndex);

  return matches.at(-1) ?? null;
}

export function evaluateStructuralPullback({
  direction,
  currentIndex,
  m15Swings,
  zoneInteractionIndex,
  reactionStartIndex = zoneInteractionIndex
}) {
  if (!["BUY", "SELL"].includes(direction)) {
    throw new Error("Pullback direction must be BUY or SELL.");
  }

  if (!Number.isInteger(currentIndex) || currentIndex < 0) {
    throw new Error("currentIndex must be a non-negative integer.");
  }

  if (!Number.isInteger(zoneInteractionIndex) || zoneInteractionIndex < 0) {
    throw new Error("zoneInteractionIndex must be a non-negative integer.");
  }

  const counterType = direction === "BUY" ? "LOW" : "HIGH";

  const candidates = m15Swings
    .filter(
      (s) =>
        s.timeframe === "M15" &&
        s.type === counterType &&
        s.candleIndex >= reactionStartIndex &&
        s.confirmationIndex <= currentIndex
    )
    .sort((a, b) => a.confirmationIndex - b.confirmationIndex);

  const swing = candidates.at(-1);

  if (!swing) {
    return {
      state: "NOT_CONFIRMED",
      method: "P3_CONFIRMED_COUNTER_SWING",
      direction,
      referenceSwing: null
    };
  }

  return {
    state: "CONFIRMED",
    method: "P3_CONFIRMED_COUNTER_SWING",
    direction,
    referenceSwing: swing,
    confirmationIndex: swing.confirmationIndex,
    depthReference: swing.price
  };
}
