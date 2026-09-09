import { calculateWilderATR } from "./atr.js";

export const DEFAULT_ZONE_CONFIG = Object.freeze({
  displacementMethod: "D2_ATR_RANGE",
  displacementParameter: 1.0,
  maxBarsAfterSwing: 3,
  atrPeriod: 14
});

export function getZoneType(swing) {
  return swing.type === "LOW" ? "DEMAND" : "SUPPLY";
}

function displacementValue(candles, swing, index, method, parameter, atrPeriod) {
  const candle = candles[index];
  if (!candle) return { qualifies: false, value: 0 };
  const high = Number(candle.high), low = Number(candle.low), open = Number(candle.open), close = Number(candle.close), swingPrice = Number(swing.price);
  const direction = swing.type === "LOW" ? "BULLISH" : "BEARISH";
  if (direction === "BULLISH" && close <= swingPrice) return { qualifies: false, value: 0 };
  if (direction === "BEARISH" && close >= swingPrice) return { qualifies: false, value: 0 };
  const range = high - low, body = Math.abs(close - open), closeFromSwing = Math.abs(close - swingPrice);
  if (method === "D1_FIXED_RANGE") return { qualifies: range >= parameter, value: range };
  const atr = calculateWilderATR(candles, atrPeriod, index)?.valueInPriceUnits;
  if (!atr || atr <= 0) return { qualifies: false, value: method === "D3_ATR_BODY" ? body : method === "D4_ATR_CLOSE_FROM_SWING" ? closeFromSwing : range };
  if (method === "D2_ATR_RANGE") return { qualifies: range >= atr * parameter, value: range };
  if (method === "D3_ATR_BODY") return { qualifies: body >= atr * parameter, value: body };
  if (method === "D4_ATR_CLOSE_FROM_SWING") return { qualifies: closeFromSwing >= atr * parameter, value: closeFromSwing };
  throw new Error(`Unknown displacement method: ${method}`);
}

export function findFirstQualifyingDisplacement(candles, swing, currentClosedIndex, config) {
  if (swing.timeframe !== "H4" || swing.confirmationIndex > currentClosedIndex) return null;
  const lastIndex = Math.min(currentClosedIndex, swing.candleIndex + config.maxBarsAfterSwing);
  for (let index = swing.candleIndex + 1; index <= lastIndex; index++) {
    if (!candles[index]?.isComplete) continue;
    const result = displacementValue(candles, swing, index, config.displacementMethod, config.displacementParameter, config.atrPeriod);
    if (result.qualifies) return { index, value: result.value };
  }
  return null;
}

function initialStatus(candles, createdIndex, currentClosedIndex, zone) {
  let status = "VALID", firstTouchTimestamp, invalidationTimestamp;
  for (let index = createdIndex + 1; index <= currentClosedIndex; index++) {
    const candle = candles[index];
    if (!candle?.isComplete) continue;
    const invalidated = zone.type === "DEMAND" ? candle.close < zone.zoneLow : candle.close > zone.zoneHigh;
    if (invalidated) { status = "INVALIDATED"; invalidationTimestamp = candle.timestampClose; break; }
    const overlaps = candle.high >= zone.zoneLow && candle.low <= zone.zoneHigh;
    if (overlaps && firstTouchTimestamp === undefined) { firstTouchTimestamp = candle.timestampOpen; status = "TOUCHED"; }
  }
  return { status, ...(firstTouchTimestamp === undefined ? {} : { firstTouchTimestamp }), ...(invalidationTimestamp === undefined ? {} : { invalidationTimestamp }) };
}

export function createZoneFromSwing(candles, swing, currentClosedIndex, config = DEFAULT_ZONE_CONFIG) {
  if (swing.timeframe !== "H4") return null;
  const sourceCandle = candles[swing.candleIndex];
  if (!sourceCandle) return null;
  const displacement = findFirstQualifyingDisplacement(candles, swing, currentClosedIndex, config);
  if (!displacement) return null;
  const base = {
    id: `${swing.id}-ZONE-${config.displacementMethod}-${displacement.index}`,
    type: getZoneType(swing),
    sourceSwing: swing,
    zoneHigh: sourceCandle.high,
    zoneLow: sourceCandle.low,
    createdTimestamp: candles[displacement.index].timestampClose,
    createdCandleIndex: displacement.index,
    displacementCandleIndex: displacement.index,
    displacementMethod: config.displacementMethod,
    displacementParameter: config.displacementParameter,
    displacementValueInPriceUnits: displacement.value,
    status: "VALID"
  };
  return { ...base, ...initialStatus(candles, displacement.index, currentClosedIndex, base) };
}

