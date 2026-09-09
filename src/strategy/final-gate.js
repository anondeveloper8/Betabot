/**
 * Stage 34 — deterministic final no-trade permission engine.
 *
 * Historical/backtest model only. No live order execution.
 *
 * The final gate does not reinterpret the strategy. It only verifies that
 * every required upstream contract has passed and that hard rejection
 * conditions are absent. Every applicable rejection is returned in a
 * deterministic, auditable array.
 */

export const FINAL_GATE_REASONS = Object.freeze([
  "H4_CONTEXT_UNCLEAR",
  "ZONE_NOT_VALID",
  "NOT_AT_ZONE",
  "PULLBACK_NOT_CONFIRMED",
  "REACTION_NOT_CONFIRMED",
  "BOS_NOT_CONFIRMED",
  "ENTRY_TOO_EXTENDED",
  "INVALID_STOP",
  "NO_TARGET_ZONE",
  "RR_BELOW_MINIMUM",
  "RISK_LIMIT_EXCEEDED",
  "SETUP_ALREADY_USED",
  "DATA_INVALID",
  "EXISTING_POSITION",
  "UNTESTABLE_PERIOD"
]);

const VALID_DIRECTIONS = new Set(["BUY", "SELL"]);
const VALID_CONTEXTS = new Set(["BULLISH", "BEARISH", "UNCLEAR"]);

function assertDirection(direction) {
  if (!VALID_DIRECTIONS.has(direction)) throw new Error("Direction must be BUY or SELL.");
}

function addReason(reasons, reason) {
  if (!FINAL_GATE_REASONS.includes(reason)) throw new Error(`Unknown final-gate reason: ${reason}`);
  if (!reasons.includes(reason)) reasons.push(reason);
}

function boolOrUndefined(value) {
  return value === true || value === false ? value : undefined;
}

/**
 * Evaluate every hard gate. Missing prerequisite data is DATA_INVALID unless
 * a more specific explicit rejection is already available.
 *
 * Expected upstream fields:
 *   context.directionalBias / context.state
 *   zone.valid, location.atZone
 *   pullback.confirmed
 *   reaction.confirmed
 *   bos.state === "CONFIRMED"
 *   entryStop.decision === "TRADE_VALIDATION" and sub-contracts
 *   tpRisk.decision === "TRADE_ALLOWED_PENDING_FINAL_GATE"
 *   setup.used / positionExists
 *
 * The function intentionally does NOT infer subjective values.
 */
