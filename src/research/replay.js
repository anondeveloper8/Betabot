/**
 * Stage 38 — look-ahead-safe chronological replay adapter.
 *
 * The upstream candidate detector is supplied by the caller. The replay layer
 * guarantees that it is called once per completed M15 candle and receives only
 * H4 candles whose CLOSE is already known at that M15 close. It does not infer
 * signals, repair data, or execute live orders.
 */

import { getConfirmedSwings } from "../../engine/swings.js";
import { evaluateH4Context } from "../../engine/context.js";
import { h4VisibleAtM15Close } from "./dataset.js";
import { runHistoricalCandidates } from "../backtest-runner.js";

function assertIndex(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
}

function candidateUsesFutureM15(candidate, currentIndex, m15Candles) {
  const bosIndex = candidate?.bos?.confirmationIndex;
  if (Number.isInteger(bosIndex) && bosIndex > currentIndex) return true;
  const timestamps = [
    candidate?.bos?.confirmationTimestamp,
    candidate?.reaction?.confirmationTimestamp,
    candidate?.pullback?.confirmationTimestamp,
    candidate?.location?.timestamp
  ].filter(v => Number.isFinite(v));
  return timestamps.some(ts => ts > m15Candles[currentIndex].timestampClose);
}

export function replayChronologically({
  dataset,
  alignment,
  runnerOptions,
  candidateDetector,
  startM15Index = 0,
  endM15Index = null,
  includeEmptySteps = true,
  buildCommonContext = true
}) {
  if (!dataset?.m15Candles || !dataset?.h4Candles) throw new Error("adapted dataset is required.");
  if (!alignment?.valid) throw new Error("timeframe alignment must be valid before replay.");
  if (typeof candidateDetector !== "function") throw new Error("candidateDetector function is required.");
  assertIndex(startM15Index, "startM15Index");
  const lastIndex = endM15Index === null ? dataset.m15Candles.length - 1 : endM15Index;
  if (!Number.isInteger(lastIndex) || lastIndex < startM15Index || lastIndex >= dataset.m15Candles.length) throw new Error("Invalid endM15Index.");

  const steps = [];
  const candidates = [];
  const audit = [];

  for (let i = startM15Index; i <= lastIndex; i++) {
    const m15 = dataset.m15Candles[i];
    if (m15.isComplete === false) {
      audit.push(Object.freeze({ m15Index: i, status: "UNTESTABLE_PERIOD", reason: "INCOMPLETE_M15_CANDLE" }));
      continue;
    }

    const visibleH4 = h4VisibleAtM15Close(dataset.h4Candles, m15);
    const visibleH4Swings = buildCommonContext ? getConfirmedSwings(visibleH4, visibleH4.length - 1) : [];
    const h4Context = buildCommonContext
      ? evaluateH4Context(visibleH4Swings, m15.timestampClose)
      : null;

    const stepInput = Object.freeze({
      m15Index: i,
      m15Candle: m15,
      visibleH4Candles: visibleH4,
      h4Context,
      alignmentH4Index: alignment.m15ToH4Index[i]
    });

    const detected = candidateDetector(stepInput);
    const stepCandidates = detected == null ? [] : (Array.isArray(detected) ? detected : [detected]);
    const safeCandidates = [];

    for (const candidate of stepCandidates) {
      if (!candidate || typeof candidate !== "object") throw new Error("candidateDetector returned an invalid candidate.");
      if (candidateUsesFutureM15(candidate, i, dataset.m15Candles)) {
        audit.push(Object.freeze({ m15Index: i, status: "REJECTED_CANDIDATE", reason: "LOOKAHEAD_DETECTED", setupId: candidate.setupId ?? null }));
        continue;
      }
      if (candidate.bos?.confirmationTimestamp && candidate.bos.confirmationTimestamp > m15.timestampClose) {
        audit.push(Object.freeze({ m15Index: i, status: "REJECTED_CANDIDATE", reason: "LOOKAHEAD_DETECTED", setupId: candidate.setupId ?? null }));
        continue;
      }
      safeCandidates.push({ ...candidate, detectorIndex: i });
      candidates.push({ ...candidate, detectorIndex: i });
    }

    if (includeEmptySteps || safeCandidates.length > 0) {
      steps.push(Object.freeze({
        m15Index: i,
        timestampClose: m15.timestampClose,
        visibleH4Count: visibleH4.length,
        h4Context,
        candidatesDetected: safeCandidates.length
      }));
    }
  }

  // Candidate order is chronological; the historical runner may sort again by
  // BOS confirmation time, but it never receives future data from the detector.
  const backtest = runHistoricalCandidates({
    candidates,
    runnerOptions,
    onePositionOnly: runnerOptions.onePositionOnly ?? true
  });

  return Object.freeze({
    datasetValidation: dataset.validation,
    alignment,
    startM15Index,
    endM15Index: lastIndex,
    steps: Object.freeze(steps),
    detectorAudit: Object.freeze(audit),
    candidatesDetected: candidates.length,
    backtest
  });
}
