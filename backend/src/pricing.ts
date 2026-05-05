import yahooFinance from "yahoo-finance2";
import {
  getCachedHistory,
  getCachedLivePrice,
  storePriceHistory,
  storeLivePrice,
  flushPriceCache,
} from "./priceCache.js";

// ─── Price abstraction layer ──────────────────────────────────────────────────
// All price lookups go through PriceProvider.
// Add new providers to PricingMethod and buildPriceProvider when integrating
// additional price sources.

export type PricePoint = {
  date: string;
  price: number;
};

// Symbol → chronologically sorted price points.
export type PriceHistory = Record<string, PricePoint[]>;

// Returns the price of a symbol at a given date (YYYY-MM-DD), or undefined
// if no price is available.
export type PriceProvider = (symbol: string, date: string) => number | undefined;

// Identifies which pricing strategy is active.
// Extend this union when adding new price sources.
export type PricingMethod =
  | "transaction_forward_fill"
  | "google_finance"
  | "stooq_free_live"
  | "yahoo_finance";

export type LivePriceFetchResult = {
  livePrices: Record<string, number>;
  fetchedSymbols: string[];
  failedSymbols: string[];
};

export type HistoricalPriceFetchResult = {
  history: PriceHistory;
  fetchedSymbols: string[];
  failedSymbols: string[];
};

export type StockSplitEvent = {
  symbol: string;
  date: string;
  splitRatio: number;
};

export type StockSplitFetchResult = {
  splits: StockSplitEvent[];
  fetchedSymbols: string[];
  failedSymbols: string[];
};

const STOOQ_BASE_URL = "https://stooq.com/q/l/";
const GOOGLE_FINANCE_BASE_URL = "https://www.google.com/finance/quote/";

// Instantiate Yahoo Finance client (required; it's a constructor, not a singleton)
// Type assertion needed as the package doesn't export proper type definitions for ESM.
// Suppress non-critical package notices to keep backend logs clean.
const yahooFinanceClient = new (yahooFinance as any)({
  suppressNotices: ["yahooSurvey"],
});

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function parseStockSplitRatio(splitText: string): number | null {
  const match = splitText.trim().match(/^(\d+):(\d+)$/);
  if (!match) {
    return null;
  }

  const numerator = Number.parseInt(match[1] ?? "0", 10);
  const denominator = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }

  return numerator / denominator;
}

function toStooqTicker(symbol: string): string {
  return `${symbol.trim().toLowerCase()}.us`;
}

function toStooqDateParam(date: string): string {
  return date.replace(/-/g, "");
}

function parseStooqCsv(csvText: string): Record<string, number> {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const parsed: Record<string, number> = {};

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const columns = line.split(",");
    if (columns.length < 7) {
      continue;
    }

    const symbolColumn = columns[0]!.trim();
    if (symbolColumn.toUpperCase() === "SYMBOL") {
      continue;
    }

    const closeColumn = columns[6]!.trim();

    // Stooq returns "N/D" when quote is unavailable.
    if (!symbolColumn || closeColumn === "N/D") {
      continue;
    }

    const close = Number(closeColumn);
    if (!Number.isFinite(close)) {
      continue;
    }

    parsed[symbolColumn.toUpperCase()] = close;
  }

  return parsed;
}

function parseStooqHistoricalCsv(csvText: string): PricePoint[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const points: PricePoint[] = [];

  for (const line of lines) {
    const columns = line.split(",");
    if (columns.length < 5) {
      continue;
    }

    const date = columns[0]!.trim();
    const closeText = columns[4]!.trim();

    if (date.toUpperCase() === "DATE") {
      continue;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      continue;
    }

    if (closeText === "N/D") {
      continue;
    }

    const close = Number(closeText);
    if (!Number.isFinite(close)) {
      continue;
    }

    points.push({ date, price: close });
  }

  points.sort((a, b) => {
    if (a.date < b.date) return -1;
    if (a.date > b.date) return 1;
    return 0;
  });

  return points;
}

async function fetchStooqChunk(chunk: string[]): Promise<Record<string, number>> {
  const url = new URL(STOOQ_BASE_URL);
  url.searchParams.set("s", chunk.map((symbol) => toStooqTicker(symbol)).join(","));
  url.searchParams.set("i", "d");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Stooq request failed with status ${response.status}`);
  }

  const csvText = await response.text();
  return parseStooqCsv(csvText);
}

async function fetchStooqHistoricalSymbol(
  symbol: string,
  startDate: string,
  endDate: string
): Promise<PricePoint[]> {
  const url = new URL("https://stooq.com/q/d/l/");
  url.searchParams.set("s", toStooqTicker(symbol));
  url.searchParams.set("i", "d");
  url.searchParams.set("d1", toStooqDateParam(startDate));
  url.searchParams.set("d2", toStooqDateParam(endDate));

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Stooq historical request failed with status ${response.status}`);
  }

  const csvText = await response.text();
  return parseStooqHistoricalCsv(csvText);
}

