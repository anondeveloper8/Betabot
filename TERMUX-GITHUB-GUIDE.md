# Termux + GitHub workflow

This project can be maintained entirely from Android.

## Push from Acode/Termux

From the repository directory:

```bash
git status
git add .
git commit -m "Deploy signal-only Forex engine"
git push
```

## Manual live scan

Set the two environment variables:

```bash
export SIGNAL_API_URL='https://your-vercel-project.vercel.app'
export SIGNAL_SCAN_SECRET='the_same_server_secret'
```

Run:

```bash
node scripts/manual-scan.mjs
```

Expected behavior is a JSON response showing the latest completed M15 candle and either a BUY/SELL signal or WAIT. A stale provider response is reported as `DATA_STALE`.

## Scheduled scan

GitHub Actions uses `.github/workflows/signal-scan.yml` and calls the protected `/api/live-scan` endpoint every 15 minutes.

Repository secrets:

```text
SIGNAL_API_URL
SIGNAL_SCAN_SECRET
```

No provider API key belongs in GitHub Actions for this design. Twelve Data and Supabase secrets stay on Vercel.

## If you only want private/manual operation

Do not enable the scheduled workflow. Use Termux to trigger scans when needed. This keeps the repository private and avoids depending on GitHub Actions included-minute policies.
