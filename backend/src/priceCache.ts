import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRICE_CACHE_PATH = path.resolve(__dirname, '../data/price-cache.json');
const PRICE_RANGE_CACHE_PATH = path.resolve(__dirname, '../data/price-range-cache.json');

export type PriceCacheRecord = Record<string, Record<string, number>>;
export type PriceRangeCacheRecord = Record<string, Record<string, Array<{ date: string; price: number }>>>;

let cache: PriceCacheRecord = {};
let rangeCache: PriceRangeCacheRecord = {};

function readCache(): PriceCacheRecord {
  try {
    const file = fs.readFileSync(PRICE_CACHE_PATH, 'utf8');
    if (!file.trim()) {
      return {};
    }
    const parsed = JSON.parse(file) as PriceCacheRecord;
    return parsed ?? {};
  } catch {
    return {};
  }
}

function readRangeCache(): PriceRangeCacheRecord {
  try {
    const file = fs.readFileSync(PRICE_RANGE_CACHE_PATH, 'utf8');
    if (!file.trim()) {
      return {};
    }
    const parsed = JSON.parse(file) as PriceRangeCacheRecord;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export function loadPriceCache() {
  cache = readCache();
  rangeCache = readRangeCache();
}

export function getCachedPrice(symbol: string, date: string): number | null {
  const symbolCache = cache[symbol];
  if (!symbolCache) {
    return null;
  }
  return symbolCache[date] ?? null;
}

export function setCachedPrice(symbol: string, date: string, value: number) {
  if (!cache[symbol]) {
    cache[symbol] = {};
  }
  cache[symbol][date] = value;
  fs.writeFileSync(PRICE_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

export function getCachedPricesForSymbol(symbol: string): Record<string, number> {
  return { ...(cache[symbol] ?? {}) };
}

export function getCachedPriceRange(symbol: string, startDate: string, endDate: string) {
  const key = `${startDate}::${endDate}`;
  return rangeCache[symbol]?.[key] ? [...rangeCache[symbol][key]] : null;
}

export function setCachedPriceRange(symbol: string, startDate: string, endDate: string, points: Array<{ date: string; price: number }>) {
  if (!rangeCache[symbol]) {
    rangeCache[symbol] = {};
  }
  const key = `${startDate}::${endDate}`;
  rangeCache[symbol][key] = [...points];
  fs.writeFileSync(PRICE_RANGE_CACHE_PATH, `${JSON.stringify(rangeCache, null, 2)}\n`, 'utf8');
}

export function getPriceCache(): PriceCacheRecord {
  return { ...cache };
}
