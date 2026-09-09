/**
 * Stage 29 — pullback depth calculation helpers.
 *
 * Depth is measured separately from pullback existence.
 * This prevents "there is a pullback" and "the pullback is X deep"
 * from becoming one ambiguous rule.
 */

export function calculatePullbackDepthRatio({
  impulseStart,
  impulseExtreme,
  pullbackExtreme
}) {
  const impulseRange = Math.abs(impulseExtreme - impulseStart);

  if (impulseRange <= 0) {
    return null;
  }

  const retraced = Math.abs(pullbackExtreme - impulseExtreme);

  return retraced / impulseRange;
}

export function evaluatePullbackDepth({
  ratio,
  minimumRatio = null,
  maximumRatio = null
}) {
  if (!Number.isFinite(ratio) || ratio < 0) {
    return {
      valid: false,
      reason: "INVALID_DEPTH"
    };
  }

  if (minimumRatio !== null && ratio < minimumRatio) {
    return {
      valid: false,
      reason: "PULLBACK_TOO_SHALLOW"
    };
  }

  if (maximumRatio !== null && ratio > maximumRatio) {
    return {
      valid: false,
      reason: "PULLBACK_TOO_DEEP"
    };
  }

  return {
    valid: true,
    reason: "DEPTH_IN_RANGE"
  };
}
