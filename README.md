# EUR/USD Signal-Only Forex Strategy Engine

This repository contains the frozen V1 EUR/USD research strategy converted into a **signal-only** system.

It does **not** place, modify, or manage MT5 orders.

## Architecture

```text
Twelve Data Basic Free
        ↓
server-side live scanner
        ↓
existing deterministic strategy engine
        ↓
BUY / SELL / WAIT
Entry / Stop / Target / R:R / reasons
        ↓
Supabase signal history
        ↓
Android-first PWA
        ↓
manual decision + manual MT5 Android execution
```

The browser never receives the Twelve Data API key or the Supabase service-role key.

## Strategy preservation

The strategy modules remain the source of truth. The live layer orchestrates them; it does not contain a second trading strategy.

The canonical supplied research report remains the baseline. The optimized implementation was replayed against the same `data.json` and reproduced the baseline exactly:

- 32 candidates
- 32 geometry-eligible
- 17 risk-filter eligible
- 2 completed trades
- 0 wins / 2 losses
- total R = -2
- ending equity = 9801.65 from 10000
- rejection counts: RR_BELOW_MINIMUM 11, ENTRY_TOO_EXTENDED 9, NO_TARGET_ZONE 3

This is **not** evidence that the strategy is profitable. The supplied research sample is too small for that conclusion.

## Important files

- `src/strategy/` — strategy stages and gates
- `engine/` — deterministic market primitives
- `api/decide.js` — pure signal decision endpoint; no execution
- `api/live-scan.js` — protected live-data scanner
- `api/latest-signal.js` — public read-only PWA feed
- `src/live/twelvedata.js` — free-tier market-data adapter
- `supabase-schema.sql` — signal history table + RLS
- `index.html`, `app.js`, `styles.css`, `manifest.json`, `sw.js` — root Android PWA
- `pwa-192.png`, `pwa-512.png` — PWA icons
- `run-backtest.mjs` — canonical replay/report generator
- `test-decide.mjs` — regression checks for the two known canonical decisions
- `ForexBotEA.mq5` — retained as archival/reference material; it is not required by the new signal-only path

## $0 operating model

The intended personal setup uses only free tiers:

- Twelve Data Basic Free for market data
- Supabase free project for signal history
- Vercel free deployment for the PWA/API
- GitHub Actions for scheduled scanning when the repository/runner arrangement is eligible for free usage
- Android Chrome/Acode/Termux for management and manual scans

Free-tier limits can change. The scanner therefore fails closed on missing credentials, upstream errors, stale data, insufficient history, and invalid responses. It never invents market data.

## Live scan frequency

One scan needs four provider requests in the current adapter: two M15 history requests, one H4 history request, and one reference-price request.

The GitHub workflow is scheduled every 15 minutes. The protected scanner secret prevents arbitrary public callers from consuming the market-data quota.

## Signal semantics

- `BUY` / `SELL` means the complete configured validation chain produced an allowed signal.
- `WAIT` means no fresh allowed setup was produced on that scan.
- `DATA_STALE` means the provider's latest completed M15 candle is too old for a trustworthy live decision.
- Entry, stop, target, R:R, and reference position size are **analytical values only**.
- No order is submitted anywhere in this repository's signal path.

## Validation commands

```bash
npm run verify
npm run backtest
```

`npm run verify` checks the two known canonical decision points. `npm run backtest` regenerates a replay report from `data.json`.
