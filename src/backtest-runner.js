/**
 * Stage 36 — chronological historical trade runner.
 *
 * Historical/backtest model only. No live execution.
 *
 * Scope:
 *   - consumes fully-evaluated setup candidates produced by Stages 29–35;
 *   - walks M15 candles strictly forward in time;
 *   - models entry on the candle AFTER the completed BOS confirmation;
 *   - never lets a management change act on the same candle that created it;
 *   - resolves same-candle SL/TP ambiguity conservatively (SL first);
 *   - records an immutable trade ledger and management audit trail;
 *   - prevents overlapping positions for the same strategy/instrument when
 *     configured as one-position-at-a-time.
 *
 * This runner intentionally does NOT invent H4 zones, M15 reactions, BOS,
 * spread, slippage, conversion rates, or subjective structure. Those must be
 * supplied by upstream deterministic modules. Missing prerequisites become
 * DATA_INVALID/UNTESTABLE_PERIOD instead of being guessed.
 */

import {
  modelNextOpenEntry,
  calculateAntiChase,
  calculateAtrBuffer,
  calculateStructuralStop,
  validateInitialStop
} from "./strategy/entry-stop.js";
import { selectTakeProfitZone, calculateRewardRisk, calculatePositionSize, calculateUnitRiskMoney } from "./strategy/take-profit-risk.js";
import { evaluateFinalPermission } from "./strategy/final-gate.js";
import {
  evaluateManagementTrigger,
  applyManagementProposal,
  createManagementAudit,
  resolveSameCandleExit,
  MANAGEMENT_VARIANTS,
  DEFAULT_MANAGEMENT_CONFIG
} from "./strategy/management.js";

function assertDirection(direction) {
  if (direction !== "BUY" && direction !== "SELL") throw new Error("Direction must be BUY or SELL.");
}

function assertBigIntPrice(name, value) {
  if (typeof value !== "bigint") throw new Error(`${name} must be a BigInt fixed-point price.`);
}

function cloneFrozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFrozen));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = cloneFrozen(v);
    return Object.freeze(out);
  }
  return value;
}

function compareTime(a, b) {
  const aa = a ?? 0;
  const bb = b ?? 0;
  return aa < bb ? -1 : aa > bb ? 1 : 0;
}

function candleHasRequiredPrices(candle) {
  return candle && typeof candle.open === "bigint" && typeof candle.high === "bigint" && typeof candle.low === "bigint" && typeof candle.close === "bigint";
}

function entrySideChecks(direction, entryPrice, stopPrice, targetPrice) {
  if (direction === "BUY") return stopPrice < entryPrice && targetPrice > entryPrice;
  return stopPrice > entryPrice && targetPrice < entryPrice;
}

/**
 * Evaluate a fully prepared candidate and, if permitted, simulate it forward.
 * The caller supplies the upstream contracts rather than raw chart opinions.
 */
