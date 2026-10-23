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
  const splitBySymbolDate = new Map<string, number>();
  for (const [symbol, entries] of Object.entries(splits)) {
    for (const entry of entries) {
      if (!Number.isFinite(entry.ratio) || entry.ratio <= 0) {
        continue;
      }
      splitBySymbolDate.set(`${symbol}::${entry.date}`, entry.ratio);
    }
  }

  const merged = transactions.map((tx) => {
    if (tx.type !== 'SPLIT' || !tx.symbol) {
      return tx;
    }

    const key = `${tx.symbol}::${tx.date}`;
    const currentRatio = Number(tx.splitRatio ?? 0);
    if (Number.isFinite(currentRatio) && currentRatio > 0) {
      splitBySymbolDate.delete(key);
      return tx;
    }

    const marketRatio = splitBySymbolDate.get(key);
    if (marketRatio && marketRatio > 0) {
      splitBySymbolDate.delete(key);
      return {
        ...tx,
        splitRatio: marketRatio,
      };
    }

    return tx;
  });

  for (const [key, ratio] of splitBySymbolDate.entries()) {
    const [symbol, date] = key.split('::');
    merged.push({
      id: `market-split-${symbol}-${date}`,
      date,
      type: 'SPLIT',
      symbol,
      quantity: null,
      price: null,
      amount: 0,
      splitRatio: ratio,
      source: 'yahoo-finance',
    });
  }

  return merged.sort((a, b) => a.date.localeCompare(b.date));
}
