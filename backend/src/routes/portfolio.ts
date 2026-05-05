import { Router } from "express";
import { getAllBaselines, getAllTransactions, getUploads } from "../store.js";
import { reconstructState } from "../reconstruction.js";
import type { NormalizedTransaction } from "../models/index.js";
import {
  buildTwrFactorSeries,
  calculateIrr,
  calculatePerformance,
  calculateTwr,
  type PriceHistory,
} from "../performance.js";
import {
  fetchGoogleFinanceLatestPrices,
  fetchStooqHistoricalPrices,
  fetchStooqLatestPrices,
  fetchYahooFinanceHistoricalPrices,
  fetchYahooFinanceLatestPrices,
  fetchYahooFinanceStockSplits,
  buildTransactionPriceProvider,
  type PricingMethod,
} from "../pricing.js";
import {
  collectTrackedSymbols,
  mergeMarketSplitTransactions,
} from "../marketSplits.js";
import { getPortfolioAnchor } from "../portfolioState.js";
import { fetchUsdSgdHistory, convertSgdToUsd } from "../fx.js";

const ACTIVE_PRICING_METHOD: PricingMethod = "yahoo_finance";
type PortfolioTimeframe = "5d" | "1m" | "3m" | "6m" | "ytd" | "1y" | "3y" | "5y" | "all";
const DEFAULT_TIMEFRAME: PortfolioTimeframe = "1y";

// Simple request queue to limit concurrent price fetches
let activeRequests = 0;
const MAX_CONCURRENT_REQUESTS = 2;
const MAX_QUEUE_SIZE = 50;
const requestQueue: Array<() => void> = [];

async function enqueueRequest<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      activeRequests++;
      console.log(`[enqueueRequest] Request started. Active: ${activeRequests}, Queued: ${requestQueue.length}`);

      fn()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          activeRequests--;
          console.log(`[enqueueRequest] Request finished. Active: ${activeRequests}, Queued: ${requestQueue.length}`);
          const nextFn = requestQueue.shift();
          if (nextFn) {
            console.log(`[enqueueRequest] Processing queued request. Active: ${activeRequests}, Remaining queued: ${requestQueue.length}`);
            nextFn();
          }
        });
    };

    if (activeRequests < MAX_CONCURRENT_REQUESTS) {
      run();
      return;
    }

    if (requestQueue.length >= MAX_QUEUE_SIZE) {
      reject(new Error("Server busy, please retry shortly"));
      return;
    }

    console.log(`[enqueueRequest] Request queued. Active: ${activeRequests}, Queued: ${requestQueue.length}`);
    requestQueue.push(run);
  });
}

const router = Router();

function resolvePricingMethod(raw: unknown): PricingMethod | null {
  if (typeof raw !== "string") {
    return null;
  }

  if (
    raw === "transaction_forward_fill" ||
    raw === "google_finance" ||
    raw === "stooq_free_live" ||
    raw === "yahoo_finance"
  ) {
    return raw;
  }

  return null;
}

function resolveTimeframe(raw: unknown): PortfolioTimeframe | null {
  if (typeof raw !== "string") {
    return null;
  }

  if (
    raw === "5d" ||
    raw === "1m" ||
    raw === "3m" ||
    raw === "6m" ||
    raw === "ytd" ||
    raw === "1y" ||
    raw === "3y" ||
    raw === "5y" ||
    raw === "all"
  ) {
    return raw;
  }

  return null;
}

function shiftIsoDate(date: string, opts: { days?: number; months?: number; years?: number }): string {
  const value = new Date(`${date}T00:00:00.000Z`);

  if (opts.years) {
    value.setUTCFullYear(value.getUTCFullYear() + opts.years);
  }
  if (opts.months) {
    value.setUTCMonth(value.getUTCMonth() + opts.months);
  }
  if (opts.days) {
    value.setUTCDate(value.getUTCDate() + opts.days);
  }

  return value.toISOString().slice(0, 10);
}

function shiftBusinessDays(date: string, businessDays: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  const direction = businessDays < 0 ? -1 : 1;
  let remaining = Math.abs(businessDays);

  while (remaining > 0) {
    value.setUTCDate(value.getUTCDate() + direction);
    const weekday = value.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      remaining -= 1;
    }
  }

  return value.toISOString().slice(0, 10);
}