export function evaluateFinalPermission({
  direction,
  context,
  zone,
  location,
  pullback,
  reaction,
  bos,
  entryStop,
  tpRisk,
  setup = {},
  positionExists = false,
  dataValid = true,
  testablePeriod = true
}) {
  assertDirection(direction);

  const reasons = [];
  const evidence = {};

  if (dataValid !== true) addReason(reasons, "DATA_INVALID");
  if (testablePeriod !== true) addReason(reasons, "UNTESTABLE_PERIOD");

  const contextState = context?.state ?? context?.directionalBias;
  evidence.contextState = contextState ?? null;
  if (!VALID_CONTEXTS.has(contextState)) {
    addReason(reasons, "DATA_INVALID");
  } else if (contextState === "UNCLEAR") {
    addReason(reasons, "H4_CONTEXT_UNCLEAR");
  }

  const zoneValid = boolOrUndefined(zone?.valid);
  evidence.zoneValid = zoneValid;
  if (zoneValid !== true) addReason(reasons, "ZONE_NOT_VALID");

  const atZone = boolOrUndefined(location?.atZone ?? location?.valid);
  evidence.atZone = atZone;
  if (atZone !== true) addReason(reasons, "NOT_AT_ZONE");

  const pullbackConfirmed = boolOrUndefined(pullback?.confirmed ?? pullback?.valid);
  evidence.pullbackConfirmed = pullbackConfirmed;
  if (pullbackConfirmed !== true) addReason(reasons, "PULLBACK_NOT_CONFIRMED");

  const reactionConfirmed = boolOrUndefined(reaction?.confirmed ?? reaction?.valid);
  evidence.reactionConfirmed = reactionConfirmed;
  if (reactionConfirmed !== true) addReason(reasons, "REACTION_NOT_CONFIRMED");

  const bosConfirmed = bos?.state === "CONFIRMED";
  evidence.bosConfirmed = bosConfirmed;
  if (!bosConfirmed) addReason(reasons, "BOS_NOT_CONFIRMED");

  if (!entryStop || entryStop.decision !== "TRADE_VALIDATION") {
    // Prefer explicit Stage 32 reason(s) when supplied.
    if (Array.isArray(entryStop?.reasons) && entryStop.reasons.length > 0) {
      for (const reason of entryStop.reasons) {
        if (reason === "ENTRY_TOO_EXTENDED") addReason(reasons, reason);
        else if (reason === "INVALID_STOP" || reason === "INVALID_STOP_ZONE_PROTECTION" || reason === "INVALID_STOP_REACTION_PROTECTION") addReason(reasons, "INVALID_STOP");
        else if (reason === "UNTESTABLE_PERIOD") addReason(reasons, reason);
        else if (reason === "DATA_INVALID") addReason(reasons, reason);
      }
    } else {
      addReason(reasons, "DATA_INVALID");
    }
  }

  // Explicit anti-chase evidence is checked even if Stage 32 omitted a final decision.
  if (entryStop?.antiChase && entryStop.antiChase.pass !== true) addReason(reasons, "ENTRY_TOO_EXTENDED");
  if (entryStop?.stopValidation && entryStop.stopValidation.valid !== true) addReason(reasons, "INVALID_STOP");

  // BUGFIX (previously): this block read a top-level `tpRisk.reasons` array
  // that no caller in this codebase ever populates -- callers put rejection
  // detail on tpRisk.target / tpRisk.rr.reasons / tpRisk.position.reason
  // instead, which the more specific checks below already consume
  // correctly. As written, `explicit` was always empty whenever tpRisk came
  // from the real runner, so this fired "DATA_INVALID" on every single
  // rr/target/position rejection *in addition to* the correct, specific
  // reason the checks below also added -- verified against a live run: 14
  // of 15 rejected candidates carried a duplicate DATA_INVALID, and all 14
  // were exactly the ones with NO_TARGET_ZONE or RR_BELOW_MINIMUM already
  // present. DATA_INVALID should mean "tpRisk didn't even give us enough to
  // evaluate" (Handover 2 s.25: engine/data failure, not a strategy
  // rejection) -- so the fallback now only fires when none of the specific
  // sub-checks below will have anything to say, not merely because the
  // decision wasn't ALLOWED. This changes no TRADE_ALLOWED/NO_TRADE
  // decision (the affected candidates were already NO_TRADE for their real
  // reason) -- it only removes a spurious, redundant reason code.
  if (!tpRisk || tpRisk.decision !== "TRADE_ALLOWED_PENDING_FINAL_GATE") {
    const explicit = Array.isArray(tpRisk?.reasons) ? tpRisk.reasons : [];
    let mapped = false;
    for (const reason of explicit) {
      if (reason === "NO_TARGET_ZONE") { addReason(reasons, reason); mapped = true; }
      else if (reason === "RR_BELOW_MINIMUM") { addReason(reasons, reason); mapped = true; }
      else if (reason === "RISK_LIMIT_EXCEEDED") { addReason(reasons, reason); mapped = true; }
      else if (reason === "DATA_INVALID") { addReason(reasons, reason); mapped = true; }
    }
    const hasSpecificSubchecks = Boolean(tpRisk?.target || tpRisk?.rr || tpRisk?.position);
    if (!mapped && explicit.length === 0 && !hasSpecificSubchecks) addReason(reasons, "DATA_INVALID");
  }

  if (tpRisk?.target && tpRisk.target.valid !== true) addReason(reasons, "NO_TARGET_ZONE");
  if (tpRisk?.rr && tpRisk.rr.valid !== true) {
    if (Array.isArray(tpRisk.rr.reasons) && tpRisk.rr.reasons.includes("INVALID_STOP")) addReason(reasons, "INVALID_STOP");
    if (Array.isArray(tpRisk.rr.reasons) && tpRisk.rr.reasons.includes("RR_BELOW_MINIMUM")) addReason(reasons, "RR_BELOW_MINIMUM");
  }
  // BUGFIX (previously): backtest-runner.js only computes position sizing at
  // all when stop/target/rr already succeeded (see its `if (stop.valid &&
  // target.valid && rr.valid...)` guard) -- otherwise `position` stays null
  // and tpRisk.position becomes `{ valid: false, reason: undefined }`. That
  // made this `else` branch add a spurious "DATA_INVALID" on every
  // NO_TARGET_ZONE / RR_BELOW_MINIMUM / INVALID_STOP rejection too, since
  // position sizing was never actually attempted, not because it failed for
  // an unrecognized reason. This is the second half of the same duplicate-
  // tag bug fixed above. Only treat an *attempted* position-sizing failure
  // (a real, non-undefined reason code) as worth a reason here.
  if (tpRisk?.position && tpRisk.position.valid !== true && tpRisk.position.reason !== undefined) {
    if (tpRisk.position.reason === "RISK_LIMIT_EXCEEDED") addReason(reasons, "RISK_LIMIT_EXCEEDED");
    else addReason(reasons, "DATA_INVALID");
  }

  if (setup?.used === true) addReason(reasons, "SETUP_ALREADY_USED");
  if (positionExists === true) addReason(reasons, "EXISTING_POSITION");

  const decision = reasons.length === 0 ? "TRADE_ALLOWED" : "NO_TRADE";

  return Object.freeze({
    decision,
    reasons: Object.freeze(reasons),
    passed: reasons.length === 0,
    evidence: Object.freeze(evidence)
  });
}

/**
 * Convenience wrapper that additionally verifies the direction is consistent
 * across the supplied upstream objects when such direction fields exist.
 */
export function buildFinalPermission({
  direction,
  ...inputs
}) {
  const result = evaluateFinalPermission({ direction, ...inputs });
  const directionErrors = [];

  const candidates = [inputs.context, inputs.zone, inputs.location, inputs.pullback, inputs.reaction, inputs.bos, inputs.entryStop, inputs.tpRisk]
    .filter(Boolean);

  for (const item of candidates) {
    if (item.direction !== undefined && item.direction !== direction) {
      directionErrors.push("DATA_INVALID");
      break;
    }
  }

  if (directionErrors.length === 0) return result;

  return Object.freeze({
    ...result,
    decision: "NO_TRADE",
    passed: false,
    reasons: Object.freeze([...result.reasons, ...directionErrors.filter((r) => !result.reasons.includes(r))])
  });
}