function parseGoogleFinanceLastPrice(htmlText: string): number | undefined {
  const dataLastPriceMatch = htmlText.match(/data-last-price="([^"]+)"/i);
  if (dataLastPriceMatch && dataLastPriceMatch[1]) {
    const parsed = Number(dataLastPriceMatch[1].replace(/,/g, ""));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const classPriceMatch = htmlText.match(/class="YMlKec\s+fxKbKc">\$?\s*([0-9.,]+)/i);
  if (classPriceMatch && classPriceMatch[1]) {
    const parsed = Number(classPriceMatch[1].replace(/,/g, ""));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function buildGoogleFinanceQuoteCandidates(symbol: string): string[] {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) {
    return [];
  }

  const baseSymbols = new Set<string>([normalized]);
  if (normalized.includes(".")) {
    baseSymbols.add(normalized.replace(/\./g, "-"));
  }

  const candidates: string[] = [];
  for (const base of baseSymbols) {
    if (base.includes(":")) {
      candidates.push(base);
      continue;
    }

    // Try common US exchanges in order.
    candidates.push(`${base}:NASDAQ`);
    candidates.push(`${base}:NYSE`);
    candidates.push(`${base}:NYSEARCA`);
    candidates.push(`${base}:AMEX`);
  }

  return candidates;
}

async function fetchGoogleFinanceQuote(symbol: string): Promise<number | undefined> {
  const candidates = buildGoogleFinanceQuoteCandidates(symbol);

  for (const candidate of candidates) {
    const url = new URL(`${GOOGLE_FINANCE_BASE_URL}${encodeURIComponent(candidate)}`);
    url.searchParams.set("hl", "en");

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
      });

      if (!response.ok) {
        continue;
      }

      const htmlText = await response.text();
      const price = parseGoogleFinanceLastPrice(htmlText);
      if (price !== undefined) {
        return price;
      }
    } catch {
      // Continue with best-effort candidate attempts.
      continue;
    }
  }

  return undefined;
}

// Fetches latest close prices from Stooq (free, no API key).
// Results are best-effort: unavailable symbols are reported in failedSymbols.
export async function fetchStooqLatestPrices(symbols: string[]): Promise<LivePriceFetchResult> {
  const uniqueSymbols = Array.from(
    new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter((symbol) => symbol.length > 0))
  );

  if (uniqueSymbols.length === 0) {
    return {
      livePrices: {},
      fetchedSymbols: [],
      failedSymbols: [],
    };
  }

  const stooqToSource: Record<string, string> = {};
  for (const symbol of uniqueSymbols) {
    stooqToSource[toStooqTicker(symbol).toUpperCase()] = symbol;
  }

  const livePrices: Record<string, number> = {};
  const chunks = chunkArray(uniqueSymbols, 1);

  for (const chunk of chunks) {
    try {
      const result = await fetchStooqChunk(chunk);
      for (const [stooqSymbol, price] of Object.entries(result)) {
        const sourceSymbol = stooqToSource[stooqSymbol];
        if (!sourceSymbol) {
          continue;
        }

        livePrices[sourceSymbol] = price;
      }
    } catch {
      // Keep best-effort behavior: a failed chunk should not break performance API.
      continue;
    }
  }

  const fetchedSymbols = Object.keys(livePrices);
  const fetchedSet = new Set(fetchedSymbols);
  const failedSymbols = uniqueSymbols.filter((symbol) => !fetchedSet.has(symbol));

  return {
    livePrices,
    fetchedSymbols,
    failedSymbols,
  };
}

// Fetches latest prices by scraping Google Finance quote pages.
// Results are best-effort: unavailable symbols are reported in failedSymbols.
export async function fetchGoogleFinanceLatestPrices(
  symbols: string[]
): Promise<LivePriceFetchResult> {
  const uniqueSymbols = Array.from(
    new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter((symbol) => symbol.length > 0))
  );

  if (uniqueSymbols.length === 0) {
    return {
      livePrices: {},
      fetchedSymbols: [],
      failedSymbols: [],
    };
  }

  const livePrices: Record<string, number> = {};
  for (const symbol of uniqueSymbols) {
    const price = await fetchGoogleFinanceQuote(symbol);
    if (price !== undefined) {
      livePrices[symbol] = price;
    }
  }

  const fetchedSymbols = Object.keys(livePrices);
  const fetchedSet = new Set(fetchedSymbols);
  const failedSymbols = uniqueSymbols.filter((symbol) => !fetchedSet.has(symbol));

  return {
    livePrices,
    fetchedSymbols,
    failedSymbols,
  };
}


