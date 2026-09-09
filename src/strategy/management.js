/**
 * Stage 35 — deterministic post-entry trade management.
 *
 * Historical/backtest model only. No live order execution.
 *
 * Core contract:
 *   - Original entry + original SL define 1R forever.
 *   - A management signal is evaluated only after its candle closes.
 *   - A newly proposed SL becomes active from the NEXT candle.
 *   - SL may move only in the protective direction:
 *       BUY  -> new SL >= old SL
 *       SELL -> new SL <= old SL
 *   - Initial risk can never be widened.
 *
 * Variants:
 *   M0 = no management
 *   M1 = move to break-even at +1R
 *   M2 = move to break-even + configurable R-buffer at +1R
 *   M3 = deterministic profit ladder
 *   M4 = structure trail after +1R using a supplied confirmed M15 structure price
 *
 * The engine does not infer "strong", "profit-taking", "exhaustion", etc.
 * All management triggers and distances are explicit numeric parameters.
 */

export const MANAGEMENT_VARIANTS = Object.freeze([
  "M0_NO_MANAGEMENT",
  "M1_BREAK_EVEN",
  "M2_BREAK_EVEN_BUFFER",
  "M3_PROFIT_LADDER",
  "M4_STRUCTURE_TRAIL"
]);

export const DEFAULT_MANAGEMENT_CONFIG = Object.freeze({
  triggerR: 1.0,
  breakEvenBufferR: 0.10,
  ladder: Object.freeze([
    Object.freeze({ triggerR: 1.0, lockR: 0.25 }),
    Object.freeze({ triggerR: 2.0, lockR: 1.0 }),
    Object.freeze({ triggerR: 3.0, lockR: 2.0 })
  ]),
  structureTrailTriggerR: 1.0
});

function assertDirection(direction) {
  if (direction !== "BUY" && direction !== "SELL") throw new Error("Direction must be BUY or SELL.");
}

function assertBigIntPrice(name, value) {
  if (typeof value !== "bigint") throw new Error(`${name} must be a BigInt fixed-point price.`);
}

function assertFinitePositive(name, value) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be > 0.`);
}

function assertFiniteNonNegative(name, value) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be >= 0.`);
}

function assertVariant(variant) {
  if (!MANAGEMENT_VARIANTS.includes(variant)) throw new Error(`Unknown management variant: ${variant}`);
}

/** Frozen original 1R distance. */
export function calculateOriginalRiskR({ direction, entryPrice, initialStopPrice }) {
  assertDirection(direction);
  assertBigIntPrice("entryPrice", entryPrice);
  assertBigIntPrice("initialStopPrice", initialStopPrice);
  const riskTicks = direction === "BUY" ? entryPrice - initialStopPrice : initialStopPrice - entryPrice;
  if (riskTicks <= 0n) {
    return { valid: false, riskTicks, reason: "INVALID_STOP" };
  }
  return { valid: true, riskTicks, reason: "ORIGINAL_RISK_FROZEN" };
}

/** Favorable excursion from entry, measured with the completed candle's extreme. */
export function calculateFavorableExcursion({ direction, entryPrice, candle }) {
  assertDirection(direction);
  assertBigIntPrice("entryPrice", entryPrice);
  if (!candle) throw new Error("candle is required.");
  assertBigIntPrice("candle.high", candle.high);
  assertBigIntPrice("candle.low", candle.low);

  const favorableTicks = direction === "BUY"
    ? candle.high - entryPrice
    : entryPrice - candle.low;

  return {
    favorableTicks,
    favorableR: favorableTicks > 0n ? favorableTicks : 0n,
    candleTimestampOpen: candle.timestampOpen ?? null,
    candleTimestampClose: candle.timestampClose ?? null
  };
}

function rDistanceToTicks(rValue, riskTicks) {
  assertFiniteNonNegative("rValue", rValue);
  assertBigIntPrice("riskTicks", riskTicks);
  if (riskTicks <= 0n) throw new Error("riskTicks must be > 0.");
  return BigInt(Math.ceil(rValue * Number(riskTicks)));
}

function tickR(favorableTicks, riskTicks) {
  if (riskTicks <= 0n) return null;
  return Number(favorableTicks) / Number(riskTicks);
}

/**
 * Determine whether a trigger completed on the signal candle.
 * The resulting SL proposal becomes active on the NEXT candle.
 */
