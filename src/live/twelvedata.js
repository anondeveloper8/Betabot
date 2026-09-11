/**
 * Server-side Twelve Data adapter for EUR/USD signal generation.
 *
 * Historical candles are persisted in Supabase and refreshed incrementally.
 * The strategy still receives the same analytical window: 9,000 completed
 * M15 candles plus the latest 1,000 H4 candles.
 */

import { refreshMarketCache } from './market-cache.js';

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
    throw providerError(
      'TWELVEDATA_API_KEY is not configured',
      {
        statusCode: 503,
        code: 'CONFIG_MISSING'
      }
    );
  }
}

function timestampFromValue(value) {
  if (Number.isFinite(Number(value))) {
    return Number(value) * 1000;
  }

  if (typeof value !== 'string') {
    return NaN;
  }

  return Date.parse(
    value.endsWith('Z') ? value : `${value}Z`
  );
}

function normalizeValue(
  raw,
  intervalMs,
  nowMs
) {
  const timestampOpen = timestampFromValue(
    raw.timestamp ?? raw.datetime
  );

  if (!Number.isFinite(timestampOpen)) {
    return null;
  }

  const open = Number(raw.open);
  const high = Number(raw.high);
  const low = Number(raw.low);
  const close = Number(raw.close);

  if (
    ![open, high, low, close].every(Number.isFinite) ||
    open <= 0 ||
    high <= 0 ||
    low <= 0 ||
    close <= 0
  ) {
    return null;
  }

  if (
    high < Math.max(open, close) ||
    low > Math.min(open, close) ||
    high < low
  ) {
    return null;
  }

  const timestampClose =
    timestampOpen + intervalMs;

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

  const url = new URL(
    `${BASE_URL}${path}`
  );

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(
      key,
      String(value)
    );
  }

  url.searchParams.set(
    'apikey',
    process.env.TWELVEDATA_API_KEY
  );

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    20_000
  );

  try {
    const response = await fetch(
      url,
      {
        signal: controller.signal,
        headers: {
          accept: 'application/json'
        }
      }
    );

    const rawBody =
      await response.text();

    let body = null;

    try {
      body = rawBody
        ? JSON.parse(rawBody)
        : null;
    } catch {
      throw providerError(
        `Twelve Data returned non-JSON response (${response.status})`,
        {
          statusCode: 502,
          providerStatus: response.status,
          providerBodyPreview:
            rawBody.slice(0, 500)
        }
      );
    }

    if (
      !response.ok ||
      !body ||
      body.status === 'error'
    ) {
      throw providerError(
        body?.message ||
          `Twelve Data request failed (${response.status})`,
        {
          statusCode: 502,
          providerStatus: response.status,
          providerBody: body
        }
      );
    }

    return body;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw providerError(
        'Twelve Data request timed out',
        {
          code: 'UPSTREAM_TIMEOUT'
        }
      );
    }

    if (error.statusCode) {
      throw error;
    }

    throw providerError(
      `Twelve Data request failed: ${error.message}`,
      {
        code: 'UPSTREAM_NETWORK_ERROR'
      }
    );
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeSeries(
  body,
  intervalMs,
  nowMs
) {
  if (!Array.isArray(body?.values)) {
    throw providerError(
      'Twelve Data returned no values',
      {
        code: 'UPSTREAM_EMPTY'
      }
    );
  }

  return body.values
    .map((row) =>
      normalizeValue(
        row,
        intervalMs,
        nowMs
      )
    )
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.timestampOpen -
        b.timestampOpen
    )
    .filter(
      (bar, index, bars) =>
        index === 0 ||
        bar.timestampOpen !==
          bars[index - 1].timestampOpen
    );
}

export async function fetchM15Block({
  outputsize = M15_LIMIT
} = {}) {
  return normalizeSeries(
    await tdJson(
      '/time_series',
      {
        symbol: 'EUR/USD',
        interval: '15min',
        outputsize,
        timezone: 'UTC'
      }
    ),
    FIFTEEN_MIN_MS,
    Date.now()
  );
}

