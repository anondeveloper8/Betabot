/**
 * Free-tier Twelve Data adapter for EUR/USD signal generation.
 *
 * Security contract:
 *   - API key is server-side only.
 *   - No provider key is ever returned to the browser.
 *   - Only completed M15 candles are passed to the strategy.
 *
 * Data contract:
 *   - M15 and H4 timestamps are normalized to UTC epoch milliseconds.
 *   - H4 bars are allowed to be incomplete because the existing strategy uses
 *     the currently-forming H4 candle only for location; H4 structure/zones
 *     are derived only from completed H4 candles downstream.
 */

const BASE_URL = 'https://api.twelvedata.com';
const M15_LIMIT = 5000;
const REQUIRED_M15_BARS = 9000;
const H4_LIMIT = 1000;
const FIFTEEN_MIN_MS = 15 * 60_000;
const FOUR_HOUR_MS = 4 * 60 * 60_000;

function providerError(message, details = {}) {
  const error = new Error(message);
  error.statusCode = details.statusCode ?? 502;
  error.code = details.code ?? 'MARKET_DATA_ERROR';
  error.details = details;
  return error;
}

function assertApiKey() {
  if (!process.env.TWELVEDATA_API_KEY) {
    throw providerError('TWELVEDATA_API_KEY is not configured', { statusCode: 503, code: 'CONFIG_MISSING' });
  }
}

function timestampFromValue(value) {
  if (Number.isFinite(Number(value))) return Number(value) * 1000;
  if (typeof value !== 'string') return NaN;
  const parsed = Date.parse(value.endsWith('Z') ? value : `${value}Z`);
  return parsed;
}

function normalizeValue(raw, intervalMs, nowMs) {
  const timestampOpen = timestampFromValue(raw.timestamp ?? raw.datetime);
  if (!Number.isFinite(timestampOpen)) return null;

  const open = Number(raw.open);
  const high = Number(raw.high);
  const low = Number(raw.low);
  const close = Number(raw.close);
  if (![open, high, low, close].every(Number.isFinite) || open <= 0 || high <= 0 || low <= 0 || close <= 0) return null;
  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) return null;

  const timestampClose = timestampOpen + intervalMs;
  return {
    timestampOpen,
    timestampClose,
    open: raw.open,
    high: raw.high,
    low: raw.low,
    close: raw.close,
    isComplete: timestampClose <= nowMs
  };
}

async function tdJson(path, params) {
  assertApiKey();
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  url.searchParams.set('apikey', process.env.TWELVEDATA_API_KEY);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.status === 'error') {
      throw providerError(body?.message || `Twelve Data request failed (${response.status})`, {
        statusCode: 502,
        providerStatus: response.status,
        providerBody: body
      });
    }
    return body;
  } catch (error) {
    if (error.name === 'AbortError') throw providerError('Twelve Data request timed out', { code: 'UPSTREAM_TIMEOUT' });
    if (error.statusCode) throw error;
    throw providerError(`Twelve Data request failed: ${error.message}`, { code: 'UPSTREAM_NETWORK_ERROR' });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeSeries(body, intervalMs, nowMs) {
  if (!Array.isArray(body?.values)) throw providerError('Twelve Data returned no values', { code: 'UPSTREAM_EMPTY' });
  return body.values
    .map((row) => normalizeValue(row, intervalMs, nowMs))
    .filter(Boolean)
    .sort((a, b) => a.timestampOpen - b.timestampOpen)
    .filter((bar, index, bars) => index === 0 || bar.timestampOpen !== bars[index - 1].timestampOpen);
}

async function fetchM15Block({ outputsize, endDate } = {}) {
  const params = {
    symbol: 'EUR/USD',
    interval: '15min',
    outputsize: outputsize ?? M15_LIMIT,
    timezone: 'UTC'
  };
  if (endDate) params.end_date = endDate;
  return normalizeSeries(await tdJson('/time_series', params), FIFTEEN_MIN_MS, Date.now());
}

function utcDateTime(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 19).replace('T', ' ');
}

async function fetchM15History() {
  const newest = await fetchM15Block({ outputsize: M15_LIMIT });
  if (newest.length === 0) throw providerError('No M15 EUR/USD history returned', { code: 'UPSTREAM_EMPTY' });

  const oldest = newest[0];
  const olderEnd = oldest.timestampOpen - FIFTEEN_MIN_MS;
  const older = await fetchM15Block({ outputsize: M15_LIMIT, endDate: utcDateTime(olderEnd) });

  const merged = [...older, ...newest]
    .sort((a, b) => a.timestampOpen - b.timestampOpen)
    .filter((bar, index, bars) => index === 0 || bar.timestampOpen !== bars[index - 1].timestampOpen);

  if (merged.length < REQUIRED_M15_BARS) {
    throw providerError(`Insufficient M15 history: received ${merged.length}, need at least ${REQUIRED_M15_BARS}`, {
      code: 'INSUFFICIENT_HISTORY',
      receivedBars: merged.length,
      requiredBars: REQUIRED_M15_BARS
    });
  }

  return merged;
}

async function fetchH4History() {
  const body = await tdJson('/time_series', {
    symbol: 'EUR/USD',
    interval: '4h',
    outputsize: H4_LIMIT,
    timezone: 'UTC'
  });
  return normalizeSeries(body, FOUR_HOUR_MS, Date.now());
}

async function fetchReferencePrice() {
  const body = await tdJson('/price', { symbol: 'EUR/USD' });
  const price = Number(body?.price);
  if (!Number.isFinite(price) || price <= 0) throw providerError('Twelve Data returned an invalid EUR/USD price', { code: 'UPSTREAM_INVALID_PRICE' });
  return price;
}

function isWeekend(nowMs) {
  const day = new Date(nowMs).getUTCDay();
  return day === 0 || day === 6;
}

export async function fetchLiveMarketData() {
  const nowMs = Date.now();
  const [m15, h4, referencePrice] = await Promise.all([
    fetchM15History(),
    fetchH4History(),
    fetchReferencePrice()
  ]);

  const completeM15 = m15.filter((bar) => bar.isComplete);
  if (completeM15.length === 0) throw providerError('No completed M15 candle available', { code: 'NO_COMPLETED_M15' });

  const latestM15 = completeM15.at(-1);
  const ageMs = nowMs - latestM15.timestampClose;
  const maxFreshMs = 30 * 60_000;
  const stale = !isWeekend(nowMs) && ageMs > maxFreshMs;

  return Object.freeze({
    symbol: 'EURUSD',
    m15: completeM15.slice(-REQUIRED_M15_BARS),
    h4,
    referencePrice,
    latestM15TimestampOpen: latestM15.timestampOpen,
    latestM15TimestampClose: latestM15.timestampClose,
    latestM15AgeSeconds: Math.max(0, Math.round(ageMs / 1000)),
    stale,
    dataSource: 'Twelve Data',
    dataSourcePlan: 'Basic Free'
  });
}