export function evaluateManagementTrigger({
  variant,
  direction,
  entryPrice,
  initialStopPrice,
  currentStopPrice,
  signalCandle,
  config = DEFAULT_MANAGEMENT_CONFIG,
  structureStopPrice = null
}) {
  assertVariant(variant);
  assertDirection(direction);
  assertBigIntPrice("entryPrice", entryPrice);
  assertBigIntPrice("initialStopPrice", initialStopPrice);
  assertBigIntPrice("currentStopPrice", currentStopPrice);
  if (!signalCandle) throw new Error("signalCandle is required.");

  const risk = calculateOriginalRiskR({ direction, entryPrice, initialStopPrice });
  if (!risk.valid) return { valid: false, reason: "INVALID_STOP", signalCandle };

  if (variant === "M0_NO_MANAGEMENT") {
    return {
      valid: true,
      triggered: false,
      reason: "NO_MANAGEMENT",
      variant,
      signalCandle,
      favorableR: null,
      proposedStopPrice: currentStopPrice,
      activeFromTimestamp: signalCandle.timestampClose ?? null
    };
  }

  const excursion = calculateFavorableExcursion({ direction, entryPrice, candle: signalCandle });
  const favorableR = tickR(excursion.favorableTicks, risk.riskTicks);

  if (variant === "M1_BREAK_EVEN") {
    if (favorableR < config.triggerR) {
      return baseNoTrigger(variant, signalCandle, favorableR, currentStopPrice, config.triggerR);
    }
    return proposeProtectiveStop({
      variant, direction, entryPrice, initialStopPrice, currentStopPrice,
      proposedStopPrice: entryPrice,
      signalCandle, favorableR, triggerR: config.triggerR,
      trigger: "BREAK_EVEN_TRIGGERED"
    });
  }

  if (variant === "M2_BREAK_EVEN_BUFFER") {
    assertFiniteNonNegative("breakEvenBufferR", config.breakEvenBufferR);
    if (favorableR < config.triggerR) {
      return baseNoTrigger(variant, signalCandle, favorableR, currentStopPrice, config.triggerR);
    }
    const bufferTicks = rDistanceToTicks(config.breakEvenBufferR, risk.riskTicks);
    const proposed = direction === "BUY" ? entryPrice + bufferTicks : entryPrice - bufferTicks;
    return proposeProtectiveStop({
      variant, direction, entryPrice, initialStopPrice, currentStopPrice,
      proposedStopPrice: proposed,
      signalCandle, favorableR, triggerR: config.triggerR,
      trigger: "BREAK_EVEN_BUFFER_TRIGGERED",
      bufferTicks
    });
  }

  if (variant === "M3_PROFIT_LADDER") {
    if (!Array.isArray(config.ladder) || config.ladder.length === 0) throw new Error("config.ladder must be a non-empty array.");
    const validLevels = config.ladder.map((level) => {
      if (!level || !Number.isFinite(level.triggerR) || !Number.isFinite(level.lockR) || level.triggerR < 0 || level.lockR < 0) {
        throw new Error("Each ladder level requires non-negative finite triggerR and lockR.");
      }
      if (level.lockR > level.triggerR) throw new Error("ladder lockR cannot exceed triggerR.");
      return level;
    }).sort((a, b) => a.triggerR - b.triggerR);

    const eligible = validLevels.filter((level) => favorableR >= level.triggerR);
    if (eligible.length === 0) {
      return baseNoTrigger(variant, signalCandle, favorableR, currentStopPrice, validLevels[0].triggerR);
    }

    const level = eligible[eligible.length - 1];
    const lockTicks = rDistanceToTicks(level.lockR, risk.riskTicks);
    const proposed = direction === "BUY" ? entryPrice + lockTicks : entryPrice - lockTicks;

    return proposeProtectiveStop({
      variant, direction, entryPrice, initialStopPrice, currentStopPrice,
      proposedStopPrice: proposed, signalCandle, favorableR,
      triggerR: level.triggerR, trigger: "PROFIT_LADDER_TRIGGERED",
      ladderLevel: level
    });
  }

  if (variant === "M4_STRUCTURE_TRAIL") {
    assertFiniteNonNegative("structureTrailTriggerR", config.structureTrailTriggerR);
    if (favorableR < config.structureTrailTriggerR) {
      return baseNoTrigger(variant, signalCandle, favorableR, currentStopPrice, config.structureTrailTriggerR);
    }
    if (structureStopPrice === null) {
      return {
        valid: false,
        triggered: false,
        reason: "DATA_INVALID",
        variant,
        signalCandle,
        favorableR,
        proposedStopPrice: currentStopPrice,
        activeFromTimestamp: signalCandle.timestampClose ?? null
      };
    }
    assertBigIntPrice("structureStopPrice", structureStopPrice);
    return proposeProtectiveStop({
      variant, direction, entryPrice, initialStopPrice, currentStopPrice,
      proposedStopPrice: structureStopPrice, signalCandle, favorableR,
      triggerR: config.structureTrailTriggerR, trigger: "STRUCTURE_TRAIL_TRIGGERED"
    });
  }

  throw new Error(`Unhandled management variant: ${variant}`);
}

function baseNoTrigger(variant, signalCandle, favorableR, currentStopPrice, triggerR) {
  return {
    valid: true,
    triggered: false,
    reason: "TRIGGER_NOT_REACHED",
    variant,
    signalCandle,
    favorableR,
    triggerR,
    proposedStopPrice: currentStopPrice,
    activeFromTimestamp: signalCandle.timestampClose ?? null
  };
}

