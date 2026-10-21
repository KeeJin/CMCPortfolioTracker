import YahooFinance from 'yahoo-finance2';
import { getCachedPrice, getCachedPriceRange, setCachedPrice, setCachedPriceRange } from './priceCache.js';

const YahooFinanceClient = YahooFinance as unknown as new (options?: { suppressNotices?: string[] }) => {
  chart: (symbol: string, options: Record<string, any>) => Promise<{ quotes?: Array<{ date?: Date | string | number; close?: number | null; adjclose?: number | null; open?: number | null }>; events?: { splits?: Array<{ date?: Date | string | number; splitRatio?: string }> } }>;
  quote: (symbol: string) => Promise<Record<string, any>>;
};
const yahooFinance = new YahooFinanceClient({ suppressNotices: ['ripHistorical'] });

export type PricePoint = {
  date: string;
  price: number;
};

export type FailedPriceFetch = {
  symbol: string;
  reason: string;
};

function toIso(dateValue: Date | string | number): string {
  const value = new Date(dateValue);
  return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
}

export async function fetchYahooFinanceHistoricalPrices(
  symbols: string[],
  startDate: string,
  endDate: string,
): Promise<{ history: Record<string, PricePoint[]>; fetchedSymbols: string[]; failedSymbols: string[]; failedDetails: FailedPriceFetch[] }> {
  const history: Record<string, PricePoint[]> = {};
  const fetchedSymbols: string[] = [];
  const failedSymbols: string[] = [];
  const failedDetails: FailedPriceFetch[] = [];

  type HistoricalRow = {
    date?: Date | string | number;
    close?: number | null;
    adjclose?: number | null;
    open?: number | null;
  };

  const period1 = Math.floor(new Date(`${startDate}T00:00:00Z`).getTime() / 1000);
  const period2 = Math.floor(new Date(`${endDate}T23:59:59Z`).getTime() / 1000);

  const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  };

  const tasks = symbols.map(async (symbol) => {
    const normalized = symbol.includes('=') ? symbol : symbol;
    const cachedRange = getCachedPriceRange(normalized, startDate, endDate);
    if (cachedRange && cachedRange.length > 0) {
      return {
        symbol: normalized,
        points: cachedRange,
        fromCache: true,
      };
    }

    try {
      const result = await withTimeout(
        yahooFinance.chart(normalized, {
          period1,
          period2,
          interval: '1d',
        }),
        10000,
      );

      const rows: HistoricalRow[] = result?.quotes ?? [];
      const points = rows
        .map((row: HistoricalRow) => ({
          date: toIso(row.date ?? ''),
          price: Number(row.close ?? row.adjclose ?? row.open ?? 0),
        }))
        .filter((point) => point.date && Number.isFinite(point.price));

      if (points.length === 0) {
        return {
          symbol: normalized,
          points: [] as PricePoint[],
          fromCache: false,
          error: 'no usable chart data returned for this date range',
        };
      }

      return {
        symbol: normalized,
        points,
        fromCache: false,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'fetch threw an exception';
      return {
        symbol: normalized,
        points: [] as PricePoint[],
        fromCache: false,
        error: reason,
      };
    }
  });

  const results = await Promise.all(tasks);
  for (const result of results) {
    const { symbol, points, fromCache } = result;
    if (result.error) {
      failedSymbols.push(symbol);
      failedDetails.push({ symbol, reason: result.error });
      continue;
    }

    history[symbol] = points;
    fetchedSymbols.push(symbol);

    if (!fromCache) {
      setCachedPriceRange(symbol, startDate, endDate, points);
      for (const point of points) {
        setCachedPrice(symbol, point.date, point.price);
      }
    }
  }

  return { history, fetchedSymbols, failedSymbols, failedDetails };
}

export async function fetchYahooFinanceLatestPrices(symbols: string[]) {
  const livePrices: Record<string, number> = {};
  const fetchedSymbols: string[] = [];
  const failedSymbols: string[] = [];
  const failedDetails: FailedPriceFetch[] = [];

  for (const symbol of symbols) {
    try {
      const quote: Record<string, any> = await yahooFinance.quote(symbol);
      const value = Number(quote.regularMarketPrice ?? quote.price ?? quote.close ?? quote.previousClose ?? 0);
      if (Number.isFinite(value)) {
        livePrices[symbol] = value;
        fetchedSymbols.push(symbol);
      } else {
        failedSymbols.push(symbol);
        failedDetails.push({ symbol, reason: 'quote returned an invalid or missing price value' });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'fetch threw an exception';
      failedSymbols.push(symbol);
      failedDetails.push({ symbol, reason });
    }
  }

  return { livePrices, fetchedSymbols, failedSymbols, failedDetails };
}

export async function fetchYahooFinanceStockSplits(symbols: string[], startDate: string, endDate: string) {
  const splits: Record<string, Array<{ date: string; ratio: number }>> = {};
  type SplitRow = {
    date?: Date | string | number;
    split?: string;
  };

  for (const symbol of symbols) {
    try {
      const period1 = Math.floor(new Date(`${startDate}T00:00:00Z`).getTime() / 1000);
      const period2 = Math.floor(new Date(`${endDate}T23:59:59Z`).getTime() / 1000);
      const result = await yahooFinance.chart(symbol, {
        period1,
        period2,
        interval: '1d',
        events: 'split',
      });
      const entries = (result?.events?.splits ?? [])
        .map((entry: { date?: Date | string | number; splitRatio?: string }) => {
          const raw = String(entry.splitRatio ?? '').trim();
          const splitTokens = raw.split(':').map((part) => Number(part));
          const ratio = splitTokens.length === 2 && splitTokens.every((value) => Number.isFinite(value) && value > 0)
            ? splitTokens[0] / splitTokens[1]
            : 0;
          return {
            date: toIso(entry.date ?? ''),
            ratio,
          };
        })
        .filter((entry) => entry.date && Number.isFinite(entry.ratio) && entry.ratio > 0);
      if (entries.length > 0) {
        splits[symbol] = entries;
      }
    } catch {
      // Keep best-effort behavior.
    }
  }
  return { splits };
}

export function getLatestPriceForSymbol(symbol: string, allHistory: Record<string, PricePoint[]>) {
  const points = allHistory[symbol] ?? [];
  if (points.length === 0) return null;
  return points[points.length - 1].price;
}
