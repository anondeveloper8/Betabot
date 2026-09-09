# Android + $0 deployment setup

## 1. Create the free accounts

You need:

1. GitHub
2. Vercel
3. Supabase
4. Twelve Data

No MT5 desktop installation is required for the signal system.

## 2. Supabase

Open the Supabase SQL editor and run the complete contents of `supabase-schema.sql`.

The PWA only reads through `/api/latest-signal`.
The scanner writes with the Supabase service-role key on the server.
Do **not** put the service-role key in `app.js`, `config.js`, HTML, GitHub Pages, or any browser-exposed file.

## 3. Vercel environment variables

Add these as server-side environment variables:

```text
TWELVEDATA_API_KEY=your_twelve_data_key
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
SIGNAL_SCAN_SECRET=a_long_random_secret
SIGNAL_REFERENCE_EQUITY=10000
```

`SIGNAL_REFERENCE_EQUITY` is only used for the analytical position-size calculation. It does not connect to or read an MT5 account.

## 4. Deploy the repository root

Import the GitHub repository into Vercel and deploy the **repository root**.

There is deliberately no `/dashboard` deployment path. The PWA shell is at:

```text
/
/index.html
/app.js
/styles.css
/manifest.json
/sw.js
/pwa-192.png
/pwa-512.png
```

The root service worker is important: it gives the installed PWA the correct `/` scope and avoids the common `/dashboard` service-worker scope problem.

## 5. Verify the PWA

Open the deployed Vercel URL in Chrome on Android.

The dashboard should show:

- connection state
- current BUY / SELL / WAIT state
- entry / stop / target / R:R when applicable
- strategy checks
- signal history
- manual-only execution status

The browser must never request Twelve Data directly.

## 6. Scheduled scanning

The repository contains:

```text
.github/workflows/signal-scan.yml
```

Add these GitHub repository secrets:

```text
SIGNAL_API_URL=https://your-vercel-project.vercel.app
SIGNAL_SCAN_SECRET=the_same_server_secret
```

Then use **Actions → EURUSD Signal Scan → Run workflow** for a manual test.

The scheduled job runs every 15 minutes.

For a private GitHub repository, check your current GitHub Actions included-minute allowance before relying on continuous scheduling. A public repository using eligible standard hosted runners is the simplest zero-cost scheduled arrangement, but GitHub's free-tier policies can change.

## 7. Android Termux fallback

For a private repository or if you do not want scheduled GitHub Actions, run the included manual scanner from Termux:

```bash
export SIGNAL_API_URL='https://your-vercel-project.vercel.app'
export SIGNAL_SCAN_SECRET='the_same_server_secret'
node scripts/manual-scan.mjs
```

This only triggers the server scanner. It does not execute a trade.

## 8. Data failure behavior

The system fails closed.

It will not manufacture a price, silently substitute a different provider, or treat an incomplete M15 candle as completed. If the provider is stale or history is insufficient, the scan is rejected or recorded as `DATA_STALE`.

## 9. Notifications

The PWA can display browser/service-worker notifications for newly loaded BUY/SELL signals after notification permission is granted.

This is **not** server push. The PWA must be opened/polling for this mechanism to discover a new signal. No paid push service is required.