function proposeProtectiveStop({
  variant, direction, entryPrice, initialStopPrice, currentStopPrice,
  proposedStopPrice, signalCandle, favorableR, triggerR, trigger, ...extra
}) {
  const originalRisk = calculateOriginalRiskR({ direction, entryPrice, initialStopPrice });
  if (!originalRisk.valid) return { valid: false, reason: "INVALID_STOP", signalCandle };

  const protective = direction === "BUY"
    ? proposedStopPrice >= currentStopPrice
    : proposedStopPrice <= currentStopPrice;

  // The only hard management constraint here is monotonic protection.
  // Moving a stop farther into profit is permitted; moving it backward is not.

  if (!protective) {
    return {
      valid: true,
      triggered: true,
      applied: false,
      reason: "SL_NOT_IMPROVED",
      variant,
      signalCandle,
      favorableR,
      triggerR,
      proposedStopPrice,
      activeFromTimestamp: signalCandle.timestampClose ?? null,
      ...extra
    };
  }

  return {
    valid: true,
    triggered: true,
    applied: proposedStopPrice !== currentStopPrice,
    reason: proposedStopPrice === currentStopPrice ? "SL_UNCHANGED" : trigger,
    variant,
    signalCandle,
    favorableR,
    triggerR,
    oldStopPrice: currentStopPrice,
    proposedStopPrice,
    activeFromTimestamp: signalCandle.timestampClose ?? null,
    ...extra
  };
}

/** Apply a validated management proposal to the position state. */
export function applyManagementProposal({ direction, currentStopPrice, proposal }) {
  assertDirection(direction);
  assertBigIntPrice("currentStopPrice", currentStopPrice);
  if (!proposal || proposal.valid !== true) {
    return { applied: false, reason: proposal?.reason ?? "DATA_INVALID", stopPrice: currentStopPrice };
  }
  assertBigIntPrice("proposal.proposedStopPrice", proposal.proposedStopPrice);

  const improves = direction === "BUY"
    ? proposal.proposedStopPrice >= currentStopPrice
    : proposal.proposedStopPrice <= currentStopPrice;

  if (!improves) {
    return { applied: false, reason: "SL_NOT_IMPROVED", stopPrice: currentStopPrice };
  }

  return {
    applied: proposal.proposedStopPrice !== currentStopPrice,
    reason: proposal.proposedStopPrice === currentStopPrice ? "SL_UNCHANGED" : "SL_UPDATED",
    stopPrice: proposal.proposedStopPrice
  };
}

/**
 * Create a single auditable modification record.
 * The record is intentionally immutable and suitable for a trade ledger.
 */
export function createManagementAudit({
  setupId,
  direction,
  candle,
  oldStopPrice,
  newStopPrice,
  variant,
  trigger,
  favorableR
}) {
  if (setupId === undefined || setupId === null || setupId === "") throw new Error("setupId is required.");
  assertDirection(direction);
  assertBigIntPrice("oldStopPrice", oldStopPrice);
  assertBigIntPrice("newStopPrice", newStopPrice);
  if (!candle) throw new Error("candle is required.");
  assertVariant(variant);
  if (!Number.isFinite(favorableR) || favorableR < 0) throw new Error("favorableR must be >= 0.");

  const protective = direction === "BUY" ? newStopPrice >= oldStopPrice : newStopPrice <= oldStopPrice;
  if (!protective) throw new Error("Management audit cannot record a non-protective SL change.");

  return Object.freeze({
    setupId,
    timestamp: candle.timestampClose ?? null,
    direction,
    oldStopPrice,
    newStopPrice,
    variant,
    trigger,
    favorableR,
    activeFromTimestamp: candle.timestampClose ?? null
  });
}

/**
 * Historical candle exit priority helper.
 * When both a stop and target are touched in the SAME candle and the intrabar
 * order cannot be known, the strategy uses the less favorable outcome: SL.
 */
export function resolveSameCandleExit({ direction, candle, stopPrice, targetPrice }) {
  assertDirection(direction);
  if (!candle) throw new Error("candle is required.");
  assertBigIntPrice("stopPrice", stopPrice);
  assertBigIntPrice("targetPrice", targetPrice);
  assertBigIntPrice("candle.high", candle.high);
  assertBigIntPrice("candle.low", candle.low);

  const stopTouched = direction === "BUY" ? candle.low <= stopPrice : candle.high >= stopPrice;
  const targetTouched = direction === "BUY" ? candle.high >= targetPrice : candle.low <= targetPrice;

  if (stopTouched && targetTouched) return { outcome: "SL", stopTouched: true, targetTouched: true, reason: "SAME_CANDLE_SL_PRIORITY" };
  if (stopTouched) return { outcome: "SL", stopTouched: true, targetTouched: false, reason: "STOP_TOUCHED" };
  if (targetTouched) return { outcome: "TP", stopTouched: false, targetTouched: true, reason: "TARGET_TOUCHED" };
  return { outcome: null, stopTouched: false, targetTouched: false, reason: "NO_EXIT" };
}
