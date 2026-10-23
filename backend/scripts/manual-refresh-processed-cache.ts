import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import type { Baseline, Transaction, Upload } from '../src/parsers.js';
import { getPortfolioAnchor } from '../src/portfolioState.js';
import { reconstructState, sortTransactions } from '../src/reconstruction.js';
import { collectTrackedSymbols, mergeMarketSplitTransactions } from '../src/marketSplits.js';
import { fetchYahooFinanceStockSplits } from '../src/pricing.js';
import {
  buildPortfolioValueResponse,
  PORTFOLIO_TIMEFRAMES,
  PORTFOLIO_TWR_MODES,
  expandManualLinearOptionTransactions,
  normalizeBankTransferPairsForAnalytics,
  sanitizeTransactionsForAnalytics,
} from '../src/routes/portfolio.js';

const manualRefreshEnvPath = path.resolve(process.cwd(), '.env.manual-refresh');
if (fs.existsSync(manualRefreshEnvPath)) {
  dotenv.config({ path: manualRefreshEnvPath, override: true });
} else {
  dotenv.config();
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment');
}

const headers = {
  apikey: supabaseKey,
  Authorization: `Bearer ${supabaseKey}`,
  'Content-Type': 'application/json',
};

const MANUAL_REFRESH_CONCURRENCY = Math.max(1, Number(process.env.MANUAL_REFRESH_CONCURRENCY ?? '1'));

function toJsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function isSameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function logInfo(message: string, details?: Record<string, unknown>) {
  if (details) {
    console.log(`[manual-refresh] ${message}`, details);
    return;
  }
  console.log(`[manual-refresh] ${message}`);
}

function logCoverageReport(valuePayload: { byTimeframe?: Record<string, Record<string, any>> }) {
  const byTimeframe = valuePayload.byTimeframe ?? {};
  const entries: Array<{
    timeframe: string;
    twrMode: string;
    missingSymbols: string[];
    failedSymbols: string[];
  }> = [];

  for (const [timeframe, byMode] of Object.entries(byTimeframe)) {
    for (const [twrMode, payload] of Object.entries(byMode ?? {})) {
      const missingSymbols = Array.isArray(payload?.missingPriceSymbols)
        ? payload.missingPriceSymbols.filter((symbol: unknown): symbol is string => typeof symbol === 'string')
        : [];
      const failedSymbols = Array.isArray(payload?.livePriceFetch?.failedSymbols)
        ? payload.livePriceFetch.failedSymbols.filter((symbol: unknown): symbol is string => typeof symbol === 'string')
        : [];

      entries.push({ timeframe, twrMode, missingSymbols, failedSymbols });
    }
  }

  const combosWithMissing = entries.filter((entry) => entry.missingSymbols.length > 0 || entry.failedSymbols.length > 0);
  if (combosWithMissing.length === 0) {
    logInfo('Coverage report', {
      combinationsChecked: entries.length,
      combinationsWithGaps: 0,
      status: 'all combinations have full symbol price coverage',
    });
    return;
  }

  const allMissing = new Set<string>();
  const allFailed = new Set<string>();
  for (const entry of combosWithMissing) {
    for (const symbol of entry.missingSymbols) allMissing.add(symbol);
    for (const symbol of entry.failedSymbols) allFailed.add(symbol);
  }

  logInfo('Coverage report summary', {
    combinationsChecked: entries.length,
    combinationsWithGaps: combosWithMissing.length,
    uniqueMissingSymbols: [...allMissing].sort((a, b) => a.localeCompare(b)),
    uniqueYahooFailedSymbols: [...allFailed].sort((a, b) => a.localeCompare(b)),
  });

  for (const entry of combosWithMissing) {
    logInfo('Coverage gap detail', {
      timeframe: entry.timeframe,
      twrMode: entry.twrMode,
      missingCount: entry.missingSymbols.length,
      failedFetchCount: entry.failedSymbols.length,
      missingSymbols: entry.missingSymbols,
      failedSymbols: entry.failedSymbols,
    });
  }
}

async function readSupabaseDocument<T>(key: string): Promise<T | null> {
  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/cache_documents?key=eq.${encodeURIComponent(key)}&select=key,value`, {
      method: 'GET',
      headers: {
        ...headers,
        Prefer: 'return=minimal',
      },
    });

    if (!response.ok) {
      return null;
    }

    const rows = (await response.json()) as Array<{ key: string; value: T }>;
    return rows[0]?.value ?? null;
  } catch (error) {
    console.error(`[manual-refresh] Could not read ${key} from Supabase:`, error);
    return null;
  }
}

async function writeSupabaseDocument<T>(key: string, value: T): Promise<void> {
  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/cache_documents?on_conflict=key`, {
      method: 'POST',
      headers: {
        ...headers,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ key, value }),
    });

    if (!response.ok) {
      const payload = await response.text();
      throw new Error(`Failed to write ${key}: ${response.status} ${payload}`);
    }
  } catch (error) {
    console.error(`[manual-refresh] Could not write ${key} to Supabase:`, error);
    throw error;
  }
}

