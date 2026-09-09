/**
 * Stage 37 — deterministic backtest research metrics.
 *
 * Historical/research only. This module does not place or manage live trades.
 * It consumes completed/rejected runner results and calculates auditable
 * performance statistics without inventing missing observations.
 */

function assertFiniteNumber(name, value) {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite.`);
}

function completedTrades(backtest) {
  if (!backtest || !Array.isArray(backtest.results)) throw new Error("backtest.results must be an array.");
  return backtest.results.filter((r) => r?.decision === "TRADE_COMPLETED" && Number.isFinite(r?.result?.realizedR));
}

function rejectionCounts(backtest) {
  const counts = {};
  for (const result of backtest.results) {
    if (!Array.isArray(result?.reasons)) continue;
    for (const reason of result.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function maxDrawdownFromR(rValues) {
  let equityR = 0;
  let peakR = 0;
  let maxDdR = 0;
  for (const r of rValues) {
    equityR += r;
    if (equityR > peakR) peakR = equityR;
    const dd = peakR - equityR;
    if (dd > maxDdR) maxDdR = dd;
  }
  return maxDdR;
}

function longestLossStreak(rValues) {
  let current = 0;
  let longest = 0;
  for (const r of rValues) {
    if (r < 0) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/**
 * Summarise one chronological backtest.
 * Costs are already reflected in result.netMoney by the runner when supplied.
 */
export function calculateBacktestMetrics(backtest, { initialEquity = null } = {}) {
  const trades = completedTrades(backtest);
  const rValues = trades.map((t) => t.result.realizedR);
  const wins = rValues.filter((r) => r > 0);
  const losses = rValues.filter((r) => r < 0);
  const breakeven = rValues.filter((r) => r === 0);

  const grossProfitR = wins.reduce((a, b) => a + b, 0);
  const grossLossAbsR = losses.reduce((a, b) => a + Math.abs(b), 0);
  const totalR = rValues.reduce((a, b) => a + b, 0);
  const expectancyR = rValues.length ? totalR / rValues.length : null;
  const profitFactor = grossLossAbsR > 0 ? grossProfitR / grossLossAbsR : (grossProfitR > 0 ? Infinity : null);
  const winRate = rValues.length ? wins.length / rValues.length : null;
  const averageWinR = wins.length ? grossProfitR / wins.length : null;
  const averageLossR = losses.length ? -grossLossAbsR / losses.length : null;
  const avgR = expectancyR;
  const sorted = [...rValues].sort((a, b) => a - b);

  const endingEquity = Number.isFinite(backtest.endingEquity) ? backtest.endingEquity : null;
  const equityReturn = initialEquity !== null && Number.isFinite(endingEquity) && initialEquity > 0
    ? (endingEquity - initialEquity) / initialEquity
    : null;

  return Object.freeze({
    candidatesProcessed: Number.isInteger(backtest.candidatesProcessed) ? backtest.candidatesProcessed : backtest.results.length,
    tradesCompleted: trades.length,
    tradesRejected: Number.isInteger(backtest.tradesRejected) ? backtest.tradesRejected : backtest.results.filter(r => r.decision === "NO_TRADE").length,
    untestable: Number.isInteger(backtest.untestable) ? backtest.untestable : backtest.results.filter(r => r.decision === "UNTESTABLE_PERIOD").length,
    winRate,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
    averageWinR,
    averageLossR,
    expectancyR,
    avgR,
    totalR,
    profitFactor,
    maxDrawdownR: maxDrawdownFromR(rValues),
    longestLossStreak: longestLossStreak(rValues),
    medianR: percentile(sorted, 0.5),
    p25R: percentile(sorted, 0.25),
    p75R: percentile(sorted, 0.75),
    endingEquity,
    equityReturn,
    rejectionCounts: rejectionCounts(backtest)
  });
}

/**
 * Compare precomputed management-variant backtests using fixed metrics.
 * No variant is ranked by return alone; the caller can inspect the full table.
 */
export function compareBacktestVariants(variantBacktests, options = {}) {
  if (!Array.isArray(variantBacktests)) throw new Error("variantBacktests must be an array.");
  return Object.freeze(variantBacktests.map((item) => {
    if (!item || typeof item !== "object" || !item.variant || !item.backtest) {
      throw new Error("Each variant item requires variant and backtest.");
    }
    return Object.freeze({
      variant: item.variant,
      metrics: calculateBacktestMetrics(item.backtest, options)
    });
  }));
}

/**
 * Create compact period buckets from completed trades.
 * Caller supplies a deterministic getPeriod function so this module does not
 * assume a calendar convention.
 */
export function breakdownByPeriod(backtest, getPeriod) {
  if (typeof getPeriod !== "function") throw new Error("getPeriod must be a function.");
  const buckets = new Map();
  for (const trade of completedTrades(backtest)) {
    const key = getPeriod(trade);
    if (typeof key !== "string" || key.length === 0) throw new Error("getPeriod must return a non-empty string.");
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(trade);
  }
  return Object.freeze([...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, results]) => {
    const mini = { results, candidatesProcessed: results.length, tradesRejected: 0, untestable: 0, endingEquity: null };
    return Object.freeze({ period, metrics: calculateBacktestMetrics(mini) });
  }));
}
