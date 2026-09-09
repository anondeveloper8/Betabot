/**
 * A single valid BOS event can consume a setup.
 * This prevents repeated entries from the same confirmation.
 */

export function consumeSetup(setup) {
  if (!setup || typeof setup !== "object") {
    throw new TypeError("setup is required.");
  }

  if (setup.used === true) {
    return {
      allowed: false,
      reason: "SETUP_ALREADY_USED"
    };
  }

  return {
    allowed: true,
    reason: "SETUP_AVAILABLE",
    setup: {
      ...setup,
      used: true
    }
  };
}