function buildWarnings(reconstructed: { holdings: Record<string, number> }) {
  const warnings: Array<{ type: string; details: unknown }> = [];

  for (const [symbol, quantity] of Object.entries(reconstructed.holdings)) {
    if (quantity < 0) {
      warnings.push({ type: 'NEGATIVE_HOLDINGS', details: { symbol, quantity } });
    }
  }

  return warnings;
}

async function buildPortfolioSnapshot(baselines: Baseline[], transactions: Transaction[]) {
  const cleaned = normalizeBankTransferPairsForAnalytics(sanitizeTransactionsForAnalytics(transactions));
  const anchor = getPortfolioAnchor(baselines, cleaned);
  const trackedSymbols = collectTrackedSymbols(anchor.baseline, anchor.transactionsToApply);
  const splitStart = anchor.baseline?.date ?? (anchor.transactionsToApply[0]?.date ?? '1970-01-01');
  const splitEnd = new Date().toISOString().slice(0, 10);

  logInfo('Preparing portfolio snapshot', {
    anchorType: anchor.anchorType,
    baselineDate: anchor.baselineDate ?? null,
    trackedSymbolsCount: trackedSymbols.length,
    trackedSymbols,
    yahooSplitQueryWindow: { start: splitStart, end: splitEnd },
  });

  let effectiveTransactions = [...anchor.transactionsToApply];

  try {
    const splitResult = await fetchYahooFinanceStockSplits(trackedSymbols, splitStart, splitEnd);
    const splitCounts = Object.fromEntries(
      Object.entries(splitResult.splits).map(([symbol, entries]) => [symbol, entries.length]),
    );
    const totalSplitEvents = Object.values(splitCounts).reduce((sum, count) => sum + count, 0);
    logInfo('Yahoo split fetch complete', {
      symbolsQueried: trackedSymbols.length,
      symbolsWithSplits: Object.keys(splitCounts).length,
      totalSplitEvents,
      splitCounts,
    });

    effectiveTransactions = mergeMarketSplitTransactions(anchor.transactionsToApply, splitResult.splits);
    logInfo('Applied split merge to transaction stream', {
      transactionsBeforeMerge: anchor.transactionsToApply.length,
      transactionsAfterMerge: effectiveTransactions.length,
      splitTransactionsInjected: effectiveTransactions.length - anchor.transactionsToApply.length,
    });
  } catch (error) {
    console.warn('[manual-refresh] Stock split refresh failed, using raw transaction stream:', error);
  }

  const expandedTransactions = sortTransactions(expandManualLinearOptionTransactions(effectiveTransactions));
  const reconstructed = reconstructState(anchor.baseline, expandedTransactions);

  return {
    anchorType: anchor.anchorType,
    baselineDate: anchor.baselineDate ?? null,
    baselinesStored: baselines.length,
    transactionsStored: cleaned.length,
    transactionsApplied: expandedTransactions.length,
    state: {
      date: new Date().toISOString().slice(0, 10),
      holdings: reconstructed.holdings,
      cash: reconstructed.cash,
    },
    warnings: buildWarnings(reconstructed),
  };
}

function buildPortfolioHistory(baselines: Baseline[], uploads: Upload[], transactions: Transaction[]) {
  const cleaned = normalizeBankTransferPairsForAnalytics(sanitizeTransactionsForAnalytics(transactions));
  const anchor = getPortfolioAnchor(baselines, cleaned);

  return {
    anchorType: anchor.anchorType,
    currentAnchorDate: anchor.baselineDate ?? null,
    baselines,
    uploads,
    totals: {
      baselines: baselines.length,
      transactions: cleaned.length,
      uploads: uploads.length,
    },
  };
}

async function buildPortfolioValue(baselines: Baseline[], transactions: Transaction[], uploads: Upload[]) {
  const pricingMethod = 'yahoo_finance';
  const byTimeframe: Record<string, Record<string, unknown>> = {};

  logInfo('Precompute concurrency settings', {
    totalCombinations: PORTFOLIO_TIMEFRAMES.length * PORTFOLIO_TWR_MODES.length,
    concurrency: MANUAL_REFRESH_CONCURRENCY,
    mode: MANUAL_REFRESH_CONCURRENCY <= 1 ? 'serial' : 'concurrent',
  });

  if (MANUAL_REFRESH_CONCURRENCY <= 1) {
    for (const timeframe of PORTFOLIO_TIMEFRAMES) {
      byTimeframe[timeframe] = {};

      for (const twrMode of PORTFOLIO_TWR_MODES) {
        logInfo('Precomputing portfolio value payload', {
          timeframe,
          twrMode,
          pricingMethod,
        });

        const payload = await buildPortfolioValueResponse({
          timeframe,
          pricingMethod,
          twrMode,
          includeDebug: false,
          baselines,
          transactions,
          uploads,
        });

        byTimeframe[timeframe][twrMode] = payload;
      }
    }
  } else {
    type Combo = { timeframe: (typeof PORTFOLIO_TIMEFRAMES)[number]; twrMode: (typeof PORTFOLIO_TWR_MODES)[number] };
    const combos: Combo[] = [];

    for (const timeframe of PORTFOLIO_TIMEFRAMES) {
      byTimeframe[timeframe] = {};
      for (const twrMode of PORTFOLIO_TWR_MODES) {
        combos.push({ timeframe, twrMode });
      }
    }

    const totalCombos = combos.length;
    let completedCombos = 0;

    const runCombo = async ({ timeframe, twrMode }: Combo) => {
      logInfo('Precomputing portfolio value payload', {
        timeframe,
        twrMode,
        pricingMethod,
      });

      const payload = await buildPortfolioValueResponse({
        timeframe,
        pricingMethod,
        twrMode,
        includeDebug: false,
        baselines,
        transactions,
        uploads,
      });

      byTimeframe[timeframe][twrMode] = payload;
      completedCombos += 1;

      if (completedCombos % 3 === 0 || completedCombos === totalCombos) {
        logInfo('Precompute progress', {
          completed: completedCombos,
          total: totalCombos,
        });
      }
    };

    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(MANUAL_REFRESH_CONCURRENCY, totalCombos) }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= totalCombos) {
          return;
        }

        await runCombo(combos[currentIndex]);
      }
    });

    await Promise.all(workers);
  }

  return {
    generatedAt: new Date().toISOString(),
    pricingMethod,
    byTimeframe,
  };
}