export function runHistoricalTrade({
  candidate,
  m15Candles,
  h4Zones = [],
  equity,
  priceScale,
  moneyPerPriceUnitPerUnit,
  managementVariant = "M0_NO_MANAGEMENT",
  managementConfig = DEFAULT_MANAGEMENT_CONFIG,
  spreadPriceTicks = 0n,
  slippagePriceTicks = 0n,
  entryStopConfig,
  setupId,
  strategyVersion = "V1-STAGE36",
  instrument = "UNKNOWN",
  onePositionOnly = true,
  existingPosition = false,
  precomputedFinalPermission = null
}) {
  if (!candidate || typeof candidate !== "object") throw new Error("candidate is required.");
  assertDirection(candidate.direction);
  if (!Array.isArray(m15Candles)) throw new Error("m15Candles must be an array.");
  if (!Number.isInteger(candidate.bos?.confirmationIndex)) throw new Error("candidate.bos.confirmationIndex is required.");
  if (setupId === undefined || setupId === null || setupId === "") throw new Error("setupId is required.");
  if (!MANAGEMENT_VARIANTS.includes(managementVariant)) throw new Error("Invalid managementVariant.");

  const direction = candidate.direction;
  const reasons = [];
  const audit = {
    setupId,
    strategyVersion,
    instrument,
    direction,
    lifecycle: ["CANDIDATE"],
    candidateTimestamp: candidate.bos.confirmationTimestamp ?? null
  };

  const bosIndex = candidate.bos.confirmationIndex;
  const entry = modelNextOpenEntry({
    direction,
    candles: m15Candles,
    confirmationIndex: bosIndex,
    spreadPriceTicks,
    slippagePriceTicks,
    requireNextCandleComplete: true
  });

  if (!entry.valid) {
    reasons.push(entry.reason === "UNTESTABLE_PERIOD" ? "UNTESTABLE_PERIOD" : "DATA_INVALID");
    return cloneFrozen({ decision: "NO_TRADE", reasons, audit, entry });
  }

  const atrAtConfirmation = candidate.atrPriceUnits;
  const antiChase = calculateAntiChase({
    direction,
    entryPrice: entry.entryPrice,
    brokenReferencePrice: candidate.bos.reference.price,
    atrPriceUnits: atrAtConfirmation,
    maxExtensionAtr: entryStopConfig.maxExtensionAtr
  });

  const buffer = calculateAtrBuffer(
    m15Candles,
    bosIndex,
    entryStopConfig.atrPeriod,
    entryStopConfig.slBufferAtr
  );
  const stop = buffer.valid
    ? calculateStructuralStop({
        direction,
        reactionSwing: candidate.reactionSwing,
        zone: candidate.zone,
        bufferPriceTicks: buffer.bufferPriceTicks
      })
    : { valid: false, reason: buffer.reason ?? "DATA_INVALID" };
  if (stop.valid) {
    stop.validation = validateInitialStop({
      direction,
      entryPrice: entry.entryPrice,
      stopPrice: stop.stopPrice,
      reactionSwing: candidate.reactionSwing,
      zone: candidate.zone
    });
    if (!stop.validation.valid) stop.valid = false;
  }

  const target = selectTakeProfitZone({ direction, entryPrice: entry.entryPrice, zones: h4Zones });
  const rr = target.valid && stop.valid
    ? calculateRewardRisk({ direction, entryPrice: entry.entryPrice, stopPrice: stop.stopPrice, targetPrice: target.targetPrice, minRR: candidate.minRR ?? 2.0 })
    : { valid: false, reasons: [target.valid ? "INVALID_STOP" : "NO_TARGET_ZONE"], rr: null };

  let position = null;
  if (stop.valid && target.valid && rr.valid && entryStopConfig) {
    const unitRisk = calculateUnitRiskMoney({
      stopDistancePriceTicks: rr.riskPriceTicks,
      priceScale,
      moneyPerPriceUnitPerUnit,
      perUnitFixedCost: candidate.perUnitFixedCost ?? 0,
      moneyPrecision: candidate.moneyPrecision ?? 2
    });
    if (unitRisk.valid) {
      const sizing = calculatePositionSize({
        equity,
        riskPercent: candidate.riskPercent ?? 1,
        unitRiskMoney: unitRisk.unitRiskMoney,
        sizeIncrement: candidate.sizeIncrement ?? 0.01,
        minSize: candidate.minSize ?? 0.01,
        moneyPrecision: candidate.moneyPrecision ?? 2
      });
      position = { unitRisk, sizing };
    }
  }

  const upstream = candidate.upstream ?? {};
  const finalPermission = precomputedFinalPermission ?? evaluateFinalPermission({
    direction,
    context: upstream.context,
    zone: { ...(candidate.zone ?? {}), valid: candidate.zone?.valid ?? true },
    location: upstream.location,
    pullback: upstream.pullback,
    reaction: upstream.reaction,
    bos: candidate.bos,
    entryStop: {
      decision: stop.valid && antiChase.pass ? "TRADE_VALIDATION" : "NO_TRADE",
      antiChase,
      stopValidation: stop.valid ? { valid: true } : { valid: false },
      reasons: [
        ...(antiChase.pass ? [] : ["ENTRY_TOO_EXTENDED"]),
        ...(stop.valid ? [] : ["INVALID_STOP"])
      ]
    },
    tpRisk: {
      decision: target.valid && rr.valid && position?.sizing?.valid ? "TRADE_ALLOWED_PENDING_FINAL_GATE" : "NO_TRADE",
      target: { valid: target.valid },
      rr: { valid: rr.valid, reasons: rr.reasons ?? [] },
      position: { valid: position?.sizing?.valid === true, reason: position?.sizing?.reason }
    },
    setup: candidate.setup ?? {},
    positionExists: onePositionOnly ? (existingPosition === true) : false,
    dataValid: candidate.dataValid !== false,
    testablePeriod: candidate.testablePeriod !== false
  });

  if (finalPermission.decision !== "TRADE_ALLOWED") {
    return cloneFrozen({
      decision: "NO_TRADE",
      reasons: finalPermission.reasons,
      audit,
      entry,
      antiChase,
      buffer,
      stop,
      target,
      rr,
      position,
      finalPermission
    });
  }

  if (!position?.sizing?.valid) {
    return cloneFrozen({ decision: "NO_TRADE", reasons: ["RISK_LIMIT_EXCEEDED"], audit, entry, antiChase, stop, target, rr, position });
  }

  if (!entrySideChecks(direction, entry.entryPrice, stop.stopPrice, target.targetPrice)) {
    return cloneFrozen({ decision: "NO_TRADE", reasons: ["DATA_INVALID"], audit, entry, antiChase, stop, target, rr, position });
  }

  const executionIndex = entry.executionIndex;
  let currentStopPrice = stop.stopPrice;
  let exit = null;
  const managementAudits = [];
  let managementState = "INITIAL_RISK";

  audit.lifecycle.push("TRADE_ALLOWED", "POSITION_OPEN");

  for (let i = executionIndex; i < m15Candles.length; i++) {
    const candle = m15Candles[i];
    if (!candleHasRequiredPrices(candle) || candle.isComplete === false) {
      return cloneFrozen({
        decision: "UNTESTABLE_PERIOD",
        reasons: ["UNTESTABLE_PERIOD"],
        audit,
        entry,
        antiChase,
        stop,
        target,
        rr,
        position,
        managementAudits,
        managementState,
        activeStopPrice: currentStopPrice
      });
    }

    // Stop/TP are active throughout this candle. Any management signal created
    // by this candle only becomes active on the NEXT candle, so we resolve
    // exits against the stop that existed at the start of the candle.
    const exitCheck = resolveSameCandleExit({ direction, candle, stopPrice: currentStopPrice, targetPrice: target.targetPrice });
    if (exitCheck.outcome === "SL") {
      exit = { index: i, reason: exitCheck.reason, price: currentStopPrice, candle };
      break;
    }
    if (exitCheck.outcome === "TP") {
      exit = { index: i, reason: exitCheck.reason, price: target.targetPrice, candle };
      break;
    }

    const structureStopPrice = candidate.structureStops?.[i] ?? null;
    const proposal = evaluateManagementTrigger({
      variant: managementVariant,
      direction,
      entryPrice: entry.entryPrice,
      initialStopPrice: stop.stopPrice,
      currentStopPrice,
      signalCandle: candle,
      config: managementConfig,
      structureStopPrice
    });

    if (proposal.valid && proposal.triggered && proposal.applied) {
      const applied = applyManagementProposal({ direction, currentStopPrice, proposal });
      if (applied.applied) {
        const oldStop = currentStopPrice;
        currentStopPrice = applied.stopPrice;
        managementState = "MANAGEMENT";
        managementAudits.push(createManagementAudit({
          setupId,
          direction,
          candle,
          oldStopPrice: oldStop,
          newStopPrice: currentStopPrice,
          variant: managementVariant,
          trigger: proposal.reason,
          favorableR: proposal.favorableR
        }));
      }
    }
  }

  if (!exit) {
    return cloneFrozen({
      decision: "UNTESTABLE_PERIOD",
      reasons: ["UNTESTABLE_PERIOD"],
      audit,
      entry,
      antiChase,
      stop,
      target,
      rr,
      position,
      managementAudits,
      managementState,
      activeStopPrice: currentStopPrice
    });
  }

  const riskTicks = rr.riskPriceTicks;
  const pnlTicks = direction === "BUY" ? exit.price - entry.entryPrice : entry.entryPrice - exit.price;
  const realizedR = Number(pnlTicks) / Number(riskTicks);
  const size = position.sizing.size;
  const grossMoney = realizedR * position.sizing.actualRiskMoney;
  const netMoney = grossMoney;

  audit.lifecycle.push("POSITION_CLOSED");

  return cloneFrozen({
    decision: "TRADE_COMPLETED",
    reasons: [],
    audit,
    entry,
    antiChase,
    stop,
    target,
    rr,
    position,
    managementAudits,
    managementState,
    activeStopPrice: currentStopPrice,
    exit,
    result: {
      size,
      pnlPriceTicks: pnlTicks,
      realizedR,
      grossMoney,
      netMoney,
      exitReason: exit.reason
    }
  });
}

