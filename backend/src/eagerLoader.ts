import { getAllBaselines, getAllTransactions } from "./store.js";
import { reconstructState } from "./reconstruction.js";
import { getPortfolioAnchor } from "./portfolioState.js";
import {
  fetchYahooFinanceHistoricalPrices,
  fetchYahooFinanceLatestPrices,
  fetchYahooFinanceStockSplits,
} from "./pricing.js";
import { collectTrackedSymbols, mergeMarketSplitTransactions } from "./marketSplits.js";
import { getCachedPriceRange } from "./priceCache.js";

// ─── Eager Loader ─────────────────────────────────────────────────────────────
// On server startup, fetch the common portfolio timeframes for all active holdings.
// This preloads the windows users switch between (5d → 5y) so no delay occurs on first click.
// Results are stored in the price cache so subsequent route requests are fast.

export function getPreloadDateWindows(referenceDate: Date = new Date()): Array<{ label: string; start: string; end: string }> {
  const end = new Date(referenceDate);
  const endDate = end.toISOString().slice(0, 10);
  const windows: Array<{ label: string; start: string; end: string }> = [];
  const seen = new Set<string>();

  const defs: Array<[string, number | null]> = [
    ['5d', 5],
    ['1m', 30],
    ['3m', 90],
    ['6m', 180],
    ['ytd', null],
    ['1y', 365],
    ['3y', 1095],
    ['5y', 1825],
  ];

  for (const [label, days] of defs) {
    const start = new Date(end);
    if (label === 'ytd') {
      start.setUTCMonth(0, 1);
      start.setUTCHours(0, 0, 0, 0);
    } else if (days !== null) {
      start.setUTCDate(end.getUTCDate() - days);
    }

    const startDate = start.toISOString().slice(0, 10);
    const key = `${label}:${startDate}:${endDate}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    windows.push({ label, start: startDate, end: endDate });
  }

  return windows;
}

function get5yStartDate(referenceDate: Date = new Date()): string {
  const d = new Date(referenceDate);
  d.setUTCFullYear(d.getUTCFullYear() - 5);
  return d.toISOString().slice(0, 10);
}

export function getMissingPreloadWindows(symbols: string[], referenceDate: Date = new Date()): Array<{ label: string; start: string; end: string }> {
  const preloadWindows = getPreloadDateWindows(referenceDate);
  const earliestBaselineStart = get5yStartDate(referenceDate);
  const uniqueWindows = new Map<string, { label: string; start: string; end: string }>();

  for (const window of preloadWindows) {
    const start = window.start < earliestBaselineStart ? earliestBaselineStart : window.start;
    uniqueWindows.set(`${start}::${window.end}`, { ...window, start, end: window.end });
  }

  const windows = [...uniqueWindows.values()].sort((a, b) => a.start.localeCompare(b.start));

  return windows.filter((window) => {
    return symbols.some((symbol) => {
      const cached = getCachedPriceRange(symbol, window.start, window.end);
      return !cached || cached.length === 0;
    });
  });
}

async function runEagerLoad(): Promise<void> {
  const baselines = getAllBaselines();
  const allTransactions = getAllTransactions();
  const anchor = getPortfolioAnchor(baselines, allTransactions);

  if (!anchor.baseline) {
    console.log("[eagerLoader] No baseline available yet, skipping prefetch");
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const trackedSymbols = collectTrackedSymbols(anchor.baseline, anchor.transactionsToApply);
  const splitResult = await fetchYahooFinanceStockSplits(
    trackedSymbols,
    anchor.baseline.date,
    today
  );
  const enrichedTransactions = mergeMarketSplitTransactions(
    anchor.transactionsToApply,
    splitResult.splits
  );

  const manualLinearOptionSymbols = new Set(
    enrichedTransactions
      .filter((tx) => tx.instrumentType === 'OPTION' && tx.valuationMethod === 'LINEAR' && tx.symbol)
      .map((tx) => tx.symbol as string)
  );

  const state = reconstructState(anchor.baseline, enrichedTransactions);
  const symbols = Object.entries(state.holdings)
    .filter(([, qty]) => qty !== 0)
    .map(([symbol]) => symbol)
    .filter((symbol) => !manualLinearOptionSymbols.has(symbol));

  const skippedSymbols = Object.entries(state.holdings)
    .filter(([, qty]) => qty !== 0)
    .map(([symbol]) => symbol)
    .filter((symbol) => manualLinearOptionSymbols.has(symbol));

  if (symbols.length === 0) {
    console.log("[eagerLoader] No active non-manual-option holdings, skipping Yahoo prefetch");
    if (skippedSymbols.length > 0) {
      console.log(`[eagerLoader] Skipped manual-linear option symbol(s): ${skippedSymbols.join(', ')}`);
    }
    return;
  }
  const orderedWindows = getMissingPreloadWindows(symbols, new Date());

  if (orderedWindows.length === 0) {
    console.log("[eagerLoader] No new preload data needed; cached historical windows already cover current holdings.");
    console.log("[eagerLoader] Restart detected: reusing persisted range cache for the active symbols without re-fetching Yahoo Finance data.");
    return;
  }

  console.log(
    `[eagerLoader] Prefetching ${symbols.length} symbol(s) across ${orderedWindows.length} timeframe windows` 
  );
  console.log(`[eagerLoader] Symbols: ${symbols.join(', ')}`);
  if (skippedSymbols.length > 0) {
    console.log(`[eagerLoader] Skipped manual-linear option symbol(s): ${skippedSymbols.join(', ')}`);
  }

  let totalFetched = 0;
  let totalFailed = 0;

  for (const window of orderedWindows) {
    const historicalResult = await fetchYahooFinanceHistoricalPrices(symbols, window.start, window.end);
    totalFetched += historicalResult.fetchedSymbols.length;
    totalFailed += historicalResult.failedSymbols.length;
    console.log(
      `[eagerLoader] Window ${window.start} → ${window.end}: ${historicalResult.fetchedSymbols.length} fetched, ${historicalResult.failedSymbols.length} failed`
    );
    if (historicalResult.failedDetails.length > 0) {
      const failedSummary = historicalResult.failedDetails
        .map((entry) => `${entry.symbol} (${entry.reason})`)
        .join(', ');
      console.log(`[eagerLoader] Historical failures for ${window.start} → ${window.end}: ${failedSummary}`);
    }
  }

  console.log(
    `[eagerLoader] Historical prefetch done: ${totalFetched} fetched, ${totalFailed} failed`
  );

  const liveResult = await fetchYahooFinanceLatestPrices(symbols);
  console.log(
    `[eagerLoader] Live price prefetch done: ${liveResult.fetchedSymbols.length} fetched, ${liveResult.failedSymbols.length} failed`
  );
  if (liveResult.fetchedSymbols.length > 0) {
    console.log(`[eagerLoader] Live fetched: ${liveResult.fetchedSymbols.join(', ')}`);
  }
  if (liveResult.failedDetails.length > 0) {
    const failedSummary = liveResult.failedDetails
      .map((entry) => `${entry.symbol} (${entry.reason})`)
      .join(', ');
    console.log(`[eagerLoader] Live failed: ${failedSummary}`);
  }
}

// Kicks off the prefetch in the background without blocking the caller.
export function startEagerLoading(): void {
  setImmediate(() => {
    runEagerLoad().catch((err: unknown) => {
      console.error("[eagerLoader] Background prefetch error:", err);
    });
  });
}

function getNyseParts(date: Date): { day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  );

  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday ?? 'Sun');

  return {
    day: weekday,
    hour: Number(values.hour ?? '0'),
    minute: Number(values.minute ?? '0'),
  };
}

function isTradingDay(date: Date = new Date()): boolean {
  const { day } = getNyseParts(date);
  return day >= 1 && day <= 5;
}

function isMarketOpen(date: Date = new Date()): boolean {
  if (!isTradingDay(date)) {
    return false;
  }

  const { hour, minute } = getNyseParts(date);
  const currentMinutes = hour * 60 + minute;
  const openMinutes = 9 * 60 + 30;
  const closeMinutes = 16 * 60;

  return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
}

function getNextPreCloseRefresh(date: Date = new Date()): Date {
  const next = new Date(date);
  next.setUTCFullYear(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const nyOpen = new Date(next);
  nyOpen.setUTCFullYear(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate());
  nyOpen.setUTCHours(20, 15, 0, 0);
  return nyOpen;
}

function getNextTradingDayOpen(referenceDate: Date = new Date()): Date {
  const next = new Date(referenceDate);
  next.setUTCHours(0, 0, 0, 0);

  let cursor = 0;
  while (cursor < 10) {
    const candidate = new Date(next);
    candidate.setUTCDate(next.getUTCDate() + cursor);
    const { day } = getNyseParts(candidate);
    if (day >= 1 && day <= 5) {
      const nyOpen = new Date(candidate);
      nyOpen.setUTCHours(13, 30, 0, 0);
      return nyOpen;
    }
    cursor += 1;
  }

  return new Date(referenceDate.getTime() + 24 * 60 * 60 * 1000);
}

function getNextRefreshDelay(referenceDate: Date = new Date()): number {
  const now = new Date(referenceDate);

  if (!isTradingDay(now)) {
    return Math.max(1, getNextTradingDayOpen(now).getTime() - now.getTime());
  }

  const { hour, minute } = getNyseParts(now);
  const currentMinutes = hour * 60 + minute;
  const openMinutes = 9 * 60 + 30;
  const closeMinutes = 16 * 60;
  const postCloseMinutes = 16 * 60 + 15;

  if (currentMinutes < openMinutes) {
    return Math.max(1, (openMinutes - currentMinutes) * 60_000);
  }

  if (currentMinutes >= openMinutes && currentMinutes < closeMinutes) {
    const nextRunMinutes = Math.ceil((currentMinutes + 30) / 30) * 30;
    const targetMinutes = Math.min(nextRunMinutes, closeMinutes - 1);
    return Math.max(1, (targetMinutes - currentMinutes) * 60_000);
  }

  if (currentMinutes >= closeMinutes && currentMinutes < postCloseMinutes) {
    return Math.max(1, (postCloseMinutes - currentMinutes) * 60_000);
  }

  return Math.max(1, getNextTradingDayOpen(now).getTime() - now.getTime());
}

export function startScheduledMarketRefresh(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleNext = () => {
    if (timer) {
      clearTimeout(timer);
    }

    const delay = getNextRefreshDelay();
    timer = setTimeout(() => {
      const now = new Date();
      const isOpen = isMarketOpen(now);
      const isPostCloseWindow = isTradingDay(now) && getNyseParts(now).hour * 60 + getNyseParts(now).minute >= 16 * 60 && getNyseParts(now).hour * 60 + getNyseParts(now).minute < 16 * 60 + 30;

      if (isOpen || isPostCloseWindow) {
        runEagerLoad().catch((err: unknown) => {
          console.error('[eagerLoader] Scheduled refresh error:', err);
        });
      }

      scheduleNext();
    }, delay);
  };

  scheduleNext();
}
