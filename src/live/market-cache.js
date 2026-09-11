/**
 * Persistent server-side market-data cache backed by Supabase Postgres.
 *
 * The cache stores normalized candles and returns the analytical window
 * required by the existing strategy. It contains no strategy logic.
 */

const SYMBOL = 'EURUSD';
const M15 = 'M15';
const H4 = 'H4';

const REQUIRED_M15 = 9000;
const REQUIRED_H4 = 1000;

const M15_INCREMENTAL = 2000;
const H4_INCREMENTAL = 300;

const M15_MS = 15 * 60_000;
const H4_MS = 4 * 60 * 60_000;

const CACHE_PATH = '/rest/v1/market_data_candles';
const STATE_PATH = '/rest/v1/market_data_state';
const WINDOW_RPC = '/rest/v1/rpc/get_market_data_window';

function cacheError(message, details = {}) {
  const error = new Error(message);

  error.statusCode = details.statusCode ?? 502;
  error.code = details.code ?? 'MARKET_CACHE_ERROR';
  error.details = details;

  return error;
}

function config() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!url || !key) {
    throw cacheError(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required',
      {
        statusCode: 503,
        code: 'CONFIG_MISSING'
      }
    );
  }

  return { url, key };
}

async function db(
  path,
  {
    method = 'GET',
    body = undefined,
    headers = {},
    timeoutMs = 15_000
  } = {}
) {
  const { url, key } = config();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${url}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    const text = await response.text();

    let payload = null;

    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }

    if (!response.ok) {
      throw cacheError(
        `Supabase cache request failed (${response.status})`,
        {
          statusCode: 502,
          code: 'CACHE_DATABASE_ERROR',
          databaseStatus: response.status,
          databaseBody: payload
        }
      );
    }

    return {
      payload,
      headers: response.headers
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw cacheError(
        'Supabase cache request timed out',
        { code: 'CACHE_DATABASE_TIMEOUT' }
      );
    }

    if (error.statusCode) {
      throw error;
    }

    throw cacheError(
      `Supabase cache request failed: ${error.message}`,
      { code: 'CACHE_DATABASE_NETWORK_ERROR' }
    );
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCachedBar(row) {
  if (!row) {
    return null;
  }

  const timestampOpen = Number(
    row.timestamp_open ?? row.timestampOpen
  );

  const timestampClose = Number(
    row.timestamp_close ?? row.timestampClose
  );

  const open = Number(row.open);
  const high = Number(row.high);
  const low = Number(row.low);
  const close = Number(row.close);

  if (
    !Number.isFinite(timestampOpen) ||
    !Number.isFinite(timestampClose)
  ) {
    return null;
  }

  if (![open, high, low, close].every(Number.isFinite)) {
    return null;
  }

  return {
    timestampOpen,
    timestampClose,
    open: String(row.open),
    high: String(row.high),
    low: String(row.low),
    close: String(row.close),
    isComplete: Boolean(
      row.is_complete ?? row.isComplete
    )
  };
}

async function readState() {
  const { payload } = await db(
    `${STATE_PATH}?symbol=eq.${SYMBOL}` +
      '&select=symbol,m15_latest_open,h4_latest_open&limit=1',
    {
      headers: {
        Accept: 'application/json'
      }
    }
  );

  return Array.isArray(payload)
    ? payload[0] ?? null
    : null;
}

