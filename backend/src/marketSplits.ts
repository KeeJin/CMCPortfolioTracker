import type { Baseline, Transaction } from './parsers.js';

export function collectTrackedSymbols(baseline: Baseline | null, transactions: Transaction[]) {
  const symbols = new Set<string>();
  if (baseline) {
    for (const symbol of Object.keys(baseline.holdings)) {
      symbols.add(symbol);
    }
  }
  for (const tx of transactions) {
    if (tx.symbol) {
      symbols.add(tx.symbol);
    }
  }
  return [...symbols];
}

export function mergeMarketSplitTransactions(transactions: Transaction[], splits: Record<string, Array<{ date: string; ratio: number }>>) {
  const merged = [...transactions];
  for (const [symbol, entries] of Object.entries(splits)) {
    for (const entry of entries) {
      merged.push({
        id: `market-split-${symbol}-${entry.date}`,
        date: entry.date,
        type: 'SPLIT',
        symbol,
        quantity: null,
        price: null,
        amount: 0,
        splitRatio: entry.ratio,
        source: 'yahoo-finance',
      });
    }
  }
  return merged.sort((a, b) => a.date.localeCompare(b.date));
}