// Fetches latest prices from Yahoo Finance using the official package.
// Results are best-effort: unavailable symbols are reported in failedSymbols.
export async function fetchYahooFinanceLatestPrices(
  symbols: string[]
): Promise<LivePriceFetchResult> {
  const uniqueSymbols = Array.from(
    new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter((symbol) => symbol.length > 0))
  );

  if (uniqueSymbols.length === 0) {
    return {
      livePrices: {},
      fetchedSymbols: [],
      failedSymbols: [],
    };
  }

  const livePrices: Record<string, number> = {};
  // Track symbols that need a live API call (cache miss or stale).
  const symbolsToFetch: string[] = [];

  // Check price cache first.
  for (const symbol of uniqueSymbols) {
    const cached = getCachedLivePrice(symbol);
    if (cached !== null) {
      livePrices[symbol] = cached;
    } else {
      symbolsToFetch.push(symbol);
    }
  }

  // Fetch remaining symbols from Yahoo Finance.
  for (const symbol of symbolsToFetch) {
    try {
      const quote = await yahooFinanceClient.quote(symbol, {
        fields: ["regularMarketPrice", "symbol"],
      });
      const price = quote.regularMarketPrice;
      if (typeof price === "number" && Number.isFinite(price)) {
        livePrices[symbol] = price;
        storeLivePrice(symbol, price);
      }
    } catch {
      continue;
    }
  }

  // Persist newly cached live prices.
  if (symbolsToFetch.length > 0) {
    flushPriceCache();
  }

  const fetchedSymbols = Object.keys(livePrices);
  const fetchedSet = new Set(fetchedSymbols);
  const failedSymbols = uniqueSymbols.filter((symbol) => !fetchedSet.has(symbol));

  return {
    livePrices,
    fetchedSymbols,
    failedSymbols,
  };
}

// Fetches daily historical closes from Yahoo Finance using chart() (historical() is deprecated upstream).
// Results are best-effort: unavailable symbols are reported in failedSymbols.
export async function fetchYahooFinanceHistoricalPrices(
  symbols: string[],
  startDate: string,
  endDate: string
): Promise<HistoricalPriceFetchResult> {
  const uniqueSymbols = Array.from(
    new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter((symbol) => symbol.length > 0))
  );

  const history: PriceHistory = {};
  const fetchedSymbols: string[] = [];
  // Track which symbols need a live API call (cache miss or stale).
  const symbolsToFetch: string[] = [];

  // Check price cache first for each symbol.
  for (const symbol of uniqueSymbols) {
    const cached = getCachedHistory(symbol, startDate, endDate);
    if (cached !== null) {
      history[symbol] = cached;
      fetchedSymbols.push(symbol);
    } else {
      symbolsToFetch.push(symbol);
    }
  }

  // Fetch remaining symbols from Yahoo Finance and populate the cache.
  for (const symbol of symbolsToFetch) {
    try {
      const chartResult = await yahooFinanceClient.chart(symbol, {
        period1: startDate,
        period2: endDate,
        interval: "1d",
        return: "array",
      });

      const rows = Array.isArray(chartResult?.quotes) ? chartResult.quotes : [];

      const pointByDate = new Map<string, PricePoint>();
      for (const row of rows) {
        // Use unadjusted close so prices are consistent with our split-event
        // quantity adjustments. adjclose retroactively divides all historical
        // prices by the split ratio, which would double-count the split when
        // our SPLIT transactions also multiply share counts.
        const price =
          typeof row.close === "number"
            ? row.close
            : typeof row.adjclose === "number"
              ? row.adjclose
              : undefined;

        if (!(row.date instanceof Date) || price === undefined || !Number.isFinite(price)) {
          continue;
        }

        pointByDate.set(row.date.toISOString().slice(0, 10), {
          date: row.date.toISOString().slice(0, 10),
          price,
        });
      }

      const points = Array.from(pointByDate.values()).sort((a, b) => {
        if (a.date < b.date) return -1;
        if (a.date > b.date) return 1;
        return 0;
      });

      if (points.length > 0) {
        history[symbol] = points;
        fetchedSymbols.push(symbol);
        // Store in cache (flush once after the full batch below).
        storePriceHistory(symbol, points);
      }
    } catch {
      continue;
    }
  }

  // Persist any newly cached data to disk after the full batch.
  if (symbolsToFetch.length > 0) {
    flushPriceCache();
  }

  const fetchedSet = new Set(fetchedSymbols);
  const failedSymbols = uniqueSymbols.filter((symbol) => !fetchedSet.has(symbol));

  return {
    history,
    fetchedSymbols,
    failedSymbols,
  };
}

