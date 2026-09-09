/**
 * Stage 32 — deterministic M15 entry + initial stop-loss engine.
 *
 * Historical/backtest model only. This module does not place live orders.
 *
 * Entry model:
 *   - Signal = a COMPLETED M15 BOS confirmation candle.
 *   - Execution = next M15 candle open.
 *   - Adverse transaction cost = half-spread + slippage, applied in the
 *     direction that makes entry less favorable.
 *   - Entry is rejected when the next candle is unavailable/incomplete.
 *
 * Anti-chase:
 *   extension = distance from the broken BOS reference to the modeled entry.
 *   normalizedExtension = extension / ATR(M15) at the BOS confirmation candle.
 *   The configured maximum is a RESEARCH PARAMETER, not a proven optimum.
 *
 * Initial stop:
 *   BUY  structural = MIN(reaction swing low, H4 demand low)
 *   SELL structural = MAX(reaction swing high, H4 supply high)
 *   stop = structural +/- configured buffer
 *
 * The stop is NEVER tightened merely to satisfy a later risk constraint.
 */

import { calculateWilderATR } from "../../engine/atr.js";

export const DEFAULT_ENTRY_STOP_CONFIG = Object.freeze({
  // Research candidates. These must be evaluated historically later.
  maxExtensionAtr: 0.25,
  slBufferAtr: 0.25,
  atrPeriod: 14,
  spreadPriceTicks: 0n,
  slippagePriceTicks: 0n,
  requireNextCandleComplete: true
});

function assertDirection(direction) {
  if (direction !== "BUY" && direction !== "SELL") {
    throw new Error("Direction must be BUY or SELL.");
  }
}

function assertBigIntPrice(name, value) {
  if (typeof value !== "bigint") {
    throw new Error(`${name} must be a BigInt fixed-point price.`);
  }
}

function assertNonNegativeBigInt(name, value) {
  assertBigIntPrice(name, value);
  if (value < 0n) throw new Error(`${name} must be >= 0.`);
}

