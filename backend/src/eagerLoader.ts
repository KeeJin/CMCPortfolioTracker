import { getAllBaselines, getAllTransactions } from "./store.js";
import { reconstructState } from "./reconstruction.js";
import { getPortfolioAnchor } from "./portfolioState.js";
import {
  fetchYahooFinanceHistoricalPrices,
  fetchYahooFinanceLatestPrices,
  fetchYahooFinanceStockSplits,
} from "./pricing.js";
import { collectTrackedSymbols, mergeMarketSplitTransactions } from "./marketSplits.js";

// ─── Eager Loader ─────────────────────────────────────────────────────────────
// On server startup, fetch 5 years of price history for all active holdings.
// This covers the data needed for every available timeframe (5d → 5y).
// Results are stored in the price cache so subsequent route requests are fast.

function get5yStartDate(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 5);
  return d.toISOString().slice(0, 10);
}

async function runEagerLoad(): Promise<void> {
  const baselines = getAllBaselines();
  const allTransactions = getAllTransactions();
  const anchor = getPortfolioAnchor(baselines, allTransactions);

  if (!anchor) {
    console.log("[eagerLoader] No portfolio data yet, skipping prefetch");
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

  const state = reconstructState(anchor.baseline, enrichedTransactions);
  const symbols = Object.entries(state.holdings)
    .filter(([, qty]) => qty !== 0)
    .map(([symbol]) => symbol);

  if (symbols.length === 0) {
    console.log("[eagerLoader] No active holdings, skipping prefetch");
    return;
  }
  // Cover the full history for "all" timeframe: use the earlier of the
  // baseline date or 5 years ago, so every timeframe is pre-warmed.
  const startDate = anchor.baseline.date < get5yStartDate() ? anchor.baseline.date : get5yStartDate();

  console.log(
    `[eagerLoader] Prefetching prices for ${symbols.length} symbol(s) from ${startDate} to ${today}`
  );

  const historicalResult = await fetchYahooFinanceHistoricalPrices(symbols, startDate, today);
  console.log(
    `[eagerLoader] Historical prefetch done: ${historicalResult.fetchedSymbols.length} fetched, ${historicalResult.failedSymbols.length} failed`
  );

  const liveResult = await fetchYahooFinanceLatestPrices(symbols);
  console.log(
    `[eagerLoader] Live price prefetch done: ${liveResult.fetchedSymbols.length} fetched, ${liveResult.failedSymbols.length} failed`
  );
}

// Kicks off the prefetch in the background without blocking the caller.
export function startEagerLoading(): void {
  setImmediate(() => {
    runEagerLoad().catch((err: unknown) => {
      console.error("[eagerLoader] Background prefetch error:", err);
    });
  });
}