/**
 * Run prepared candidates in chronological order. This is intentionally a
 * small orchestration layer: upstream signal detection remains modular and
 * independently testable.
 */
export function runHistoricalCandidates({ candidates, runnerOptions, onePositionOnly = true }) {
  if (!Array.isArray(candidates)) throw new Error("candidates must be an array.");

  const ordered = [...candidates].sort((a, b) => compareTime(a.bos?.confirmationTimestamp, b.bos?.confirmationTimestamp));
  const results = [];
  let positionOpenUntilIndex = -1;
  let currentEquity = runnerOptions.equity;

  for (const [ordinal, candidate] of ordered.entries()) {
    const alreadyOpen = onePositionOnly && Number.isInteger(positionOpenUntilIndex) && positionOpenUntilIndex >= candidate.bos.confirmationIndex;
    const result = runHistoricalTrade({
      ...runnerOptions,
      candidate,
      equity: currentEquity,
      setupId: candidate.setupId ?? `${runnerOptions.instrument ?? "INSTRUMENT"}-${ordinal + 1}`,
      existingPosition: alreadyOpen,
      onePositionOnly
    });
    results.push(result);

    if (result.decision === "TRADE_COMPLETED") {
      positionOpenUntilIndex = result.exit.index;
      currentEquity += result.result.netMoney;
    }
  }

  return Object.freeze({
    strategyVersion: runnerOptions.strategyVersion ?? "V1-STAGE36",
    candidatesProcessed: ordered.length,
    tradesCompleted: results.filter(r => r.decision === "TRADE_COMPLETED").length,
    tradesRejected: results.filter(r => r.decision === "NO_TRADE").length,
    untestable: results.filter(r => r.decision === "UNTESTABLE_PERIOD").length,
    endingEquity: currentEquity,
    results: cloneFrozen(results)
  });
}
