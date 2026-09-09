/**
 * Stage 33 — deterministic TP + R:R + position-size/risk gate.
 *
 * Historical/backtest model only. No live order execution.
 *
 * TP:
 *   BUY  = nearest valid H4 SUPPLY zone low strictly above entry.
 *   SELL = nearest valid H4 DEMAND zone high strictly below entry.
 *   TP is frozen at entry and is never moved merely to satisfy R:R.
 *
 * R:R:
 *   risk   = abs(entry - initial SL)
 *   reward = directional distance(entry, TP)
 *   RR     = reward / risk
 *   V1     = RR >= configured minimum (default 2.0).
 *
 * Position sizing:
 *   max risk money = equity × risk percent.
 *   unit risk money = stop distance in price units × money value per price unit
 *                     for one permitted unit + optional fixed per-unit cost.
 *   size = floor(max risk / unit risk) to the permitted size increment.
 *   Actual risk is recalculated after rounding down.
 *   If the minimum permitted size exceeds max risk, reject.
 *
 * IMPORTANT:
 *   `moneyPerPriceUnitPerUnit` must already represent the instrument/account-\n *   currency conversion for the permitted unit. The engine does not guess a\n *   pip value, contract size, or currency conversion.
 */

export const DEFAULT_TP_RISK_CONFIG = Object.freeze({
  minRR: 2.0,
  riskPercent: 1.0,
  sizeIncrement: 0.01,
  minSize: 0.01,
  moneyPrecision: 2,
  perUnitFixedCost: 0
});