export async function fetchM15Bootstrap() {
  const newest = await fetchM15Block({
    outputsize: M15_LIMIT
  });

  if (!newest.length) {
    throw providerError(
      'No M15 EUR/USD history returned',
      {
        code: 'UPSTREAM_EMPTY'
      }
    );
  }

  const oldest = newest[0];

  const olderEnd = new Date(
    oldest.timestampOpen -
      FIFTEEN_MIN_MS
  )
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  const older = normalizeSeries(
    await tdJson(
      '/time_series',
      {
        symbol: 'EUR/USD',
        interval: '15min',
        outputsize: M15_LIMIT,
        end_date: olderEnd,
        timezone: 'UTC'
      }
    ),
    FIFTEEN_MIN_MS,
    Date.now()
  );

  const merged = [
    ...older,
    ...newest
  ]
    .sort(
      (a, b) =>
        a.timestampOpen -
        b.timestampOpen
    )
    .filter(
      (bar, index, bars) =>
        index === 0 ||
        bar.timestampOpen !==
          bars[index - 1].timestampOpen
    );

  if (
    merged.filter(
      (bar) => bar.isComplete
    ).length < REQUIRED_M15_BARS
  ) {
    throw providerError(
      `Insufficient M15 history: received ${merged.length}, need at least ${REQUIRED_M15_BARS}`,
      {
        code: 'INSUFFICIENT_HISTORY',
        receivedBars: merged.length,
        requiredBars:
          REQUIRED_M15_BARS
      }
    );
  }

  return merged;
}

export async function fetchM15Recent(
  outputsize = 2000
) {
  return fetchM15Block({
    outputsize
  });
}

export async function fetchH4(
  outputsize = H4_LIMIT
) {
  return normalizeSeries(
    await tdJson(
      '/time_series',
      {
        symbol: 'EUR/USD',
        interval: '4h',
        outputsize,
        timezone: 'UTC'
      }
    ),
    FOUR_HOUR_MS,
    Date.now()
  );
}

export async function fetchReferencePrice() {
  const body = await tdJson(
    '/price',
    {
      symbol: 'EUR/USD'
    }
  );

  const price = Number(body?.price);

  if (
    !Number.isFinite(price) ||
    price <= 0
  ) {
    throw providerError(
      'Twelve Data returned an invalid EUR/USD price',
      {
        code:
          'UPSTREAM_INVALID_PRICE'
      }
    );
  }

  return price;
}

function isWeekend(nowMs) {
  const day =
    new Date(nowMs).getUTCDay();

  return day === 0 || day === 6;
}

export async function fetchLiveMarketData() {
  const nowMs = Date.now();

  const cached =
    await refreshMarketCache({
      fetchM15Bootstrap,
      fetchM15Recent,
      fetchH4,
      fetchReferencePrice
    });

  const completeM15 =
    cached.m15.filter(
      (bar) => bar.isComplete
    );

  if (
    completeM15.length <
    REQUIRED_M15_BARS
  ) {
    throw providerError(
      `Market cache returned insufficient completed M15 history: ${completeM15.length}`,
      {
        code:
          'INSUFFICIENT_HISTORY',
        receivedBars:
          completeM15.length,
        requiredBars:
          REQUIRED_M15_BARS
      }
    );
  }

  const latestM15 =
    completeM15.at(-1);

  const ageMs =
    nowMs -
    latestM15.timestampClose;

  const maxFreshMs =
    30 * 60_000;

  const stale =
    !isWeekend(nowMs) &&
    ageMs > maxFreshMs;

  return Object.freeze({
    symbol: 'EURUSD',
    m15:
      completeM15.slice(
        -REQUIRED_M15_BARS
      ),
    h4: cached.h4,
    referencePrice:
      cached.referencePrice,
    latestM15TimestampOpen:
      latestM15.timestampOpen,
    latestM15TimestampClose:
      latestM15.timestampClose,
    latestM15AgeSeconds:
      Math.max(
        0,
        Math.round(
          ageMs / 1000
        )
      ),
    stale,
    dataSource: 'Twelve Data',
    dataSourcePlan: 'Basic Free',
    cacheBacked: true,
    cacheBootstrapped:
      cached.bootstrapped
  });
}
