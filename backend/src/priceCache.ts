import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRICE_CACHE_PATH = path.resolve(__dirname, '../data/price-cache.json');
const PRICE_RANGE_CACHE_PATH = path.resolve(__dirname, '../data/price-range-cache.json');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export type PriceCacheRecord = Record<string, Record<string, number>>;
export type PriceRangeCacheRecord = Record<string, Record<string, Array<{ date: string; price: number }>>>;

let cache: PriceCacheRecord = {};
let rangeCache: PriceRangeCacheRecord = {};
let pendingSupabaseSyncTimer: NodeJS.Timeout | null = null;
let supabaseSyncInFlight = false;
let supabaseSyncQueued = false;
let lastSupabaseSyncWarningAt = 0;
let consecutiveSupabaseSyncFailures = 0;
let supabaseSyncDisabledUntil = 0;

const SUPABASE_SYNC_DEBOUNCE_MS = 300;
const SUPABASE_SYNC_WARNING_COOLDOWN_MS = 10_000;
const SUPABASE_SYNC_FAILURE_THRESHOLD = 3;
const SUPABASE_SYNC_DISABLE_MS = 60_000;

function reportSupabaseSyncFailure(message: string) {
  consecutiveSupabaseSyncFailures += 1;

  if (Date.now() - lastSupabaseSyncWarningAt > SUPABASE_SYNC_WARNING_COOLDOWN_MS) {
    lastSupabaseSyncWarningAt = Date.now();
    console.warn(message);
  }

  if (consecutiveSupabaseSyncFailures >= SUPABASE_SYNC_FAILURE_THRESHOLD) {
    supabaseSyncDisabledUntil = Date.now() + SUPABASE_SYNC_DISABLE_MS;
    consecutiveSupabaseSyncFailures = 0;
    if (Date.now() - lastSupabaseSyncWarningAt > SUPABASE_SYNC_WARNING_COOLDOWN_MS) {
      lastSupabaseSyncWarningAt = Date.now();
      console.warn('[price-cache] Temporarily disabling Supabase cache sync after repeated failures.');
    }
  }
}

function reportSupabaseSyncSuccess() {
  consecutiveSupabaseSyncFailures = 0;
}

function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

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

async function loadSupabaseCacheRecord(key: 'price-cache' | 'price-range-cache') {
  if (!isSupabaseConfigured() || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/cache_documents?key=eq.${encodeURIComponent(key)}&select=key,value`, {
      method: 'GET',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=minimal',
      },
    });

    if (!response.ok) {
      return null;
    }

    const rows = (await response.json()) as Array<{ key: string; value: unknown }>;
    const record = rows[0];
    return record ? record.value : null;
  } catch {
    return null;
  }
}

async function persistSupabaseCacheRecord(key: 'price-cache' | 'price-range-cache', value: unknown) {
  if (!isSupabaseConfigured() || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return;
  }

  if (Date.now() < supabaseSyncDisabledUntil) {
    return;
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/cache_documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ key, value }),
    });

    if (!response.ok) {
      reportSupabaseSyncFailure(`[price-cache] Failed to persist ${key} to Supabase: ${response.status}`);
      return;
    }

    reportSupabaseSyncSuccess();
  } catch (error) {
    // Price cache sync is best-effort and must not block portfolio refresh paths.
    const message = error instanceof Error ? error.message : String(error);
    reportSupabaseSyncFailure(`[price-cache] Failed to persist ${key} to Supabase: ${message}`);
  }
}

async function flushSupabaseCaches() {
  if (!isSupabaseConfigured()) {
    return;
  }

  if (supabaseSyncInFlight) {
    supabaseSyncQueued = true;
    return;
  }

  supabaseSyncInFlight = true;
  try {
    await Promise.all([
      persistSupabaseCacheRecord('price-cache', cache),
      persistSupabaseCacheRecord('price-range-cache', rangeCache),
    ]);
  } finally {
    supabaseSyncInFlight = false;
    if (supabaseSyncQueued) {
      supabaseSyncQueued = false;
      void flushSupabaseCaches();
    }
  }
}

function scheduleSupabaseCacheSync() {
  if (!isSupabaseConfigured()) {
    return;
  }

  if (pendingSupabaseSyncTimer) {
    clearTimeout(pendingSupabaseSyncTimer);
  }

  pendingSupabaseSyncTimer = setTimeout(() => {
    pendingSupabaseSyncTimer = null;
    void flushSupabaseCaches();
  }, SUPABASE_SYNC_DEBOUNCE_MS);
}

function persistLocalCaches() {
  fs.writeFileSync(PRICE_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  fs.writeFileSync(PRICE_RANGE_CACHE_PATH, `${JSON.stringify(rangeCache, null, 2)}\n`, 'utf8');

  scheduleSupabaseCacheSync();
}

export function loadPriceCache() {
  cache = readCache();
  rangeCache = readRangeCache();

  if (!isSupabaseConfigured()) {
    return;
  }

  void (async () => {
    try {
      const [priceCacheRecord, rangeCacheRecord] = await Promise.all([
        loadSupabaseCacheRecord('price-cache'),
        loadSupabaseCacheRecord('price-range-cache'),
      ]);

      if (priceCacheRecord && typeof priceCacheRecord === 'object') {
        cache = priceCacheRecord as PriceCacheRecord;
      }

      if (rangeCacheRecord && typeof rangeCacheRecord === 'object') {
        rangeCache = rangeCacheRecord as PriceRangeCacheRecord;
      }
    } catch {
      // Keep cache warm-up best-effort.
    }
  })();
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
  persistLocalCaches();
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
  persistLocalCaches();
}

export function getPriceCache(): PriceCacheRecord {
  return { ...cache };
}
