/**
 * Stage 30 — deterministic reaction engine.
 *
 * Design:
 *   Zone interaction is only a prerequisite.
 *   Reaction is evidence that price has moved away from the zone.
 *   Reaction does NOT equal BOS and does NOT equal a trade signal.
 *
 * R3 candidate used as the default research implementation:
 *   1. The post-interaction candle must move in the expected direction
 *      by at least `minDisplacement` price units from its open.
 *   2. Its close must recover to the expected side of the zone midpoint.
 *
 * The threshold is intentionally configurable and must be tested historically.
 */

function assertDirection(direction) {
  if (direction !== "BUY" && direction !== "SELL") {
    throw new Error("Reaction direction must be BUY or SELL.");
  }
}

function zoneMidpoint(zone) {
  return (zone.zoneHigh + zone.zoneLow) / 2n;
}

function directionalDisplacement(candle, direction) {
  return direction === "BUY"
    ? candle.close - candle.open
    : candle.open - candle.close;
}

export function evaluateReactionR3({
  direction,
  zone,
  zoneInteractionIndex,
  candles,
  currentIndex,
  minDisplacement,
  startIndex = zoneInteractionIndex
}) {
  assertDirection(direction);

  if (!zone) throw new Error("Reaction requires a zone.");
  if (!Array.isArray(candles)) throw new Error("candles must be an array.");
  if (!Number.isInteger(zoneInteractionIndex) || zoneInteractionIndex < 0) {
    throw new Error("zoneInteractionIndex must be a non-negative integer.");
  }
  if (!Number.isInteger(currentIndex) || currentIndex < zoneInteractionIndex) {
    throw new Error("currentIndex must be >= zoneInteractionIndex.");
  }
  if (!Number.isFinite(minDisplacement) || minDisplacement < 0) {
    throw new Error("minDisplacement must be a non-negative finite number.");
  }

  const midpoint = zoneMidpoint(zone);
  const scanStartIndex = Math.max(zoneInteractionIndex, Number.isInteger(startIndex) ? startIndex : zoneInteractionIndex);

  // We deliberately evaluate completed candles only.
  for (let i = scanStartIndex; i <= currentIndex; i++) {
    const candle = candles[i];
    if (!candle || candle.isComplete === false) continue;

    const displacement = directionalDisplacement(candle, direction);
    const displacementPass = displacement >= minDisplacement;

    const recoveryPass =
      direction === "BUY"
        ? candle.close >= midpoint
        : candle.close <= midpoint;

    if (displacementPass && recoveryPass) {
      return {
        state: "CONFIRMED",
        method: "R3_DISPLACEMENT_PLUS_MIDPOINT_RECOVERY",
        direction,
        zoneId: zone.id,
        confirmationIndex: i,
        confirmationTimestamp: candle.timestampClose,
        displacement,
        recoveryLevel: midpoint
      };
    }
  }

  return {
    state: "NOT_CONFIRMED",
    method: "R3_DISPLACEMENT_PLUS_MIDPOINT_RECOVERY",
    direction,
    zoneId: zone.id,
    confirmationIndex: null,
    confirmationTimestamp: null,
    displacement: null,
    recoveryLevel: midpoint
  };
}

/**
 * Deterministic helper for research candidates:
 * R1 = close recovery only
 * R2 = directional displacement only
 * R3 = displacement + midpoint recovery
 * R4 = structure-aware reaction (requires external structure inputs)
 *
 * R1/R2 are intentionally explicit so the experiment engine can compare them.
 */
export function evaluateReactionCandidate({
  method,
  direction,
  zone,
  zoneInteractionIndex,
  candles,
  currentIndex,
  minDisplacement = 0,
  startIndex = zoneInteractionIndex
}) {
  assertDirection(direction);

  if (!zone) throw new Error("Reaction requires a zone.");

  if (method === "R1_CLOSE_RECOVERY") {
    const midpoint = zoneMidpoint(zone);

    for (let i = Math.max(zoneInteractionIndex, Number.isInteger(startIndex) ? startIndex : zoneInteractionIndex); i <= currentIndex; i++) {
      const candle = candles[i];
      if (!candle || candle.isComplete === false) continue;

      const pass =
        direction === "BUY"
          ? candle.close >= midpoint
          : candle.close <= midpoint;

      if (pass) {
        return {
          state: "CONFIRMED",
          method,
          direction,
          zoneId: zone.id,
          confirmationIndex: i,
          confirmationTimestamp: candle.timestampClose,
          displacement: directionalDisplacement(candle, direction),
          recoveryLevel: midpoint
        };
      }
    }

    return {
      state: "NOT_CONFIRMED",
      method,
      direction,
      zoneId: zone.id,
      confirmationIndex: null,
      confirmationTimestamp: null,
      displacement: null,
      recoveryLevel: midpoint
    };
  }

  if (method === "R2_DIRECTIONAL_DISPLACEMENT") {
    for (let i = Math.max(zoneInteractionIndex, Number.isInteger(startIndex) ? startIndex : zoneInteractionIndex); i <= currentIndex; i++) {
      const candle = candles[i];
      if (!candle || candle.isComplete === false) continue;

      const displacement = directionalDisplacement(candle, direction);

      if (displacement >= minDisplacement) {
        return {
          state: "CONFIRMED",
          method,
          direction,
          zoneId: zone.id,
          confirmationIndex: i,
          confirmationTimestamp: candle.timestampClose,
          displacement,
          recoveryLevel: null
        };
      }
    }

    return {
      state: "NOT_CONFIRMED",
      method,
      direction,
      zoneId: zone.id,
      confirmationIndex: null,
      confirmationTimestamp: null,
      displacement: null,
      recoveryLevel: null
    };
  }

  if (method === "R3_DISPLACEMENT_PLUS_MIDPOINT_RECOVERY") {
    return evaluateReactionR3({
      direction,
      zone,
      zoneInteractionIndex,
      candles,
      currentIndex,
      minDisplacement,
      startIndex
    });
  }

  throw new Error(`Unsupported reaction method: ${method}`);
}
