import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import type { Baseline, Transaction, Upload } from '../src/parsers.js';
import { getPortfolioAnchor } from '../src/portfolioState.js';
import { reconstructState, sortTransactions } from '../src/reconstruction.js';
import { collectTrackedSymbols, mergeMarketSplitTransactions } from '../src/marketSplits.js';
import { fetchYahooFinanceStockSplits } from '../src/pricing.js';
import {
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

  const reconstructed = reconstructState(anchor.baseline, sortTransactions(effectiveTransactions));

  return {
    anchorType: anchor.anchorType,
    baselineDate: anchor.baselineDate ?? null,
    baselinesStored: baselines.length,
    transactionsStored: cleaned.length,
    transactionsApplied: effectiveTransactions.length,
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

function buildPortfolioValue(baselines: Baseline[], transactions: Transaction[]) {
  const cleaned = normalizeBankTransferPairsForAnalytics(sanitizeTransactionsForAnalytics(transactions));
  const anchor = getPortfolioAnchor(baselines, cleaned);
  const state = reconstructState(anchor.baseline, sortTransactions(anchor.transactionsToApply));
  const now = new Date().toISOString().slice(0, 10);
  const totalValue = state.cash;

  return {
    date: now,
    holdingsValue: 0,
    totalValue,
    startDate: now,
    endDate: now,
    totalReturn: 0,
    netExternalFlow: 0,
    twr: 0,
    twrMode: 'invested_capital',
    accountTwr: 0,
    investedCapitalTwr: 0,
    pricingMethod: 'manual_refresh',
    timeframe: '1y',
    series: [
      {
        date: now,
        totalValue,
        holdingsValue: 0,
        cashValue: state.cash,
      },
    ],
    positionValues: Object.fromEntries(
      Object.entries(state.holdings).map(([symbol, quantity]) => [symbol, quantity * 0]),
    ),
    positionContributions: Object.fromEntries(
      Object.entries(state.holdings).map(([symbol]) => [symbol, 0]),
    ),
    realizedGains: Object.fromEntries(
      Object.entries(state.holdings).map(([symbol]) => [symbol, 0]),
    ),
    twrSymbolContributions: Object.fromEntries(
      Object.entries(state.holdings).map(([symbol]) => [symbol, 0]),
    ),
    twrUnattributedContribution: 0,
    twrResidualBreakdown: {
      symbolContributionTotal: 0,
      cashCarryContribution: 0,
      tradeTimingContribution: 0,
      residualRemainder: 0,
    },
    usdSgdRate: null,
    missingPriceSymbols: [],
    livePriceFetch: null,
    lastPriceSyncAt: null,
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
  const value = buildPortfolioValue(baselines, transactions);

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
