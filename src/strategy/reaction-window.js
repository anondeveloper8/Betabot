/**
 * Reaction confirmation is evaluated only against information available
 * from the zone interaction through the current completed candle.
 *
 * This helper gives experiments an explicit, bounded reaction window.
 * `maxBars` is a research parameter rather than a hidden assumption.
 */

export function reactionWindowEnd(interactionIndex, currentIndex, maxBars) {
  if (!Number.isInteger(interactionIndex) || interactionIndex < 0) {
    throw new Error("interactionIndex must be a non-negative integer.");
  }
  if (!Number.isInteger(currentIndex) || currentIndex < interactionIndex) {
    throw new Error("currentIndex must be >= interactionIndex.");
  }
  if (!Number.isInteger(maxBars) || maxBars < 0) {
    throw new Error("maxBars must be a non-negative integer.");
  }

  return Math.min(currentIndex, interactionIndex + maxBars);
}