async function main() {
  logInfo('Starting processed-cache refresh run', {
    envPath: fs.existsSync(manualRefreshEnvPath) ? '.env.manual-refresh' : '.env',
  });

  const baselines = (await readSupabaseDocument<Baseline[]>('baselines')) ?? [];
  const transactions = (await readSupabaseDocument<Transaction[]>('transactions')) ?? [];
  const uploads = (await readSupabaseDocument<Upload[]>('uploads')) ?? [];

  logInfo('Loaded source documents from Supabase', {
    baselines: baselines.length,
    transactions: transactions.length,
    uploads: uploads.length,
  });

  const previousSnapshot = await readSupabaseDocument<Record<string, unknown>>('portfolio_snapshot');
  const previousHistory = await readSupabaseDocument<Record<string, unknown>>('portfolio_history');
  const previousValue = await readSupabaseDocument<Record<string, unknown>>('portfolio_value');

  const snapshot = await buildPortfolioSnapshot(baselines, transactions);
  const history = buildPortfolioHistory(baselines, uploads, transactions);
  const value = await buildPortfolioValue(baselines, transactions, uploads);
  logCoverageReport(value as { byTimeframe?: Record<string, Record<string, any>> });

  const writeTasks: Promise<void>[] = [];

  if (isSameJson(previousSnapshot, snapshot)) {
    logInfo('No changes detected for Supabase document', {
      key: 'portfolio_snapshot',
      action: 'skipped',
      sizeBytes: toJsonSize(snapshot),
    });
  } else {
    logInfo('Changes detected for Supabase document', {
      key: 'portfolio_snapshot',
      action: 'upserting',
      previousSizeBytes: previousSnapshot ? toJsonSize(previousSnapshot) : 0,
      nextSizeBytes: toJsonSize(snapshot),
    });
    writeTasks.push(writeSupabaseDocument('portfolio_snapshot', snapshot));
  }

  if (isSameJson(previousHistory, history)) {
    logInfo('No changes detected for Supabase document', {
      key: 'portfolio_history',
      action: 'skipped',
      sizeBytes: toJsonSize(history),
    });
  } else {
    logInfo('Changes detected for Supabase document', {
      key: 'portfolio_history',
      action: 'upserting',
      previousSizeBytes: previousHistory ? toJsonSize(previousHistory) : 0,
      nextSizeBytes: toJsonSize(history),
    });
    writeTasks.push(writeSupabaseDocument('portfolio_history', history));
  }

  if (isSameJson(previousValue, value)) {
    logInfo('No changes detected for Supabase document', {
      key: 'portfolio_value',
      action: 'skipped',
      sizeBytes: toJsonSize(value),
    });
  } else {
    logInfo('Changes detected for Supabase document', {
      key: 'portfolio_value',
      action: 'upserting',
      previousSizeBytes: previousValue ? toJsonSize(previousValue) : 0,
      nextSizeBytes: toJsonSize(value),
    });
    writeTasks.push(writeSupabaseDocument('portfolio_value', value));
  }

  await Promise.all(writeTasks);

  console.log('[manual-refresh] Processed cache refreshed in Supabase');
  console.log(`[manual-refresh] snapshot=${snapshot.baselinesStored} baselines / ${snapshot.transactionsStored} txns`);
  console.log(`[manual-refresh] history=${history.totals.baselines} baselines / ${history.totals.transactions} txns / ${history.totals.uploads} uploads`);
  logInfo('Refresh write summary', {
    documentsWritten: writeTasks.length,
    documentsSkipped: 3 - writeTasks.length,
  });
}

void main().catch((error) => {
  console.error('[manual-refresh] Failed to refresh processed cache:', error);
  process.exitCode = 1;
});