function assertFiniteNonNegative(name, value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number.`);
  }
}

export function modelNextOpenEntry({
  direction,
  candles,
  confirmationIndex,
  spreadPriceTicks = 0n,
  slippagePriceTicks = 0n,
  requireNextCandleComplete = true
}) {
  assertDirection(direction);

  if (!Array.isArray(candles)) throw new Error("candles must be an array.");
  if (!Number.isInteger(confirmationIndex) || confirmationIndex < 0) {
    throw new Error("confirmationIndex must be a non-negative integer.");
  }
  assertNonNegativeBigInt("spreadPriceTicks", spreadPriceTicks);
  assertNonNegativeBigInt("slippagePriceTicks", slippagePriceTicks);

  const signalCandle = candles[confirmationIndex];
  const executionIndex = confirmationIndex + 1;
  const executionCandle = candles[executionIndex];

  if (!signalCandle || signalCandle.isComplete === false) {
    return {
      valid: false,
      reason: "BOS_CONFIRMATION_CANDLE_INVALID",
      confirmationIndex,
      executionIndex,
      entryPrice: null,
      signalTimestamp: signalCandle?.timestampClose ?? null,
      executionTimestamp: executionCandle?.timestampOpen ?? null
    };
  }

  if (!executionCandle) {
    return {
      valid: false,
      reason: "UNTESTABLE_PERIOD",
      confirmationIndex,
      executionIndex,
      entryPrice: null,
      signalTimestamp: signalCandle.timestampClose,
      executionTimestamp: null
    };
  }

  if (requireNextCandleComplete && executionCandle.isComplete === false) {
    return {
      valid: false,
      reason: "UNTESTABLE_PERIOD",
      confirmationIndex,
      executionIndex,
      entryPrice: null,
      signalTimestamp: signalCandle.timestampClose,
      executionTimestamp: executionCandle.timestampOpen
    };
  }

  assertBigIntPrice("executionCandle.open", executionCandle.open);

  // spreadPriceTicks is the full bid/ask spread expressed in fixed-point
  // price ticks. A split is only exact when the spread is even. We reject an
  // odd spread instead of silently rounding a price by one tick.
  if (spreadPriceTicks % 2n !== 0n) {
    return {
      valid: false,
      reason: "DATA_INVALID",
      detail: "spreadPriceTicks must be even when modeling half-spread entry cost.",
      confirmationIndex,
      executionIndex,
      entryPrice: null,
      signalTimestamp: signalCandle.timestampClose,
      executionTimestamp: executionCandle.timestampOpen
    };
  }

  const halfSpread = spreadPriceTicks / 2n;
  const adverseCost = halfSpread + slippagePriceTicks;
  const entryPrice = direction === "BUY"
    ? executionCandle.open + adverseCost
    : executionCandle.open - adverseCost;

  return {
    valid: true,
    reason: "ENTRY_MODELED",
    confirmationIndex,
    executionIndex,
    signalTimestamp: signalCandle.timestampClose,
    executionTimestamp: executionCandle.timestampOpen,
    rawOpen: executionCandle.open,
    spreadPriceTicks,
    slippagePriceTicks,
    adverseCostPriceTicks: adverseCost,
    entryPrice
  };
}

export function calculateAntiChase({
  direction,
  entryPrice,
  brokenReferencePrice,
  atrPriceUnits,
  maxExtensionAtr
}) {
  assertDirection(direction);
  assertBigIntPrice("entryPrice", entryPrice);
  assertBigIntPrice("brokenReferencePrice", brokenReferencePrice);
  if (!Number.isFinite(atrPriceUnits) || atrPriceUnits <= 0) {
    throw new Error("atrPriceUnits must be > 0.");
  }
  assertFiniteNonNegative("maxExtensionAtr", maxExtensionAtr);

  const extensionPriceTicks = direction === "BUY"
    ? entryPrice - brokenReferencePrice
    : brokenReferencePrice - entryPrice;

  // Negative extension means execution is on the pre-break side. We keep it
  // explicit rather than clamping, because this is useful for auditing gaps.
  const normalizedExtension = Number(extensionPriceTicks) / atrPriceUnits;
  const pass = extensionPriceTicks >= 0n && normalizedExtension <= maxExtensionAtr;

  return {
    extensionPriceTicks,
    normalizedExtension,
    maxExtensionAtr,
    pass,
    reason: pass ? "ENTRY_EXTENSION_ACCEPTABLE" : "ENTRY_TOO_EXTENDED"
  };
}

export function calculateAtrBuffer(candles, index, atrPeriod, multiplier) {
  assertFiniteNonNegative("multiplier", multiplier);
  if (!Number.isInteger(atrPeriod) || atrPeriod <= 0) {
    throw new Error("atrPeriod must be a positive integer.");
  }
  const atr = calculateWilderATR(candles, atrPeriod, index);
  if (!atr || !(atr.valueInPriceUnits > 0)) {
    return {
      valid: false,
      reason: "DATA_INVALID",
      bufferPriceTicks: null,
      atrPriceUnits: null
    };
  }

  const raw = atr.valueInPriceUnits * multiplier;
  const bufferPriceTicks = BigInt(Math.ceil(raw));

  return {
    valid: true,
    reason: "ATR_BUFFER_CALCULATED",
    bufferPriceTicks,
    atrPriceUnits: atr.valueInPriceUnits,
    multiplier
  };
}

export function calculateStructuralStop({
  direction,
  reactionSwing,
  zone,
  bufferPriceTicks
}) {
  assertDirection(direction);
  if (!reactionSwing) throw new Error("reactionSwing is required.");
  if (!zone) throw new Error("zone is required.");
  assertNonNegativeBigInt("bufferPriceTicks", bufferPriceTicks);

  assertBigIntPrice("reactionSwing.price", reactionSwing.price);
  assertBigIntPrice("zone.zoneLow", zone.zoneLow);
  assertBigIntPrice("zone.zoneHigh", zone.zoneHigh);

  if (direction === "BUY") {
    if (reactionSwing.type !== "LOW" || zone.type !== "DEMAND") {
      return { valid: false, reason: "DATA_INVALID" };
    }
    const structuralPrice = reactionSwing.price < zone.zoneLow
      ? reactionSwing.price
      : zone.zoneLow;
    const stopPrice = structuralPrice - bufferPriceTicks;
    return {
      valid: true,
      direction,
      structuralPrice,
      stopPrice,
      bufferPriceTicks,
      reactionSwingPrice: reactionSwing.price,
      zoneBoundary: zone.zoneLow
    };
  }

  if (reactionSwing.type !== "HIGH" || zone.type !== "SUPPLY") {
    return { valid: false, reason: "DATA_INVALID" };
  }
  const structuralPrice = reactionSwing.price > zone.zoneHigh
    ? reactionSwing.price
    : zone.zoneHigh;
  const stopPrice = structuralPrice + bufferPriceTicks;
  return {
    valid: true,
    direction,
    structuralPrice,
    stopPrice,
    bufferPriceTicks,
    reactionSwingPrice: reactionSwing.price,
    zoneBoundary: zone.zoneHigh
  };
}

export function validateInitialStop({
  direction,
  entryPrice,
  stopPrice,
  reactionSwing,
  zone
}) {
  assertDirection(direction);
  assertBigIntPrice("entryPrice", entryPrice);
  assertBigIntPrice("stopPrice", stopPrice);

  const stopSidePass = direction === "BUY"
    ? stopPrice < entryPrice
    : stopPrice > entryPrice;

  const zoneProtectionPass = direction === "BUY"
    ? stopPrice < zone.zoneLow
    : stopPrice > zone.zoneHigh;

  const reactionProtectionPass = direction === "BUY"
    ? stopPrice < reactionSwing.price
    : stopPrice > reactionSwing.price;

  const reasons = [];
  if (!stopSidePass) reasons.push("INVALID_STOP");
  if (!zoneProtectionPass) reasons.push("INVALID_STOP_ZONE_PROTECTION");
  if (!reactionProtectionPass) reasons.push("INVALID_STOP_REACTION_PROTECTION");

  return {
    valid: reasons.length === 0,
    reason: reasons.length === 0 ? "STOP_VALID" : "INVALID_STOP",
    reasons,
    stopSidePass,
    zoneProtectionPass,
    reactionProtectionPass
  };
}

export function buildEntryStopDecision({
  direction,
  bos,
  candles,
  brokenReferencePrice,
  reactionSwing,
  zone,
  config = DEFAULT_ENTRY_STOP_CONFIG
}) {
  assertDirection(direction);
  if (!bos || bos.state !== "CONFIRMED") {
    return { decision: "NO_TRADE", reasons: ["BOS_NOT_CONFIRMED"] };
  }

  const entry = modelNextOpenEntry({
    direction,
    candles,
    confirmationIndex: bos.confirmationIndex,
    spreadPriceTicks: config.spreadPriceTicks,
    slippagePriceTicks: config.slippagePriceTicks,
    requireNextCandleComplete: config.requireNextCandleComplete
  });

  if (!entry.valid) {
    return {
      decision: "NO_TRADE",
      reasons: [entry.reason],
      entry
    };
  }

  const atr = calculateWilderATR(candles, bos.confirmationIndex, config.atrPeriod);
  if (!atr || !(atr.valueInPriceUnits > 0)) {
    return {
      decision: "NO_TRADE",
      reasons: ["DATA_INVALID"],
      entry
    };
  }

  const antiChase = calculateAntiChase({
    direction,
    entryPrice: entry.entryPrice,
    brokenReferencePrice,
    atrPriceUnits: atr.valueInPriceUnits,
    maxExtensionAtr: config.maxExtensionAtr
  });

  if (!antiChase.pass) {
    return {
      decision: "NO_TRADE",
      reasons: ["ENTRY_TOO_EXTENDED"],
      entry,
      antiChase,
      atrPriceUnits: atr.valueInPriceUnits
    };
  }

  const buffer = calculateAtrBuffer(
    candles,
    bos.confirmationIndex,
    config.atrPeriod,
    config.slBufferAtr
  );
  if (!buffer.valid) {
    return {
      decision: "NO_TRADE",
      reasons: ["DATA_INVALID"],
      entry,
      antiChase,
      buffer,
      atrPriceUnits: atr.valueInPriceUnits
    };
  }

  const stop = calculateStructuralStop({
    direction,
    reactionSwing,
    zone,
    bufferPriceTicks: buffer.bufferPriceTicks
  });

  if (!stop.valid) {
    return { decision: "NO_TRADE", reasons: ["DATA_INVALID"], entry, antiChase, buffer, stop };
  }

  const stopValidation = validateInitialStop({
    direction,
    entryPrice: entry.entryPrice,
    stopPrice: stop.stopPrice,
    reactionSwing,
    zone
  });

  if (!stopValidation.valid) {
    return {
      decision: "NO_TRADE",
      reasons: stopValidation.reasons,
      entry,
      antiChase,
      buffer,
      stop,
      stopValidation
    };
  }

  return {
    decision: "TRADE_VALIDATION",
    reasons: [],
    entry,
    antiChase,
    buffer,
    stop,
    stopValidation,
    atrPriceUnits: atr.valueInPriceUnits
  };
}