const h4ZoneCache = new WeakMap();

function zoneConfigKey(config) {
  return `${config.displacementMethod}:${config.displacementParameter}:${config.maxBarsAfterSwing}:${config.atrPeriod}`;
}

function cloneZone(zone) {
  const { lastCheckedIndex, firstTouchTimestamp, invalidationTimestamp, ...publicZone } = zone;
  return {
    ...publicZone,
    sourceSwing: zone.sourceSwing ? { ...zone.sourceSwing } : zone.sourceSwing,
    ...(firstTouchTimestamp === undefined ? {} : { firstTouchTimestamp }),
    ...(invalidationTimestamp === undefined ? {} : { invalidationTimestamp })
  };
}

function advanceZoneStatus(candles, state, currentClosedIndex) {
  if (state.status === "INVALIDATED" || state.lastCheckedIndex >= currentClosedIndex) return;
  const start = Math.max(state.lastCheckedIndex + 1, state.createdCandleIndex + 1);
  for (let index = start; index <= currentClosedIndex; index++) {
    const candle = candles[index];
    if (!candle?.isComplete) continue;
    const invalidated = state.type === "DEMAND"
      ? candle.close < state.zoneLow
      : candle.close > state.zoneHigh;
    if (invalidated) {
      state.status = "INVALIDATED";
      state.invalidationTimestamp = candle.timestampClose;
      state.lastCheckedIndex = index;
      return;
    }
    const overlaps = candle.high >= state.zoneLow && candle.low <= state.zoneHigh;
    if (overlaps && state.firstTouchTimestamp === undefined) {
      state.firstTouchTimestamp = candle.timestampOpen;
      state.status = "TOUCHED";
    }
    state.lastCheckedIndex = index;
  }
  state.lastCheckedIndex = Math.max(state.lastCheckedIndex, currentClosedIndex);
}

export function getH4Zones(candles, confirmedSwings, currentClosedIndex, config = DEFAULT_ZONE_CONFIG) {
  let byConfig = h4ZoneCache.get(candles);
  if (!byConfig) {
    byConfig = new Map();
    h4ZoneCache.set(candles, byConfig);
  }
  const key = zoneConfigKey(config);
  let byIndex = byConfig.get(key);
  if (!byIndex) {
    byIndex = { zonesById: new Map(), lastIndex: -1, snapshots: new Map() };
    byConfig.set(key, byIndex);
  }

  const snapshot = byIndex.snapshots.get(currentClosedIndex);
  if (snapshot) return snapshot;

  // Add any newly visible zones. A zone's geometry becomes fixed once its
  // first qualifying displacement has occurred; its status is then advanced
  // monotonically through the newly closed H4 candles. This is an exact
  // incremental form of createZoneFromSwing()+initialStatus().
  for (const swing of confirmedSwings) {
    if (swing.timeframe !== "H4" || swing.confirmationIndex > currentClosedIndex) continue;
    if (byIndex.zonesById.has(swing.id)) continue;
    const zone = createZoneFromSwing(candles, swing, currentClosedIndex, config);
    if (!zone) continue;
    byIndex.zonesById.set(zone.id, {
      ...zone,
      firstTouchTimestamp: zone.firstTouchTimestamp,
      invalidationTimestamp: zone.invalidationTimestamp,
      lastCheckedIndex: currentClosedIndex
    });
  }

  // The creation pass above may have discovered a zone at an earlier
  // displacement index while currentClosedIndex is later; createZoneFromSwing
  // already computed its status exactly for that first appearance. From then
  // on, only newly added H4 bars need checking.
  for (const state of byIndex.zonesById.values()) {
    if (state.lastCheckedIndex < currentClosedIndex) advanceZoneStatus(candles, state, currentClosedIndex);
  }

  byIndex.lastIndex = Math.max(byIndex.lastIndex, currentClosedIndex);
  const result = [...byIndex.zonesById.values()]
    .filter(z => z.createdCandleIndex <= currentClosedIndex)
    .sort((a, b) => a.createdCandleIndex - b.createdCandleIndex)
    .map(cloneZone);
  byIndex.snapshots.set(currentClosedIndex, result);
  return result;
}

export function isPriceAtZone(candle, zone) {
  return candle.high >= zone.zoneLow && candle.low <= zone.zoneHigh;
}