// Fetches stock splits from Yahoo Finance for each symbol within a date range.
// Returns all split events with their ratios parsed from the string format.
export async function fetchYahooFinanceStockSplits(
  symbols: string[],
  startDate: string,
  endDate: string
): Promise<StockSplitFetchResult> {
  const uniqueSymbols = Array.from(
    new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter((symbol) => symbol.length > 0))
  );

  const splits: StockSplitEvent[] = [];
  const fetchedSymbols: string[] = [];

  for (const symbol of uniqueSymbols) {
    try {
      const historicalResult = await yahooFinanceClient.historical(symbol, {
        period1: startDate,
        period2: endDate,
        events: "split",
      });

      const splitEvents = Array.isArray(historicalResult)
        ? historicalResult
        : [];

      for (const event of splitEvents) {
        if (!(event.date instanceof Date) || typeof event.stockSplits !== "string") {
          continue;
        }

        const splitRatio = parseStockSplitRatio(event.stockSplits);
        if (splitRatio === null) {
          continue;
        }

        splits.push({
          symbol,
          date: event.date.toISOString().slice(0, 10),
          splitRatio,
        });
      }

      fetchedSymbols.push(symbol);
    } catch {
      continue;
    }
  }

  const fetchedSet = new Set(fetchedSymbols);
  const failedSymbols = uniqueSymbols.filter((symbol) => !fetchedSet.has(symbol));

  return {
    splits: splits.sort((a, b) => a.date.localeCompare(b.date)),
    fetchedSymbols,
    failedSymbols,
  };
}

// Fetches daily historical close prices from Stooq for each symbol.
// Results are best-effort: unavailable symbols are reported in failedSymbols.
export async function fetchStooqHistoricalPrices(
  symbols: string[],
  startDate: string,
  endDate: string
): Promise<HistoricalPriceFetchResult> {
  const uniqueSymbols = Array.from(
    new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter((symbol) => symbol.length > 0))
  );

  const history: PriceHistory = {};
  const fetchedSymbols: string[] = [];

  for (const symbol of uniqueSymbols) {
    try {
      const points = await fetchStooqHistoricalSymbol(symbol, startDate, endDate);
      if (points.length > 0) {
        history[symbol] = points;
        fetchedSymbols.push(symbol);
      }
    } catch {
      // Keep best-effort behavior: failed symbols are surfaced in metadata.
      continue;
    }
  }

  const fetchedSet = new Set(fetchedSymbols);
  const failedSymbols = uniqueSymbols.filter((symbol) => !fetchedSet.has(symbol));

  return {
    history,
    fetchedSymbols,
    failedSymbols,
  };
}

// ─── Provider dispatcher ─────────────────────────────────────────────────────
// Returns a PriceProvider for the given method.
// Add new cases here when integrating additional price sources.
export function buildPriceProvider(
  method: PricingMethod,
  priceHistory: PriceHistory
): PriceProvider {
  switch (method) {
    case "transaction_forward_fill":
      return buildTransactionPriceProvider(priceHistory);
    case "google_finance":
      throw new Error(
        "google_finance requires fetching quotes first; use fetchGoogleFinanceLatestPrices and feed results into price history"
      );
    case "stooq_free_live":
      throw new Error(
        "stooq_free_live requires fetching quotes first; use fetchStooqLatestPrices and feed results into price history"
      );
    case "yahoo_finance":
      throw new Error(
        "yahoo_finance requires fetching quotes first; use fetchYahooFinanceHistoricalPrices/fetchYahooFinanceLatestPrices and feed results into price history"
      );
  }
}

// ─── transaction_forward_fill ─────────────────────────────────────────────────
// Builds a PriceProvider from a sparse transaction-derived price history.
// For each symbol, the last known price on or before the requested date is
// returned (forward-fill). Dates with no transaction are valued at the
// previous trade price.
export function buildTransactionPriceProvider(priceHistory: PriceHistory): PriceProvider {
  // Pre-sort each symbol's points ascending by date once.
  const sorted: PriceHistory = {};

  for (const [symbol, points] of Object.entries(priceHistory)) {
    const copied = [...points];
    copied.sort((a, b) => {
      if (a.date < b.date) return -1;
      if (a.date > b.date) return 1;
      return 0;
    });
    sorted[symbol] = copied;
  }

  return function getPrice(symbol: string, date: string): number | undefined {
    const points = sorted[symbol];
    if (!points || points.length === 0) {
      return undefined;
    }

    let latest: number | undefined = undefined;

    for (const point of points) {
      if (point.date <= date) {
        latest = point.price;
      } else {
        break;
      }
    }

    return latest;
  };
}
