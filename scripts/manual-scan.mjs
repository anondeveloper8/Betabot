#!/usr/bin/env node

const base = process.env.SIGNAL_API_URL;
const secret = process.env.SIGNAL_SCAN_SECRET;
if (!base || !secret) {
  console.error('Set SIGNAL_API_URL and SIGNAL_SCAN_SECRET in the Termux environment first.');
  process.exit(2);
}

const response = await fetch(`${base.replace(/\/$/, '')}/api/live-scan`, {
  headers: { Authorization: `Bearer ${secret}`, 'Cache-Control': 'no-cache' }
});
const text = await response.text();
console.log(text);
if (!response.ok) process.exit(1);
