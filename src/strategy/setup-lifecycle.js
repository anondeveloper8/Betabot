/**
 * Stage 29 — setup lifecycle primitives.
 */

export const SETUP_STATES = Object.freeze([
  "NO_SETUP",
  "SETUP_CREATED",
  "CONTEXT_VALID",
  "ZONE_VALID",
  "AT_ZONE",
  "PULLBACK_ACTIVE",
  "REACTION_CONFIRMED",
  "BOS_CONFIRMED",
  "TRADE_VALIDATION",
  "TRADE_ALLOWED",
  "NO_TRADE",
  "POSITION_OPEN",
  "MANAGEMENT",
  "POSITION_CLOSED"
]);

const TERMINAL = new Set(["NO_TRADE", "POSITION_CLOSED"]);

export function assertValidState(state) {
  if (!SETUP_STATES.includes(state)) {
    throw new Error(`Unknown setup state: ${state}`);
  }
}

export function isTerminalState(state) {
  assertValidState(state);
  return TERMINAL.has(state);
}

/**
 * At this stage, only the legal forward transitions are allowed.
 */
const transitions = new Map([
  ["NO_SETUP", new Set(["SETUP_CREATED"])],
  ["SETUP_CREATED", new Set(["CONTEXT_VALID", "NO_TRADE"])],
  ["CONTEXT_VALID", new Set(["ZONE_VALID", "NO_TRADE"])],
  ["ZONE_VALID", new Set(["AT_ZONE", "NO_TRADE"])],
  ["AT_ZONE", new Set(["PULLBACK_ACTIVE", "NO_TRADE"])],
  ["PULLBACK_ACTIVE", new Set(["REACTION_CONFIRMED", "NO_TRADE"])],
  ["REACTION_CONFIRMED", new Set(["BOS_CONFIRMED", "NO_TRADE"])],
  ["BOS_CONFIRMED", new Set(["TRADE_VALIDATION", "NO_TRADE"])],
  ["TRADE_VALIDATION", new Set(["TRADE_ALLOWED", "NO_TRADE"])],
  ["TRADE_ALLOWED", new Set(["POSITION_OPEN", "NO_TRADE"])],
  ["POSITION_OPEN", new Set(["MANAGEMENT", "POSITION_CLOSED"])],
  ["MANAGEMENT", new Set(["MANAGEMENT", "POSITION_CLOSED"])]
]);

export function transitionState(from, to) {
  assertValidState(from);
  assertValidState(to);

  const allowed = transitions.get(from);

  if (!allowed || !allowed.has(to)) {
    throw new Error(`Illegal state transition: ${from} -> ${to}`);
  }

  return to;
}