function getTimeframeStartDate(endDate: string, timeframe: PortfolioTimeframe, seriesStartDate?: string): string {
  switch (timeframe) {
    case "5d":
      return shiftBusinessDays(endDate, -4);
    case "1m":
      return shiftIsoDate(endDate, { months: -1 });
    case "3m":
      return shiftIsoDate(endDate, { months: -3 });
    case "6m":
      return shiftIsoDate(endDate, { months: -6 });
    case "ytd": {
      const year = endDate.slice(0, 4);
      return `${year}-01-01`;
    }
    case "1y":
      return shiftIsoDate(endDate, { years: -1 });
    case "3y":
      return shiftIsoDate(endDate, { years: -3 });
    case "5y":
      return shiftIsoDate(endDate, { years: -5 });
    case "all":
      return seriesStartDate ?? shiftIsoDate(endDate, { years: -99 });
  }
}

function ensureAnchors<T extends { date: string }>(
  points: T[],
  original: T[]
): T[] {
  if (points.length === 0) {
    return original.length > 0 ? [original[original.length - 1]!] : [];
  }

  const result: T[] = [];
  const seen = new Set<string>();

  const first = points[0]!;
  const last = points[points.length - 1]!;
  for (const point of [first, ...points, last]) {
    const key = `${point.date}-${JSON.stringify(point)}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(point);
  }

  return result;
}

function sampleByWeek<T extends { date: string }>(points: T[]): T[] {
  const weekBuckets = new Map<string, T>();

  for (const point of points) {
    const value = new Date(`${point.date}T00:00:00.000Z`);
    const day = value.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(value);
    monday.setUTCDate(value.getUTCDate() + mondayOffset);
    const key = monday.toISOString().slice(0, 10);
    weekBuckets.set(key, point);
  }

  return Array.from(weekBuckets.values());
}

function sampleByMonth<T extends { date: string }>(points: T[]): T[] {
  const monthBuckets = new Map<string, T>();

  for (const point of points) {
    const key = point.date.slice(0, 7);
    monthBuckets.set(key, point);
  }

  return Array.from(monthBuckets.values());
}

function daysBetween(startDate: string, endDate: string): number {
  const a = new Date(`${startDate}T00:00:00.000Z`);
  const b = new Date(`${endDate}T00:00:00.000Z`);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

function applyTimeframeToSeries<T extends { date: string }>(
  series: T[],
  timeframe: PortfolioTimeframe
): T[] {
  if (series.length === 0) {
    return series;
  }

  const seriesStartDate = series[0]!.date;
  const endDate = series[series.length - 1]!.date;
  const startDate = getTimeframeStartDate(endDate, timeframe, seriesStartDate);
  const ranged = series.filter((point) => point.date >= startDate);

  if (ranged.length === 0) {
    return [series[series.length - 1]!];
  }

  if (timeframe === "5d") {
    return ranged;
  }

  if (timeframe === "1m" || timeframe === "3m" || timeframe === "6m") {
    return ensureAnchors(sampleByWeek(ranged), ranged);
  }

  if (timeframe === "all") {
    const spanDays = daysBetween(ranged[0]!.date, endDate);
    if (spanDays <= 180) {
      return ensureAnchors(sampleByWeek(ranged), ranged);
    }
    return ensureAnchors(sampleByMonth(ranged), ranged);
  }

  return ensureAnchors(sampleByMonth(ranged), ranged);
}

async function getReconstructedFromLatestBaseline(requestId?: string) {
  const baselines = getAllBaselines();
  const allTransactions = getAllTransactions();

  const anchor = getPortfolioAnchor(baselines, allTransactions);
  if (!anchor) {
    return { ok: false as const, error: "No portfolio data stored" };
  }

  let postBaselineTransactions = anchor.transactionsToApply;
  const trackedSymbols = collectTrackedSymbols(anchor.baseline, anchor.transactionsToApply);
  const today = new Date().toISOString().slice(0, 10);

  if (trackedSymbols.length > 0) {
    try {
      const splitResult = await fetchYahooFinanceStockSplits(
        trackedSymbols,
        anchor.baseline.date,
        today
      );

      postBaselineTransactions = mergeMarketSplitTransactions(
        anchor.transactionsToApply,
        splitResult.splits
      );

      if (requestId) {
        console.log(
          `[${requestId}] [portfolio] Using ${splitResult.splits.length} fetched market split event(s)`
        );
      }
    } catch (error) {
      if (requestId) {
        console.error(`[${requestId}] [portfolio] Stock split enrichment failed:`, error);
      }
    }
  }

  const state = reconstructState(anchor.baseline, postBaselineTransactions);

  return {
    ok: true as const,
    baseline: anchor.baseline,
    anchorType: anchor.anchorType,
    baselines,
    transactionsApplied: postBaselineTransactions.length,
    postBaselineTransactions,
    state,
    allTransactions,
  };
}

router.get("/", async (_req, res) => {
  const reconstructed = await getReconstructedFromLatestBaseline();

  if (!reconstructed.ok) {
    res.status(404).json({ error: reconstructed.error });
    return;
  }

  const negativeHoldings: Array<{ symbol: string; quantity: number }> = [];
  for (const [symbol, quantity] of Object.entries(reconstructed.state.holdings)) {
    if (quantity < 0) {
      negativeHoldings.push({ symbol, quantity });
    }
  }

  res.status(200).json({
    anchorType: reconstructed.anchorType,
    baselineDate: reconstructed.baseline.date,
    baselinesStored: reconstructed.baselines.length,
    transactionsStored: reconstructed.allTransactions.length,
    transactionsApplied: reconstructed.transactionsApplied,
    state: reconstructed.state,
    warnings:
      negativeHoldings.length > 0
        ? [
            {
              type: "NEGATIVE_HOLDINGS",
              details: negativeHoldings,
            },
          ]
        : undefined,
  });
});

router.get("/history", (_req, res) => {
  const baselines = getAllBaselines();
  const transactions = getAllTransactions();
  const uploads = getUploads();
  const anchor = getPortfolioAnchor(baselines, transactions);

  res.status(200).json({
    anchorType: anchor?.anchorType ?? null,
    currentAnchorDate: anchor?.baseline.date ?? null,
    baselines: baselines
      .map((baseline, index) => ({ baseline, index }))
      .sort((left, right) => {
        if (left.baseline.date < right.baseline.date) return -1;
        if (left.baseline.date > right.baseline.date) return 1;
        return left.index - right.index;
      })
      .map((item) => item.baseline),
    uploads: uploads
      .map((upload, index) => ({ upload, index }))
      .sort((left, right) => {
        if (left.upload.uploadedAt > right.upload.uploadedAt) return -1;
        if (left.upload.uploadedAt < right.upload.uploadedAt) return 1;
        return right.index - left.index;
      })
      .map((item) => item.upload),
    totals: {
      baselines: baselines.length,
      transactions: transactions.length,
      uploads: uploads.length,
    },
  });
});

router.get("/value", async (req, res) => {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  console.log(`[${requestId}] [portfolio/value] Incoming request: ${req.query.pricingMethod || 'default'}/${req.query.timeframe || 'default'}`);

  const requestedMethod = resolvePricingMethod(req.query.pricingMethod);
  if (req.query.pricingMethod !== undefined && requestedMethod === null) {
    console.log(`[${requestId}] [portfolio/value] Invalid pricingMethod`);
    res.status(400).json({
      error:
        "Invalid pricingMethod. Use one of: transaction_forward_fill, google_finance, stooq_free_live, yahoo_finance",
    });
    return;
  }

  const requestedTimeframe = resolveTimeframe(req.query.timeframe);
  if (req.query.timeframe !== undefined && requestedTimeframe === null) {
    console.log(`[${requestId}] [portfolio/value] Invalid timeframe`);
    res.status(400).json({
      error: "Invalid timeframe. Use one of: 5d, 1m, 3m, 6m, ytd, 1y, 3y, 5y, all",
    });
    return;
  }

  const pricingMethod = requestedMethod ?? ACTIVE_PRICING_METHOD;
  const timeframe = requestedTimeframe ?? DEFAULT_TIMEFRAME;

  // Prevent hanging requests - set a hard 90 second timeout for the entire request
  const timeoutHandle = setTimeout(() => {
    console.error(`[${requestId}] [portfolio/value] TIMEOUT: Request exceeded 90 seconds`);
    if (!res.headersSent) {
      res.status(504).json({ error: "Request timeout" });
    }
  }, 90000);

  try {
    console.log(`[${requestId}] [portfolio/value] Enqueueing request with queue depth: ${requestQueue.length + activeRequests}`);
    const result = await enqueueRequest(async () => {
      console.log(`[${requestId}] [portfolio/value] Processing request: ${pricingMethod}/${timeframe}`);
      
      const reconstructed = await getReconstructedFromLatestBaseline(requestId);

      if (!reconstructed.ok) {
        throw new Error(reconstructed.error);
      }

      const priceHistory: PriceHistory = {};

      for (const tx of reconstructed.allTransactions) {
        if (tx.symbol === null || tx.price === null) continue;

        if (!priceHistory[tx.symbol]) {
          priceHistory[tx.symbol] = [];
        }

        priceHistory[tx.symbol]!.push({
          date: tx.date,
          price: tx.price,
        });
      }

      if (pricingMethod === "transaction_forward_fill" && reconstructed.baseline.holdingPrices) {
        for (const [symbol, price] of Object.entries(reconstructed.baseline.holdingPrices)) {
          if (!priceHistory[symbol]) {
            priceHistory[symbol] = [];
          }

          priceHistory[symbol]!.push({
            date: reconstructed.baseline.date,
            price,
          });
        }
      }

      let livePriceFetch: { fetchedSymbols: string[]; failedSymbols: string[] } | null = null;
      const today = new Date().toISOString().slice(0, 10);

      if (pricingMethod === "stooq_free_live" || pricingMethod === "google_finance" || pricingMethod === "yahoo_finance") {
        const symbols = Object.entries(reconstructed.state.holdings)
          .filter(([, quantity]) => quantity !== 0)
          .map(([symbol]) => symbol);

        if (symbols.length > 0) {
          console.log(`[${requestId}] [portfolio/value] Fetching prices for ${symbols.length} symbols via ${pricingMethod}`);

          let historicalResult: { history: Record<string, Array<{ date: string; price: number }>>; fetchedSymbols: string[]; failedSymbols: string[] };
          try {
            const fetchPromise =
              pricingMethod === "yahoo_finance"
                ? fetchYahooFinanceHistoricalPrices(symbols, reconstructed.baseline.date, today)
                : fetchStooqHistoricalPrices(symbols, reconstructed.baseline.date, today);
            
            historicalResult = await Promise.race([
              fetchPromise,
              new Promise<typeof historicalResult>((_, reject) =>
                setTimeout(() => reject(new Error("Historical price fetch timeout")), 60000)
              )
            ]);
            console.log(`[${requestId}] [portfolio/value] Historical prices fetched for ${historicalResult.fetchedSymbols.length} symbols`);
          } catch (histErr) {
            console.error(`[${requestId}] [portfolio/value] Historical price fetch failed:`, histErr);
            historicalResult = { history: {}, fetchedSymbols: [], failedSymbols: symbols };
          }

          for (const [symbol, points] of Object.entries(historicalResult.history)) {
            if (!priceHistory[symbol]) {
              priceHistory[symbol] = [];
            }

            for (const point of points as Array<{ date: string; price: number }>) {
              if (
                point.date === reconstructed.baseline.date &&
                reconstructed.baseline.holdingPrices?.[symbol] !== undefined
              ) {
                continue;
              }

              priceHistory[symbol]!.push(point);
            }
          }

          let result: { livePrices: Record<string, number>; fetchedSymbols: string[]; failedSymbols: string[] };
          try {
            const livePromise =
              pricingMethod === "google_finance"
                ? fetchGoogleFinanceLatestPrices(symbols)
                : pricingMethod === "stooq_free_live"
                  ? fetchStooqLatestPrices(symbols)
                  : fetchYahooFinanceLatestPrices(symbols);
            
            result = await Promise.race([
              livePromise,
              new Promise<typeof result>((_, reject) =>
                setTimeout(() => reject(new Error("Live price fetch timeout")), 30000)
              )
            ]);
            console.log(`[${requestId}] [portfolio/value] Live prices fetched for ${result.fetchedSymbols.length} symbols`);
          } catch (liveErr) {
            console.error(`[${requestId}] [portfolio/value] Live price fetch failed:`, liveErr);
            result = { livePrices: {}, fetchedSymbols: [], failedSymbols: symbols };
          }

          livePriceFetch = {
            fetchedSymbols: Array.from(
              new Set([...historicalResult.fetchedSymbols, ...result.fetchedSymbols])
            ),
            failedSymbols: Array.from(
              new Set([...historicalResult.failedSymbols, ...result.failedSymbols])
            ),
          };

          for (const [symbol, price] of Object.entries(result.livePrices)) {
            if (!priceHistory[symbol]) {
              priceHistory[symbol] = [];
            }

            priceHistory[symbol]!.push({
              date: today,
              price: price as number,
            });
          }
        }
      }

      const performance = calculatePerformance(
        reconstructed.baseline,
        reconstructed.postBaselineTransactions,
        priceHistory
      );

      console.log(`[${requestId}] [portfolio/value] Fetching FX rates from ${reconstructed.baseline.date} to ${today}`);
      let fxPoints: Array<{ date: string; price: number }> = [];
      let currentUsdSgdRate: number | null = null;
      try {
        fxPoints = (await Promise.race([
          fetchUsdSgdHistory(reconstructed.baseline.date, today),
          new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error("FX fetch timeout")), 30000)
          )
        ])) as Array<{ date: string; price: number }>;
        currentUsdSgdRate = fxPoints.length > 0 ? fxPoints[fxPoints.length - 1]!.price : null;
        console.log(`[${requestId}] [portfolio/value] FX fetch completed: ${fxPoints.length} points, rate=${currentUsdSgdRate}`);
      } catch (fxErr) {
        console.error(`[${requestId}] [portfolio/value] FX fetch failed:`, fxErr);
        fxPoints = [];
        currentUsdSgdRate = null;
      }

      // Calculate TWR/IRR on the FULL unsampled series to preserve all deposit/withdrawal dates
      const fullTransactionsUsd: NormalizedTransaction[] = reconstructed.postBaselineTransactions.map((tx) => {
        if (tx.type === "DEPOSIT" || tx.type === "WITHDRAWAL") {
          return { ...tx, amount: convertSgdToUsd(tx.amount, tx.date, fxPoints) };
        }
        return tx;
      });

      // First, sample the series for the requested timeframe
      const sampledSeries = applyTimeframeToSeries(performance.series, timeframe);

      const latestPoint = sampledSeries[sampledSeries.length - 1];
      const startPoint = sampledSeries[0];

      // Now filter transactions to only those within the sampled timeframe range
      const timeframeTransactionsUsd =
        startPoint && latestPoint
          ? fullTransactionsUsd.filter(
              (tx) => tx.date >= startPoint.date && tx.date <= latestPoint.date
            )
          : [];

      // Calculate TWR and IRR on the SAMPLED series and FILTERED transactions
      // This makes metrics change per timeframe
      const sampledTwr = calculateTwr(sampledSeries, timeframeTransactionsUsd);
      const sampledIrr = calculateIrr(sampledSeries, timeframeTransactionsUsd);
      const sampledTwrFactorSeries = buildTwrFactorSeries(sampledSeries, timeframeTransactionsUsd);

      const sampledTotalReturn =
        startPoint && latestPoint && startPoint.totalValue !== 0
          ? (latestPoint.totalValue - startPoint.totalValue) / startPoint.totalValue
          : undefined;

      // Compute per-position values using the latest price available in priceHistory
      // (after live fetch, each symbol's last entry is today's price).
      const getLatestPrice = buildTransactionPriceProvider(priceHistory);
      const positionValues: Record<string, number> = {};
      for (const [symbol, quantity] of Object.entries(reconstructed.state.holdings)) {
        const price = getLatestPrice(symbol, today);
        if (price !== undefined && quantity !== 0) {
          positionValues[symbol] = quantity * price;
        }
      }

      if (!latestPoint) {
        console.log(`[${requestId}] [portfolio/value] No latest point, returning empty response`);
        return {
          date: reconstructed.state.date,
          holdingsValue: 0,
          totalValue: 0,
          startDate: performance.startDate,
          endDate: performance.endDate,
          totalReturn: sampledTotalReturn,
          twr: sampledTwr,
          irr: sampledIrr,
          twrSeries: sampledTwrFactorSeries,
          series: sampledSeries,
          positionValues,
          pricingMethod,
          timeframe,
          usdSgdRate: currentUsdSgdRate,
          livePriceFetch,
        };
      }

      const missingPriceSymbols: string[] = [];
      for (const symbol of Object.keys(reconstructed.state.holdings)) {
        if (!priceHistory[symbol] || priceHistory[symbol]!.length === 0) {
          missingPriceSymbols.push(symbol);
        }
      }

      console.log(`[${requestId}] [portfolio/value] Request completed successfully`);
      return {
        date: latestPoint.date,
        holdingsValue: latestPoint.holdingsValue,
        totalValue: latestPoint.totalValue,
        startDate: sampledSeries[0]!.date,
        endDate: latestPoint.date,
        totalReturn: sampledTotalReturn,
        twr: sampledTwr,
        irr: sampledIrr,
        twrSeries: sampledTwrFactorSeries,
        series: sampledSeries,
        positionValues,
        pricingMethod,
        timeframe,
        usdSgdRate: currentUsdSgdRate,
        missingPriceSymbols,
        livePriceFetch,
      };
    });

    clearTimeout(timeoutHandle);
    console.log(`[${requestId}] [portfolio/value] Sending response`);
    res.status(200).json(result);
  } catch (error) {
    clearTimeout(timeoutHandle);
    console.error(`[${requestId}] [portfolio/value] Error:`, error);
    if (!res.headersSent) {
      const message =
        error instanceof Error ? error.message : "Failed to calculate portfolio value";
      res.status(500).json({ error: message });
    }
  }
});

export default router;
