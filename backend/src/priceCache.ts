import { readJson, writeJson } from "./persistence.js";
import type { PricePoint } from "./pricing.js";

// ─── Price Cache ──────────────────────────────────────────────────────────────
// Historical price data is cached per-symbol to avoid redundant API calls.
// Past dates never change, so historical data is cached indefinitely.
// Today's live price has a shorter TTL (LIVE_PRICE_TTL_MS).

const LIVE_PRICE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CACHE_FILE = "price-cache.json";

type SymbolCacheEntry = {
  // date → adjusted close price
  points: Record<string, number>;
  // Earliest and latest dates present in this entry
  coverageStart: string;
  coverageEnd: string;
  // ISO timestamp of when this entry was last written (used for live TTL check)
  cachedAt: string;
};

type PriceCacheStore = Record<string, SymbolCacheEntry>;

// In-memory mirror of the on-disk cache.
let memCache: PriceCacheStore = {};

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export function loadPriceCache(): void {
  memCache = readJson<PriceCacheStore>(CACHE_FILE, {});
  const symbolCount = Object.keys(memCache).length;
  if (symbolCount > 0) {
    console.log(`[priceCache] Loaded ${symbolCount} cached symbols from disk`);
  }
}

function savePriceCache(): void {
  writeJson(CACHE_FILE, memCache);
}

// ─── Read ─────────────────────────────────────────────────────────────────────

// Returns cached price points for a symbol covering [startDate, endDate] if:
//   - The cache has data going back at least to startDate
//   - If endDate is today: the live price was fetched within LIVE_PRICE_TTL_MS
//   - If endDate is in the past: always serves from cache (historical data is immutable)
// Returns null on cache miss or stale live price.
export function getCachedHistory(
  symbol: string,
  startDate: string,
  endDate: string
): PricePoint[] | null {
  const entry = memCache[symbol];
  if (!entry) {
    return null;
  }

  const today = new Date().toISOString().slice(0, 10);
  const isRequestingToday = endDate >= today;

  // For requests up to today, check that the cached live price is still fresh.
  if (isRequestingToday) {
    const ageMs = Date.now() - new Date(entry.cachedAt).getTime();
    if (ageMs > LIVE_PRICE_TTL_MS) {
      return null;
    }
  }

  // The cache must cover the start of the requested range.
  if (entry.coverageStart > startDate) {
    return null;
  }

  // Extract and return points within the requested range.
  const points: PricePoint[] = Object.entries(entry.points)
    .filter(([date]) => date >= startDate && date <= endDate)
    .map(([date, price]) => ({ date, price }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return points.length > 0 ? points : null;
}

// Returns cached live (today's) price for a symbol if within TTL.
export function getCachedLivePrice(symbol: string): number | null {
  const entry = memCache[symbol];
  if (!entry) return null;

  const today = new Date().toISOString().slice(0, 10);
  const todayPrice = entry.points[today];
  if (todayPrice === undefined) return null;

  const ageMs = Date.now() - new Date(entry.cachedAt).getTime();
  if (ageMs > LIVE_PRICE_TTL_MS) return null;

  return todayPrice;
}

// ─── Write ────────────────────────────────────────────────────────────────────

// Merges fetched price points into the in-memory cache for a symbol.
// Does NOT flush to disk — call flushPriceCache() after a batch of stores.
export function storePriceHistory(symbol: string, points: PricePoint[]): void {
  if (points.length === 0) return;

  const existing = memCache[symbol];
  const merged: Record<string, number> = existing ? { ...existing.points } : {};

  for (const { date, price } of points) {
    merged[date] = price;
  }

  const dates = Object.keys(merged).sort();
  memCache[symbol] = {
    points: merged,
    coverageStart: dates[0]!,
    coverageEnd: dates[dates.length - 1]!,
    cachedAt: new Date().toISOString(),
  };
}

// Stores a single live (today's) price for a symbol.
// Does NOT flush to disk — call flushPriceCache() after a batch of stores.
export function storeLivePrice(symbol: string, price: number): void {
  const today = new Date().toISOString().slice(0, 10);
  const existing = memCache[symbol];
  const points: Record<string, number> = existing
    ? { ...existing.points, [today]: price }
    : { [today]: price };

  const dates = Object.keys(points).sort();
  memCache[symbol] = {
    points,
    coverageStart: dates[0]!,
    coverageEnd: dates[dates.length - 1]!,
    cachedAt: new Date().toISOString(),
  };
}

// Writes the current in-memory cache to disk.
// Call this once after a batch of storePriceHistory/storeLivePrice calls.
export function flushPriceCache(): void {
  savePriceCache();
}