function assertDirection(direction) {
  if (direction !== "BUY" && direction !== "SELL") {
    throw new Error("Direction must be BUY or SELL.");
  }
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

function isValidOpposingZone(direction, zone) {
  return direction === "BUY"
    ? zone?.type === "SUPPLY" && zone?.status !== "INVALIDATED"
    : zone?.type === "DEMAND" && zone?.status !== "INVALIDATED";
}

export function selectTakeProfitZone({ direction, entryPrice, zones }) {
  assertDirection(direction);
  assertBigIntPrice("entryPrice", entryPrice);
  if (!Array.isArray(zones)) throw new Error("zones must be an array.");

  const candidates = zones
    .filter((zone) => {
      if (!isValidOpposingZone(direction, zone)) return false;
      assertBigIntPrice("zone.zoneLow", zone.zoneLow);
      assertBigIntPrice("zone.zoneHigh", zone.zoneHigh);
      if (direction === "BUY") return zone.zoneLow > entryPrice;
      return zone.zoneHigh < entryPrice;
    })
    .sort((a, b) => {
      if (direction === "BUY") {
        return a.zoneLow < b.zoneLow ? -1 : a.zoneLow > b.zoneLow ? 1 : 0;
      }
      return a.zoneHigh > b.zoneHigh ? -1 : a.zoneHigh < b.zoneHigh ? 1 : 0;
    });

  const targetZone = candidates[0] ?? null;
  if (!targetZone) {
    return {
      valid: false,
      reason: "NO_TARGET_ZONE",
      targetZone: null,
      targetPrice: null,
      candidates: []
    };
  }

  const targetPrice = direction === "BUY" ? targetZone.zoneLow : targetZone.zoneHigh;
  return {
    valid: true,
    reason: "TARGET_ZONE_SELECTED",
    targetZone,
    targetPrice,
    candidates
  };
}

export function calculateRewardRisk({ direction, entryPrice, stopPrice, targetPrice, minRR = DEFAULT_TP_RISK_CONFIG.minRR }) {
  assertDirection(direction);
  assertBigIntPrice("entryPrice", entryPrice);
  assertBigIntPrice("stopPrice", stopPrice);
  assertBigIntPrice("targetPrice", targetPrice);
  assertFinitePositive("minRR", minRR);

  const riskTicks = direction === "BUY" ? entryPrice - stopPrice : stopPrice - entryPrice;
  const rewardTicks = direction === "BUY" ? targetPrice - entryPrice : entryPrice - targetPrice;
  const reasons = [];

  if (riskTicks <= 0n) reasons.push("INVALID_STOP");
  if (rewardTicks <= 0n) reasons.push("INVALID_TARGET_DIRECTION");

  const rr = riskTicks > 0n && rewardTicks > 0n
    ? Number(rewardTicks) / Number(riskTicks)
    : null;

  if (rr !== null && rr < minRR) reasons.push("RR_BELOW_MINIMUM");

  return {
    valid: reasons.length === 0,
    reason: reasons.length === 0 ? "RR_VALID" : reasons[0],
    reasons,
    riskPriceTicks: riskTicks,
    rewardPriceTicks: rewardTicks,
    rr,
    minRR
  };
}

export function calculateUnitRiskMoney({
  stopDistancePriceTicks,
  priceScale,
  moneyPerPriceUnitPerUnit,
  perUnitFixedCost = 0,
  moneyPrecision = 2
}) {
  if (typeof stopDistancePriceTicks !== "bigint" || stopDistancePriceTicks <= 0n) {
    throw new Error("stopDistancePriceTicks must be a positive BigInt.");
  }
  assertFinitePositive("priceScale", priceScale);
  assertFinitePositive("moneyPerPriceUnitPerUnit", moneyPerPriceUnitPerUnit);
  assertFiniteNonNegative("perUnitFixedCost", perUnitFixedCost);
  if (!Number.isInteger(moneyPrecision) || moneyPrecision < 0 || moneyPrecision > 8) {
    throw new Error("moneyPrecision must be an integer from 0 to 8.");
  }

  const stopDistancePriceUnits = Number(stopDistancePriceTicks) / priceScale;
  const variableRisk = stopDistancePriceUnits * moneyPerPriceUnitPerUnit;
  const unitRiskMoney = variableRisk + perUnitFixedCost;
  const factor = 10 ** moneyPrecision;
  const roundedUnitRiskMoney = Math.round(unitRiskMoney * factor) / factor;

  return {
    valid: Number.isFinite(roundedUnitRiskMoney) && roundedUnitRiskMoney > 0,
    stopDistancePriceUnits,
    variableRiskMoney: variableRisk,
    perUnitFixedCost,
    unitRiskMoney: roundedUnitRiskMoney
  };
}

function floorToIncrement(value, increment) {
  const quotient = Math.floor(value / increment + Number.EPSILON);
  return quotient * increment;
}

function roundMoney(value, precision) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

export function calculatePositionSize({
  equity,
  riskPercent,
  unitRiskMoney,
  sizeIncrement,
  minSize,
  moneyPrecision = 2
}) {
  assertFinitePositive("equity", equity);
  assertFinitePositive("riskPercent", riskPercent);
  assertFinitePositive("unitRiskMoney", unitRiskMoney);
  assertFinitePositive("sizeIncrement", sizeIncrement);
  assertFinitePositive("minSize", minSize);
  if (minSize < sizeIncrement) throw new Error("minSize must be >= sizeIncrement.");
  if (!Number.isInteger(moneyPrecision) || moneyPrecision < 0 || moneyPrecision > 8) {
    throw new Error("moneyPrecision must be an integer from 0 to 8.");
  }

  const maxRiskMoney = equity * (riskPercent / 100);
  const rawSize = maxRiskMoney / unitRiskMoney;
  const roundedSize = floorToIncrement(rawSize, sizeIncrement);
  const factor = 10 ** 8;
  const size = Math.round(roundedSize * factor) / factor;

  if (size < minSize) {
    return {
      valid: false,
      reason: "RISK_LIMIT_EXCEEDED",
      equity,
      riskPercent,
      maxRiskMoney: roundMoney(maxRiskMoney, moneyPrecision),
      unitRiskMoney: roundMoney(unitRiskMoney, moneyPrecision),
      rawSize,
      size: 0
    };
  }

  const actualRiskMoney = roundMoney(size * unitRiskMoney, moneyPrecision);
  if (actualRiskMoney > roundMoney(maxRiskMoney, moneyPrecision)) {
    // Conservative correction for currency rounding. Never increase size.
    const corrected = Math.max(0, floorToIncrement((maxRiskMoney / unitRiskMoney) - Number.EPSILON, sizeIncrement));
    const correctedSize = Math.round(corrected * factor) / factor;
    if (correctedSize < minSize) {
      return {
        valid: false,
        reason: "RISK_LIMIT_EXCEEDED",
        equity,
        riskPercent,
        maxRiskMoney: roundMoney(maxRiskMoney, moneyPrecision),
        unitRiskMoney: roundMoney(unitRiskMoney, moneyPrecision),
        rawSize,
        size: 0
      };
    }
    return {
      valid: true,
      reason: "POSITION_SIZE_VALID",
      equity,
      riskPercent,
      maxRiskMoney: roundMoney(maxRiskMoney, moneyPrecision),
      unitRiskMoney: roundMoney(unitRiskMoney, moneyPrecision),
      rawSize,
      size: correctedSize,
      actualRiskMoney: roundMoney(correctedSize * unitRiskMoney, moneyPrecision),
      sizeIncrement,
      minSize
    };
  }

  return {
    valid: true,
    reason: "POSITION_SIZE_VALID",
    equity,
    riskPercent,
    maxRiskMoney: roundMoney(maxRiskMoney, moneyPrecision),
    unitRiskMoney: roundMoney(unitRiskMoney, moneyPrecision),
    rawSize,
    size,
    actualRiskMoney,
    sizeIncrement,
    minSize
  };
}

export function buildTpRiskDecision({
  direction,
  entryPrice,
  stopPrice,
  zones,
  config = DEFAULT_TP_RISK_CONFIG,
  sizing
}) {
  assertDirection(direction);
  assertBigIntPrice("entryPrice", entryPrice);
  assertBigIntPrice("stopPrice", stopPrice);

  const target = selectTakeProfitZone({ direction, entryPrice, zones });
  if (!target.valid) return { decision: "NO_TRADE", reasons: [target.reason], target };

  const rr = calculateRewardRisk({
    direction,
    entryPrice,
    stopPrice,
    targetPrice: target.targetPrice,
    minRR: config.minRR
  });
  if (!rr.valid) return { decision: "NO_TRADE", reasons: rr.reasons, target, rr };

  if (!sizing) {
    return {
      decision: "RISK_VALIDATION",
      reasons: [],
      target,
      rr
    };
  }

  const unitRisk = calculateUnitRiskMoney({
    stopDistancePriceTicks: rr.riskPriceTicks,
    priceScale: sizing.priceScale,
    moneyPerPriceUnitPerUnit: sizing.moneyPerPriceUnitPerUnit,
    perUnitFixedCost: sizing.perUnitFixedCost ?? config.perUnitFixedCost,
    moneyPrecision: sizing.moneyPrecision ?? config.moneyPrecision
  });

  if (!unitRisk.valid) {
    return { decision: "NO_TRADE", reasons: ["DATA_INVALID"], target, rr, unitRisk };
  }

  const position = calculatePositionSize({
    equity: sizing.equity,
    riskPercent: sizing.riskPercent ?? config.riskPercent,
    unitRiskMoney: unitRisk.unitRiskMoney,
    sizeIncrement: sizing.sizeIncrement ?? config.sizeIncrement,
    minSize: sizing.minSize ?? config.minSize,
    moneyPrecision: sizing.moneyPrecision ?? config.moneyPrecision
  });

  if (!position.valid) {
    return { decision: "NO_TRADE", reasons: [position.reason], target, rr, unitRisk, position };
  }

  return {
    decision: "TRADE_ALLOWED_PENDING_FINAL_GATE",
    reasons: [],
    target,
    rr,
    unitRisk,
    position
  };
}
