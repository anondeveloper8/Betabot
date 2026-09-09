/**
 * POST /api/live-scan or GET /api/live-scan
 *
 * Protected signal scanner. It fetches free-tier EUR/USD data, runs the exact
 * shared strategy decision function, and records one immutable signal event
 * per M15 close/setup. It has NO trade execution capability.
 */

import { decideSignals } from './decide.js';
import { fetchLiveMarketData } from '../src/live/twelvedata.js';

const SUPABASE_URL = () => process.env.SUPABASE_URL || '';
const SUPABASE_KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SCAN_SECRET = () => process.env.SIGNAL_SCAN_SECRET || '';
const REFERENCE_EQUITY = () => Number(process.env.SIGNAL_REFERENCE_EQUITY || 10000);

function fail(message, statusCode = 500, code = 'SCAN_ERROR') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function authorized(req) {
  const configured = SCAN_SECRET();
  if (!configured) throw fail('SIGNAL_SCAN_SECRET is not configured', 503, 'CONFIG_MISSING');
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : req.headers?.['x-scan-secret'];
  return provided === configured;
}

async function supabaseRequest(path, { method = 'GET', body = undefined, headers = {} } = {}) {
  const url = `${SUPABASE_URL()}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_KEY(),
      Authorization: `Bearer ${SUPABASE_KEY()}`,
      'Content-Type': 'application/json',
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) throw fail(`Supabase request failed (${response.status})`, 502, 'SUPABASE_ERROR');
  return payload;
}

function decisionStatus(decision) {
  return decision?.decision === 'TRADE_ALLOWED' ? decision.direction : 'WAIT';
}

function buildSignalRows({ market, result }) {
  const decisions = Array.isArray(result.decisions) ? result.decisions : [];
  const rows = decisions.length
    ? decisions.map((decision) => ({
        symbol: market.symbol,
        timeframe: 'M15',
        signal_candle_open: new Date(result.latestCandleTimestamp).toISOString(),
        signal_candle_close: new Date(result.latestCandleCloseTimestamp).toISOString(),
        status: decisionStatus(decision),
        direction: decision.direction ?? null,
        setup_id: decision.setupId ?? null,
        entry_price: decision.entryPrice ?? null,
        stop_price: decision.stopPrice ?? null,
        target_price: decision.targetPrice ?? null,
        rr: decision.rr ?? null,
        risk_atr: decision.riskATR ?? null,
        position_size_reference: decision.positionSize ?? null,
        reference_equity: REFERENCE_EQUITY(),
        reason_codes: decision.reasons ?? [],
        source: market.dataSource,
        source_plan: market.dataSourcePlan,
        latest_m15_age_seconds: market.latestM15AgeSeconds,
        raw_response: { ...result, primaryDecision: decision },
        source_meta: {
          referencePrice: market.referencePrice,
          decisionCount: decisions.length,
          freshCandidateCount: result.freshCandidateCount
        },
        signal_key: [market.symbol, result.latestCandleCloseTimestamp, decision.setupId ?? decision.decision].join(':')
      }))
    : [{
        symbol: market.symbol,
        timeframe: 'M15',
        signal_candle_open: new Date(result.latestCandleTimestamp).toISOString(),
        signal_candle_close: new Date(result.latestCandleCloseTimestamp).toISOString(),
        status: 'WAIT',
        direction: null,
        setup_id: null,
        entry_price: null,
        stop_price: null,
        target_price: null,
        rr: null,
        risk_atr: null,
        position_size_reference: null,
        reference_equity: REFERENCE_EQUITY(),
        reason_codes: ['NO_FRESH_SETUP'],
        source: market.dataSource,
        source_plan: market.dataSourcePlan,
        latest_m15_age_seconds: market.latestM15AgeSeconds,
        raw_response: result,
        source_meta: { referencePrice: market.referencePrice, decisionCount: 0, freshCandidateCount: 0 },
        signal_key: [market.symbol, result.latestCandleCloseTimestamp, 'WAIT'].join(':')
      }];
  return rows;
}

function buildStaleRow(market) {
  const open = market.latestM15TimestampOpen ?? market.latestM15TimestampClose - 15 * 60_000;
  const close = market.latestM15TimestampClose;
  return {
    symbol: market.symbol,
    timeframe: 'M15',
    signal_candle_open: new Date(open).toISOString(),
    signal_candle_close: new Date(close).toISOString(),
    status: 'DATA_STALE',
    direction: null,
    setup_id: null,
    entry_price: null,
    stop_price: null,
    target_price: null,
    rr: null,
    risk_atr: null,
    position_size_reference: null,
    reference_equity: REFERENCE_EQUITY(),
    reason_codes: ['MARKET_DATA_STALE'],
    source: market.dataSource,
    source_plan: market.dataSourcePlan,
    latest_m15_age_seconds: market.latestM15AgeSeconds,
    raw_response: { status: 'DATA_STALE', latestM15TimestampClose: close, latestM15AgeSeconds: market.latestM15AgeSeconds },
    source_meta: { referencePrice: market.referencePrice },
    signal_key: [market.symbol, close, 'DATA_STALE'].join(':')
  };
}

async function persistSignals(rows) {
  const payload = await supabaseRequest('/rest/v1/signal_events?on_conflict=signal_key', {
    method: 'POST',
    body: rows,
    headers: {
      Prefer: 'resolution=ignore-duplicates,return=representation'
    }
  });
  return Array.isArray(payload) ? payload : [];
}

export async function runLiveScan() {
  if (!SUPABASE_URL() || !SUPABASE_KEY()) throw fail('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required', 503, 'CONFIG_MISSING');

  const market = await fetchLiveMarketData();
  if (market.stale) {
    const persisted = await persistSignals([buildStaleRow(market)]);
    return {
      ok: false,
      status: 'DATA_STALE',
      inserted: persisted.length,
      alreadyRecorded: persisted.length === 0,
      latestM15TimestampClose: market.latestM15TimestampClose,
      latestM15AgeSeconds: market.latestM15AgeSeconds,
      dataSource: market.dataSource
    };
  }

  const result = decideSignals({
    m15: market.m15,
    h4: market.h4,
    equity: REFERENCE_EQUITY(),
    currentBid: market.referencePrice,
    currentAsk: market.referencePrice,
    positionExists: false,
    executedSetupIds: []
  });

  const rows = buildSignalRows({ market, result });
  const persisted = await persistSignals(rows);

  return {
    ok: true,
    status: rows.some((r) => r.status === 'BUY') ? 'BUY' : rows.some((r) => r.status === 'SELL') ? 'SELL' : 'WAIT',
    inserted: persisted.length,
    alreadyRecorded: persisted.length === 0,
    latestM15TimestampClose: market.latestM15TimestampClose,
    latestM15AgeSeconds: market.latestM15AgeSeconds,
    dataSource: market.dataSource,
    dataSourcePlan: market.dataSourcePlan,
    result
  };
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.status(405).json({ error: 'GET or POST only' });
    return;
  }
  try {
    if (!authorized(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const result = await runLiveScan();
    res.status(result.ok ? 200 : 503).json(result);
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    res.status(status).json({
      error: error?.message || 'Live scan failed',
      code: error?.code || 'SCAN_ERROR',
      ...(error?.details ? { details: error.details } : {})
    });
  }
}
