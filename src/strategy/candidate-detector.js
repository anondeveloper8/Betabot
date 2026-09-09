/**
 * Stage 39 — deterministic end-to-end candidate detector.
 *
 * Historical research/backtesting only. No live execution.
 *
 * At each completed M15 close this detector sees:
 *   - completed H4 candles only for H4 structure/zone formation;
 *   - the current M15 candle and earlier M15 candles;
 *   - the current (possibly still-forming) H4 candle only for location.
 *
 * It implements the V1 research chain:
 *   H4 context -> matching H4 zone -> H4 location -> R3 reaction ->
 *   P3 structural pullback -> B1/B2/B3 BOS -> candidate.
 *
 * It never inspects a future candle and emits a candidate only when BOS is
 * confirmed on the current completed M15 candle.
 */

import { getConfirmedSwings } from "../../engine/swings.js";
import { getH4Zones, isPriceAtZone, DEFAULT_ZONE_CONFIG } from "../../engine/zones.js";
import { evaluateH4Location } from "./location.js";
import { evaluateStructuralPullback } from "./pullback.js";
import { evaluateReactionCandidate } from "./reaction.js";
import { evaluateBosCandidates } from "./bos.js";
import { calculateWilderATR } from "../../engine/atr.js";

export const DEFAULT_DETECTOR_CONFIG = Object.freeze({
  zone: DEFAULT_ZONE_CONFIG,
  reactionMethod: "R3_DISPLACEMENT_PLUS_MIDPOINT_RECOVERY",
  reactionMinDisplacement: 0,
  bosMethods: Object.freeze([
    "B1_LAST_CONFIRMED_COUNTER_SWING",
    "B2_LATEST_CONFIRMED_SWING_BEFORE_REACTION",
    "B3_PULLBACK_SEQUENCE_HIGH_LOW"
  ]),
  allowTouchedZones: true,
  oneCandidatePerSetup: true,
  minRR: 2.0,
  riskPercent: 1
});

function assertM15Index(i, candles) {
  if (!Number.isInteger(i) || i < 0 || i >= candles.length) {
    throw new Error("currentIndex must be a valid M15 index.");
  }
}

function currentH4ForM15(dataset, alignment, m15Index) {
  const h4Index = alignment.m15ToH4Index[m15Index];
  return Number.isInteger(h4Index) ? dataset.h4Candles[h4Index] ?? null : null;
}

function visibleH4Swings(dataset, m15Candle) {
  // H4 candles are contiguous from the dataset start. Calling the swing helper
  // on the full array with the last visible H4 index is exactly equivalent to
  // filtering the candles first, because swing indices and confirmation rules
  // are unchanged. This also lets getConfirmedSwings reuse its memoized scan.
  let lastVisibleIndex = -1;
  for (let i = dataset.h4Candles.length - 1; i >= 0; i--) {
    if (dataset.h4Candles[i].timestampClose <= m15Candle.timestampClose) {
      lastVisibleIndex = i;
      break;
    }
  }
  return lastVisibleIndex >= 0 ? getConfirmedSwings(dataset.h4Candles, lastVisibleIndex) : [];
}

function latestEligibleZone(zones, direction, currentH4) {
  const type = direction === "BUY" ? "DEMAND" : "SUPPLY";
  const eligible = zones.filter(z =>
    z.type === type &&
    ["VALID", "TOUCHED"].includes(z.status) &&
    currentH4 && isPriceAtZone(currentH4, z)
  );
  return eligible.at(-1) ?? null;
}

function makeSetupId(zone, interactionIndex, direction) {
  return `${zone.id}-${direction}-INTERACTION-${interactionIndex}`;
}

function pickBos(bosResults) {
  const confirmed = bosResults.filter(b => b.state === "CONFIRMED");
  if (!confirmed.length) return null;
  confirmed.sort((a, b) => {
    if (a.confirmationIndex !== b.confirmationIndex) return a.confirmationIndex - b.confirmationIndex;
    return a.method.localeCompare(b.method);
  });
  return confirmed[0];
}

