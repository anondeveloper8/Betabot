(function () {
  'use strict';

  const API_BASE = (window.SIGNAL_API_URL || '').replace(/\/$/, '');
  const POLL_MS = 60_000;
  const REASON_COPY = {
    H4_CONTEXT_UNCLEAR: 'The bigger H4 structure was not clear enough.',
    ZONE_NOT_VALID: 'The H4 zone was no longer valid.',
    NOT_AT_ZONE: 'Price was not at a meaningful H4 level.',
    PULLBACK_NOT_CONFIRMED: 'The required M15 pullback was not confirmed.',
    REACTION_NOT_CONFIRMED: 'The required reaction was not confirmed.',
    BOS_NOT_CONFIRMED: 'There was no confirmed M15 break of structure.',
    ENTRY_TOO_EXTENDED: 'Price had moved too far beyond the broken reference.',
    INVALID_STOP: 'A structurally valid stop could not be confirmed.',
    NO_TARGET_ZONE: 'No valid H4 target zone was available.',
    RR_BELOW_MINIMUM: 'The available reward was below the minimum R:R requirement.',
    RISK_LIMIT_EXCEEDED: 'The reference risk limit was exceeded.',
    SETUP_ALREADY_USED: 'This setup had already been used.',
    DATA_INVALID: 'The data failed a validation check, so the system refused the signal.',
    EXISTING_POSITION: 'An existing position blocked the setup.',
    UNTESTABLE_PERIOD: 'There was not enough confirmed data to test the setup.',
    RISK_ATR_ABOVE_FROZEN_THRESHOLD: 'The setup exceeded the frozen risk/ATR threshold.'
  };

  let latestSignals = [];
  let notificationPermissionAsked = false;
  let lastRenderedSignalKey = null;

  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  function fmtPrice(value) {
    return value == null ? '—' : Number(value).toFixed(5);
  }

  function fmtR(value) {
    return value == null ? '—' : Number(value).toFixed(2) + 'R';
  }

  function timeAgo(iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms)) return '—';
    const minutes = Math.max(0, Math.floor(ms / 60_000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
  }

  function reasonText(codes) {
    const items = Array.isArray(codes) ? codes : [];
    return items.length ? items.map((x) => escapeHtml(REASON_COPY[x] || String(x).replace(/_/g, ' ').toLowerCase())).join(' ') : 'No valid setup was confirmed.';
  }

  function statusClass(status) {
    if (status === 'BUY') return 'buy';
    if (status === 'SELL') return 'sell';
    return 'wait';
  }

  function statusLabel(status) {
    if (status === 'BUY') return 'BUY SIGNAL';
    if (status === 'SELL') return 'SELL SIGNAL';
    if (status === 'DATA_STALE') return 'DATA STALE';
    return 'WAIT';
  }

  function setConnection(ok, label) {
    const pill = $('connectionPill');
    pill.className = 'status-pill ' + (ok ? 'live' : 'stale');
    $('connectionText').textContent = label;
  }

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), 3000);
  }

  function renderHero(signal) {
    const status = signal?.status || 'WAIT';
    const hero = $('heroStatus');
    hero.className = 'hero-status ' + statusClass(status);
    hero.textContent = statusLabel(status);

    if (!signal) {
      $('heroReason').textContent = 'No completed scan has been recorded yet.';
      $('lastScan').textContent = 'Last scan —';
      $('dataSource').textContent = 'Data —';
      $('setupCard').hidden = true;
      $('checksCard').hidden = true;
      return;
    }

    $('heroReason').textContent = status === 'BUY' || status === 'SELL'
      ? 'The complete strategy chain passed on the latest completed M15 candle.'
      : reasonText(signal.reason_codes);
    $('lastScan').textContent = 'Scan ' + timeAgo(signal.created_at);
    $('dataSource').textContent = `${signal.source || 'Market data'} · ${signal.latest_m15_age_seconds ?? '—'}s old`;

    const hasLevels = status === 'BUY' || status === 'SELL';
    $('setupCard').hidden = !hasLevels;
    $('checksCard').hidden = false;

    if (hasLevels) {
      $('entryPrice').textContent = fmtPrice(signal.entry_price);
      $('stopPrice').textContent = fmtPrice(signal.stop_price);
      $('targetPrice').textContent = fmtPrice(signal.target_price);
      $('rr').textContent = fmtR(signal.rr);
      $('sizeNote').textContent = signal.position_size_reference != null
        ? `Reference size: ${Number(signal.position_size_reference)} at reference equity ${Number(signal.reference_equity).toFixed(2)}. This is a calculation only; nothing was executed.`
        : 'Entry, stop and target are analytical levels only; nothing was executed.';
    }

    const decisions = signal.raw_response?.decisions || [];
    const decision = signal.setup_id ? decisions.find((d) => d.setupId === signal.setup_id) : decisions[0];
    renderChecks(decision, signal);
  }

  function renderChecks(decision, signal) {
    const checks = $('checks');
    const evidence = decision?.evidence || {};
    const reasons = new Set(signal?.reason_codes || []);
    const rows = [
      ['H4 context', evidence.contextState === 'BULLISH' || evidence.contextState === 'BEARISH', evidence.contextState || 'UNKNOWN'],
      ['H4 zone', !reasons.has('ZONE_NOT_VALID'), reasons.has('ZONE_NOT_VALID') ? 'blocked' : 'passed'],
      ['At zone', !reasons.has('NOT_AT_ZONE'), reasons.has('NOT_AT_ZONE') ? 'blocked' : 'passed'],
      ['Pullback', !reasons.has('PULLBACK_NOT_CONFIRMED'), reasons.has('PULLBACK_NOT_CONFIRMED') ? 'blocked' : 'passed'],
      ['Reaction', !reasons.has('REACTION_NOT_CONFIRMED'), reasons.has('REACTION_NOT_CONFIRMED') ? 'blocked' : 'passed'],
      ['BOS', !reasons.has('BOS_NOT_CONFIRMED'), reasons.has('BOS_NOT_CONFIRMED') ? 'blocked' : 'passed'],
      ['Entry / stop', !reasons.has('ENTRY_TOO_EXTENDED') && !reasons.has('INVALID_STOP'), reasons.has('ENTRY_TOO_EXTENDED') ? 'too extended' : reasons.has('INVALID_STOP') ? 'invalid stop' : 'passed'],
      ['Target / R:R', !reasons.has('NO_TARGET_ZONE') && !reasons.has('RR_BELOW_MINIMUM'), reasons.has('NO_TARGET_ZONE') ? 'no target' : reasons.has('RR_BELOW_MINIMUM') ? 'R:R too low' : 'passed'],
      ['Final gate', signal.status === 'BUY' || signal.status === 'SELL', signal.status === 'BUY' || signal.status === 'SELL' ? 'TRADE_ALLOWED' : 'WAIT']
    ];
    checks.innerHTML = rows.map(([name, passed, value]) => `
      <div class="check-row">
        <span class="check-name">${name}</span>
        <span class="check-value ${passed ? 'pass' : 'fail'}">${passed ? '✓' : '×'} ${value}</span>
      </div>`).join('');
  }

  function renderFeed() {
    const feed = $('signalFeed');
    if (!latestSignals.length) {
      feed.innerHTML = '<div class="empty-state">No signal history yet.</div>';
      return;
    }

    feed.innerHTML = latestSignals.map((signal) => {
      const cls = statusClass(signal.status);
      const label = statusLabel(signal.status);
      const levelLine = signal.status === 'BUY' || signal.status === 'SELL'
        ? `Entry ${fmtPrice(signal.entry_price)} · Stop ${fmtPrice(signal.stop_price)} · Target ${fmtPrice(signal.target_price)}${signal.rr != null ? ` · ${fmtR(signal.rr)}` : ''}`
        : reasonText(signal.reason_codes);
      return `
        <article class="signal-item glass">
          <div class="feed-badge ${cls}">${signal.status === 'BUY' ? '↑' : signal.status === 'SELL' ? '↓' : '–'}</div>
          <div class="item-body">
            <div class="item-title">${escapeHtml(label)}</div>
            <div class="item-sub">${escapeHtml(levelLine)}</div>
            <div class="item-time">${timeAgo(signal.created_at)} · candle closed ${new Date(signal.signal_candle_close).toLocaleString()}</div>
            ${signal.setup_id ? `<div class="item-id">Setup ${escapeHtml(signal.setup_id)}</div>` : ''}
          </div>
        </article>`;
    }).join('');
  }

  async function loadSignals() {
    try {
      const response = await fetch(`${API_BASE}/api/latest-signal`, { cache: 'no-store', headers: { accept: 'application/json' } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      latestSignals = Array.isArray(payload.signals) ? payload.signals : [];
      renderHero(latestSignals[0] || null);
      renderFeed();
      setConnection(true, 'Live');

      const latestKey = latestSignals[0]?.signal_key || null;
      if (latestKey && latestKey !== lastRenderedSignalKey) {
        lastRenderedSignalKey = latestKey;
        maybeNotify(latestSignals[0]);
      }
      $('refreshButton').textContent = 'Refresh';
    } catch (error) {
      console.error(error);
      setConnection(false, 'Offline');
      $('refreshButton').textContent = 'Retry';
      toast(error.message || 'Could not load signal data.');
    }
  }

  async function maybeNotify(signal) {
    if (!signal || !('Notification' in window) || notificationPermissionAsked) return;
    notificationPermissionAsked = true;
    if (Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch { return; }
    }
    if (Notification.permission !== 'granted' || !navigator.serviceWorker?.ready) return;
    if (signal.status !== 'BUY' && signal.status !== 'SELL') return;
    try {
      const registration = await navigator.serviceWorker.ready;
      registration.showNotification(`${signal.status} EUR/USD`, {
        body: `Entry ${fmtPrice(signal.entry_price)} · SL ${fmtPrice(signal.stop_price)} · TP ${fmtPrice(signal.target_price)}`,
        tag: signal.signal_key
      });
    } catch { /* Notification support is optional. */ }
  }

  $('refreshButton').addEventListener('click', loadSignals);
  loadSignals();
  setInterval(loadSignals, POLL_MS);
})();