async function upsertBars(timeframe, bars) {
  if (!bars.length) {
    return;
  }

  const rows = bars.map((bar) => ({
    symbol: SYMBOL,
    timeframe,
    timestamp_open: bar.timestampOpen,
    timestamp_close: bar.timestampClose,
    open: String(bar.open),
    high: String(bar.high),
    low: String(bar.low),
    close: String(bar.close),
    is_complete: Boolean(bar.isComplete),
    updated_at: new Date().toISOString()
  }));

  await db(`${CACHE_PATH}?on_conflict=symbol,timeframe,timestamp_open`, {
    method: 'POST',
    body: rows,
    headers: {
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    timeoutMs: 20_000
  });
}

async function writeState(
  m15LatestOpen,
  h4LatestOpen
) {
  await db(`${STATE_PATH}?on_conflict=symbol`, {
    method: 'POST',
    body: [
      {
        symbol: SYMBOL,
        m15_latest_open: m15LatestOpen,
        h4_latest_open: h4LatestOpen,
        updated_at: new Date().toISOString()
      }
    ],
    headers: {
      Prefer: 'resolution=merge-duplicates,return=minimal'
    }
  });
}

function barsGapTooLarge(
  state,
  latestM15Open,
  latestH4Open
) {
  if (!state) {
    return true;
  }

  const m15Gap =
    (
      latestM15Open -
      Number(state.m15_latest_open || latestM15Open)
    ) / M15_MS;

  const h4Gap =
    (
      latestH4Open -
      Number(state.h4_latest_open || latestH4Open)
    ) / H4_MS;

  return (
    m15Gap > M15_INCREMENTAL - 100 ||
    h4Gap > H4_INCREMENTAL - 20
  );
}

async function readWindow() {
  const { payload } = await db(WINDOW_RPC, {
    method: 'POST',
    body: {
      p_symbol: SYMBOL,
      p_m15_limit: REQUIRED_M15,
      p_h4_limit: REQUIRED_H4
    },
    headers: {
      Accept: 'application/json'
    },
    timeoutMs: 20_000
  });

  const value = Array.isArray(payload)
    ? payload[0]
    : payload;

  const m15 = Array.isArray(value?.m15)
    ? value.m15
        .map(normalizeCachedBar)
        .filter(Boolean)
    : [];

  const h4 = Array.isArray(value?.h4)
    ? value.h4
        .map(normalizeCachedBar)
        .filter(Boolean)
    : [];

  return { m15, h4 };
}

export function validateMarketCacheWindow(window) {
  const m15 = Array.isArray(window?.m15)
    ? window.m15
    : [];

  const h4 = Array.isArray(window?.h4)
    ? window.h4
    : [];

  if (m15.length < REQUIRED_M15) {
    return {
      valid: false,
      reason: 'INSUFFICIENT_M15_CACHE',
      m15: m15.length,
      h4: h4.length
    };
  }

  if (h4.length < REQUIRED_H4) {
    return {
      valid: false,
      reason: 'INSUFFICIENT_H4_CACHE',
      m15: m15.length,
      h4: h4.length
    };
  }

  if (!m15.every((bar) => bar.isComplete)) {
    return {
      valid: false,
      reason: 'INCOMPLETE_M15_IN_WINDOW',
      m15: m15.length,
      h4: h4.length
    };
  }

  return {
    valid: true,
    m15: m15.length,
    h4: h4.length
  };
}

export async function refreshMarketCache({
  fetchM15Bootstrap,
  fetchM15Recent,
  fetchH4,
  fetchReferencePrice
}) {
  const state = await readState();

  let m15;
  let h4;
  let referencePrice;

  let latestM15Open;
  let latestH4Open;

  let bootstrapped = false;

  if (!state) {
    const [
      bootstrapM15,
      bootstrapH4,
      price
    ] = await Promise.all([
      fetchM15Bootstrap(),
      fetchH4(REQUIRED_H4),
      fetchReferencePrice()
    ]);

    m15 = bootstrapM15;
    h4 = bootstrapH4;
    referencePrice = price;

    latestM15Open =
      m15.at(-1)?.timestampOpen;

    latestH4Open =
      h4.at(-1)?.timestampOpen;

    bootstrapped = true;
  } else {
    const recent = await Promise.all([
      fetchM15Recent(M15_INCREMENTAL),
      fetchH4(H4_INCREMENTAL),
      fetchReferencePrice()
    ]);

    m15 = recent[0];
    h4 = recent[1];
    referencePrice = recent[2];

    latestM15Open =
      m15.at(-1)?.timestampOpen;

    latestH4Open =
      h4.at(-1)?.timestampOpen;

    if (
      !Number.isFinite(latestM15Open) ||
      !Number.isFinite(latestH4Open)
    ) {
      throw cacheError(
        'Incremental provider response did not contain usable latest candles',
        { code: 'CACHE_PROVIDER_INVALID' }
      );
    }

    if (
      barsGapTooLarge(
        state,
        latestM15Open,
        latestH4Open
      )
    ) {
      const [
        bootstrapM15,
        bootstrapH4
      ] = await Promise.all([
        fetchM15Bootstrap(),
        fetchH4(REQUIRED_H4)
      ]);

      m15 = [
        ...bootstrapM15,
        ...m15
      ];

      h4 = [
        ...bootstrapH4,
        ...h4
      ];

      bootstrapped = true;
    }
  }

  if (
    !Number.isFinite(latestM15Open) ||
    !Number.isFinite(latestH4Open)
  ) {
    throw cacheError(
      'Provider response did not contain usable latest candles',
      { code: 'CACHE_PROVIDER_INVALID' }
    );
  }

  await Promise.all([
    upsertBars(M15, m15),
    upsertBars(H4, h4)
  ]);

  const stateM15Open = Math.max(
    Number(state?.m15_latest_open || 0),
    latestM15Open
  );

  const stateH4Open = Math.max(
    Number(state?.h4_latest_open || 0),
    latestH4Open
  );

  await writeState(
    stateM15Open,
    stateH4Open
  );

  let window = await readWindow();

  let validation =
    validateMarketCacheWindow(window);

  if (!validation.valid) {
    const [
      bootstrapM15,
      bootstrapH4
    ] = await Promise.all([
      fetchM15Bootstrap(),
      fetchH4(REQUIRED_H4)
    ]);

    await Promise.all([
      upsertBars(M15, bootstrapM15),
      upsertBars(H4, bootstrapH4)
    ]);

    window = await readWindow();

    validation =
      validateMarketCacheWindow(window);
  }

  if (!validation.valid) {
    throw cacheError(
      `Market cache validation failed: ${validation.reason}`,
      {
        code: validation.reason,
        m15: validation.m15,
        h4: validation.h4
      }
    );
  }

  return Object.freeze({
    ...window,
    referencePrice,
    bootstrapped
  });
}

export const MARKET_CACHE_CONFIG =
  Object.freeze({
    requiredM15: REQUIRED_M15,
    requiredH4: REQUIRED_H4,
    incrementalM15: M15_INCREMENTAL,
    incrementalH4: H4_INCREMENTAL
  });
