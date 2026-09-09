/**
 * Stage 31 — deterministic M15 BOS engine.
 *
 * A BOS is confirmation, not an entry by itself.
 *
 * BUY:
 *   1. Valid reaction has already been confirmed.
 *   2. Select a confirmed M15 swing-high reference according to a
 *      declared reference method.
 *   3. A COMPLETED M15 candle closes strictly above that reference.
 *
 * SELL is mirrored.
 *
 * Candidate reference methods:
 *   B1_LAST_CONFIRMED_COUNTER_SWING
 *   B2_LATEST_CONFIRMED_SWING_BEFORE_REACTION
 *   B3_PULLBACK_SEQUENCE_HIGH_LOW
 *
 * B3 requires an explicit sequence supplied by the caller; the engine
 * does not infer subjective structure.
 */

function validateDirection(direction) {
  if (direction !== "BUY" && direction !== "SELL") {
    throw new Error("BOS direction must be BUY or SELL.");
  }
}

function referenceType(direction) {
  return direction === "BUY" ? "HIGH" : "LOW";
}

function sortSwings(swings) {
  return [...swings].sort((a, b) => {
    if (a.confirmationIndex !== b.confirmationIndex) {
      return a.confirmationIndex - b.confirmationIndex;
    }
    return a.candleIndex - b.candleIndex;
  });
}

function confirmedEligibleSwings(swings, type, maxConfirmationIndex) {
  return sortSwings(swings).filter(
    (s) =>
      s.timeframe === "M15" &&
      s.type === type &&
      s.confirmed === true &&
      s.confirmationIndex <= maxConfirmationIndex
  );
}

export function selectBosReference({
  method,
  direction,
  m15Swings,
  reactionConfirmationIndex,
  pullbackReferenceSwing = null
}) {
  validateDirection(direction);

  if (!Number.isInteger(reactionConfirmationIndex)) {
    throw new Error("reactionConfirmationIndex must be an integer.");
  }

  const type = referenceType(direction);
  const eligible = confirmedEligibleSwings(
    m15Swings,
    type,
    reactionConfirmationIndex
  );

  if (method === "B1_LAST_CONFIRMED_COUNTER_SWING") {
    const reference = eligible.at(-1) ?? null;
    return {
      valid: reference !== null,
      method,
      direction,
      reference
    };
  }

  if (method === "B2_LATEST_CONFIRMED_SWING_BEFORE_REACTION") {
    const reference = eligible.at(-1) ?? null;
    return {
      valid: reference !== null,
      method,
      direction,
      reference
    };
  }

  if (method === "B3_PULLBACK_SEQUENCE_HIGH_LOW") {
    if (!pullbackReferenceSwing) {
      return {
        valid: false,
        method,
        direction,
        reference: null
      };
    }

    if (
      pullbackReferenceSwing.type !== type ||
      pullbackReferenceSwing.timeframe !== "M15" ||
      pullbackReferenceSwing.confirmationIndex > reactionConfirmationIndex
    ) {
      return {
        valid: false,
        method,
        direction,
        reference: null
      };
    }

    return {
      valid: true,
      method,
      direction,
      reference: pullbackReferenceSwing
    };
  }

  throw new Error(`Unsupported BOS reference method: ${method}`);
}

export function evaluateBos({
  direction,
  reference,
  candles,
  startIndex,
  currentIndex
}) {
  validateDirection(direction);

  if (!reference) {
    return {
      state: "NOT_CONFIRMED",
      reason: "BOS_REFERENCE_INVALID",
      confirmationIndex: null,
      confirmationTimestamp: null,
      reference: null
    };
  }

  if (!Array.isArray(candles)) {
    throw new Error("candles must be an array.");
  }

  if (!Number.isInteger(startIndex) || !Number.isInteger(currentIndex)) {
    throw new Error("startIndex/currentIndex must be integers.");
  }

  if (currentIndex < startIndex) {
    throw new Error("currentIndex must be >= startIndex.");
  }

  for (let i = startIndex; i <= currentIndex; i++) {
    const candle = candles[i];
    if (!candle || candle.isComplete === false) continue;

    const closeBreak =
      direction === "BUY"
        ? candle.close > reference.price
        : candle.close < reference.price;

    if (closeBreak) {
      return {
        state: "CONFIRMED",
        reason: "BOS_CONFIRMED",
        confirmationIndex: i,
        confirmationTimestamp: candle.timestampClose,
        reference
      };
    }
  }

  return {
    state: "NOT_CONFIRMED",
    reason: "BOS_NOT_CONFIRMED",
    confirmationIndex: null,
    confirmationTimestamp: null,
    reference
  };
}

export function evaluateBosCandidates({
  direction,
  methods,
  m15Swings,
  reactionConfirmationIndex,
  candles,
  startIndex,
  currentIndex,
  pullbackReferenceSwing = null
}) {
  validateDirection(direction);

  const results = [];

  for (const method of methods) {
    const selected = selectBosReference({
      method,
      direction,
      m15Swings,
      reactionConfirmationIndex,
      pullbackReferenceSwing
    });

    const bos = evaluateBos({
      direction,
      reference: selected.reference,
      candles,
      startIndex,
      currentIndex
    });

    results.push({
      ...bos,
      method,
      referenceSelectionValid: selected.valid
    });
  }

  return results;
}
