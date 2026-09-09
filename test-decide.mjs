import fs from 'node:fs';
import handler from './api/decide.js';

const raw = JSON.parse(fs.readFileSync('./data.json', 'utf8'));

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.body = obj; return res; };
  return res;
}

async function runAt(confirmationIndex, label) {
  // Truncate exactly at the candle that confirmed the setup in the batch
  // backtest -- this makes "the latest candle" in decide.js's eyes match
  // exactly what the batch run saw at that point in history.
  const m15Slice = raw.m15.slice(0, confirmationIndex + 1);
  const lastTs = m15Slice[m15Slice.length - 1].timestampClose;
  const h4Slice = raw.h4.filter((c) => c.timestampOpen < lastTs);

  // Use the REAL historical next candle's open as the live quote, so this
  // is an apples-to-apples comparison with what modelNextOpenEntry used in
  // the batch backtest (zero spread, matching spreadPriceTicks=0n used
  // throughout backtesting).
  const nextOpen = raw.m15[confirmationIndex + 1]?.open;

  const req = { method: 'POST', body: { m15: m15Slice, h4: h4Slice, equity: 10000, currentBid: nextOpen, currentAsk: nextOpen, positionExists: false, executedSetupIds: [] } };
  const res = mockRes();
  await handler(req, res);
  console.log(`=== ${label} (truncated at index ${confirmationIndex}, historical next-open ${nextOpen}) ===`);
  console.log('status:', res.statusCode);
  console.log(JSON.stringify(res.body, null, 2));
}

await runAt(8043, 'TRADE 1 (batch backtest: SELL, entry 1.16811, stop 1.17222, target 1.15438, RR 3.34, TRADE_COMPLETED)');
await runAt(12124, 'TRADE 2 (batch backtest: BUY, entry 1.14150, stop 1.13781, target 1.15064, RR 2.48, TRADE_COMPLETED)');