function buildCandidate({
  direction,
  zone,
  interactionIndex,
  reaction,
  pullback,
  bos,
  context,
  location,
  m15Swings,
  config,
  currentIndex
}) {
  return {
    setupId: makeSetupId(zone, interactionIndex, direction),
    direction,
    zone,
    reactionSwing: pullback.referenceSwing,
    atrPriceUnits: null,
    minRR: config.minRR,
    riskPercent: config.riskPercent,
    upstream: {
      context,
      location: {
        ...location,
        timestamp: location.timestamp ?? null
      },
      pullback,
      reaction
    },
    bos,
    setup: {
      state: "BOS_CONFIRMED",
      interactionIndex,
      reactionConfirmationIndex: reaction.confirmationIndex,
      bosConfirmationIndex: bos.confirmationIndex,
      candidateIndex: currentIndex
    },
    m15Swings: m15Swings.map(s => ({ ...s }))
  };
}

export function createCandidateDetector({ dataset, alignment, config = DEFAULT_DETECTOR_CONFIG } = {}) {
  if (!dataset?.m15Candles || !dataset?.h4Candles) throw new Error("dataset is required.");
  if (!alignment?.valid) throw new Error("valid timeframe alignment is required.");

  const usedSetups = new Set();
  const activeSetups = new Map();

  return function detect(step) {
    const i = step.m15Index;
    assertM15Index(i, dataset.m15Candles);
    const m15 = dataset.m15Candles[i];
    if (m15.isComplete === false) return [];

    const h4 = currentH4ForM15(dataset, alignment, i);
    if (!h4) return [];

    const context = step.h4Context ?? { direction: "UNCLEAR" };
    if (!['BULLISH', 'BEARISH'].includes(context.direction)) return [];

    const direction = context.direction === "BULLISH" ? "BUY" : "SELL";
    const h4Swings = visibleH4Swings(dataset, m15);
    const lastCompletedH4Index = dataset.h4Candles.reduce(
      (last, candle, idx) => candle.timestampClose <= m15.timestampClose ? idx : last,
      -1
    );
    const knownZones = lastCompletedH4Index >= 0
      ? getH4Zones(dataset.h4Candles, h4Swings, lastCompletedH4Index, config.zone)
      : [];

    const location = evaluateH4Location({
      candle: h4,
      zones: knownZones,
      direction,
      allowTouched: config.allowTouchedZones
    });

    for (const zone of location.zones) {
      const key = `${zone.id}-${direction}`;
      if (!activeSetups.has(key) && ![...usedSetups].some(id => id.startsWith(`${zone.id}-${direction}-INTERACTION-`))) {
        activeSetups.set(key, {
          zone,
          direction,
          interactionIndex: i,
          reactionScanIndex: i,
          reaction: null,
          pullbackScanIndex: 0,
          pullbackReferenceSwing: null,
          bosReferences: null,
          bosScanIndex: null,
          bosFirstResults: null
        });
      }
    }

    const m15Swings = getConfirmedSwings(dataset.m15Candles, i);
    const outputs = [];

    for (const [key, state] of activeSetups.entries()) {
      if (state.direction !== direction) continue;
      const { zone, interactionIndex } = state;
      const setupId = makeSetupId(zone, interactionIndex, direction);
      if (usedSetups.has(setupId)) {
        activeSetups.delete(key);
        continue;
      }

      // Exact incremental R3 evaluation: candles are immutable, so an
      // unconfirmed scan only needs to inspect candles not checked previously.
      if (!state.reaction) {
        const reaction = evaluateReactionCandidate({
          method: config.reactionMethod,
          direction,
          zone,
          zoneInteractionIndex: interactionIndex,
          candles: dataset.m15Candles,
          currentIndex: i,
          minDisplacement: config.reactionMinDisplacement,
          startIndex: state.reactionScanIndex
        });
        if (reaction.state === "CONFIRMED") {
          state.reaction = reaction;
        } else {
          state.reactionScanIndex = i + 1;
          continue;
        }
      }
      const reaction = state.reaction;

      // P3 must always select the latest qualifying counter-direction swing.
      // Cache only the latest qualifying swing; update it as newly confirmed
      // swings arrive. This preserves the original filter+sort semantics.
      const counterType = direction === "BUY" ? "LOW" : "HIGH";
      let latest = state.pullbackReferenceSwing;
      const start = Math.max(0, state.pullbackScanIndex);
      for (let s = start; s < m15Swings.length; s++) {
        const swing = m15Swings[s];
        if (
          swing.timeframe === "M15" &&
          swing.type === counterType &&
          swing.candleIndex >= reaction.confirmationIndex &&
          swing.confirmationIndex <= i
        ) latest = swing;
      }
      state.pullbackReferenceSwing = latest;
      state.pullbackScanIndex = m15Swings.length;
      if (!latest) continue;

      const pullback = {
        state: "CONFIRMED",
        method: "P3_CONFIRMED_COUNTER_SWING",
        direction,
        referenceSwing: latest,
        confirmationIndex: latest.confirmationIndex,
        depthReference: latest.price
      };

      // BOS references are fixed at reaction confirmation because the original
      // selection only admits swings confirmed by that timestamp.
      if (!state.bosReferences) {
        state.bosReferences = config.bosMethods.map(method => selectBosReferenceForCachedState({
          method,
          direction,
          m15Swings,
          reactionConfirmationIndex: reaction.confirmationIndex,
          pullbackReferenceSwing: latest
        }));
        state.bosScanIndex = reaction.confirmationIndex + 1;
        state.bosFirstResults = new Map();
      }

      // Catch up BOS scans through the current bar whenever this setup's H4
      // direction is active. If context was opposite on an earlier bar, the
      // original detector would later rescan that skipped interval; this cursor
      // therefore advances only when direction matches but never forgets bars.
      if (state.bosScanIndex <= i) {
        for (const selected of state.bosReferences) {
          if (!selected.reference) continue;
          if (state.bosFirstResults.has(selected.method)) continue;
          const first = findFirstBosConfirmation(
            direction,
            selected.reference,
            dataset.m15Candles,
            state.bosScanIndex,
            i
          );
          if (first !== null) state.bosFirstResults.set(selected.method, first);
        }
        state.bosScanIndex = i + 1;
      }

      const bosResults = state.bosReferences.map(selected => {
        const first = state.bosFirstResults.get(selected.method);
        return first === undefined
          ? {
              state: "NOT_CONFIRMED",
              reason: "BOS_NOT_CONFIRMED",
              confirmationIndex: null,
              confirmationTimestamp: null,
              reference: selected.reference,
              method: selected.method,
              referenceSelectionValid: selected.valid
            }
          : {
              state: "CONFIRMED",
              reason: "BOS_CONFIRMED",
              confirmationIndex: first,
              confirmationTimestamp: dataset.m15Candles[first].timestampClose,
              reference: selected.reference,
              method: selected.method,
              referenceSelectionValid: selected.valid
            };
      });
      const bos = pickBos(bosResults);
      if (!bos || bos.confirmationIndex !== i) continue;

      const atr = calculateWilderATR(dataset.m15Candles, config.zone.atrPeriod ?? 14, i);
      const candidate = buildCandidate({
        direction,
        zone,
        interactionIndex,
        reaction,
        pullback,
        bos,
        context,
        location: { ...location, timestamp: m15.timestampClose },
        m15Swings,
        config,
        currentIndex: i
      });
      candidate.atrPriceUnits = atr?.valueInPriceUnits ?? null;

      usedSetups.add(setupId);
      activeSetups.delete(key);
      outputs.push(candidate);

      if (config.oneCandidatePerSetup) break;
    }

    return outputs;
  };
}

function selectBosReferenceForCachedState({ method, direction, m15Swings, reactionConfirmationIndex, pullbackReferenceSwing }) {
  const type = direction === "BUY" ? "HIGH" : "LOW";
  let reference = null;
  if (method === "B3_PULLBACK_SEQUENCE_HIGH_LOW") {
    if (pullbackReferenceSwing && pullbackReferenceSwing.type === type && pullbackReferenceSwing.timeframe === "M15" && pullbackReferenceSwing.confirmationIndex <= reactionConfirmationIndex) reference = pullbackReferenceSwing;
  } else {
    for (const swing of m15Swings) {
      if (swing.timeframe === "M15" && swing.type === type && swing.confirmed === true && swing.confirmationIndex <= reactionConfirmationIndex) reference = swing;
    }
  }
  return { valid: reference !== null, method, direction, reference };
}

function findFirstBosConfirmation(direction, reference, candles, startIndex, currentIndex) {
  for (let i = startIndex; i <= currentIndex; i++) {
    const candle = candles[i];
    if (!candle || candle.isComplete === false) continue;
    const closeBreak = direction === "BUY" ? candle.close > reference.price : candle.close < reference.price;
    if (closeBreak) return i;
  }
  return null;
}
