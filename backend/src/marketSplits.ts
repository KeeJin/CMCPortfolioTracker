import type { Baseline, NormalizedTransaction } from "./models/index.js";
import type { StockSplitEvent } from "./pricing.js";

export function collectTrackedSymbols(
  baseline: Baseline,
  transactions: NormalizedTransaction[]
): string[] {
  const symbols = new Set<string>();

  for (const symbol of Object.keys(baseline.holdings)) {
    const normalized = symbol.trim().toUpperCase();
    if (normalized.length > 0) {
      symbols.add(normalized);
    }
  }

  for (const transaction of transactions) {
    if (transaction.symbol === null) {
      continue;
    }

    const normalized = transaction.symbol.trim().toUpperCase();
    if (normalized.length > 0) {
      symbols.add(normalized);
    }
  }

  return Array.from(symbols).sort();
}

function toSplitKey(symbol: string, date: string, splitRatio: number): string {
  return `${symbol}|${date}|${splitRatio}`;
}

export function buildMarketSplitTransactions(
  splits: StockSplitEvent[]
): NormalizedTransaction[] {
  const seenKeys = new Set<string>();
  const transactions: NormalizedTransaction[] = [];

  for (const split of splits) {
    const symbol = split.symbol.trim().toUpperCase();
    const key = toSplitKey(symbol, split.date, split.splitRatio);

    if (seenKeys.has(key)) {
      continue;
    }

    seenKeys.add(key);
    transactions.push({
      id: `market-split-${symbol}-${split.date}-${split.splitRatio}`,
      date: split.date,
      type: "SPLIT",
      symbol,
      quantity: null,
      price: null,
      amount: 0,
      splitRatio: split.splitRatio,
      source: "yahoo_finance_split",
    });
  }

  return transactions;
}

export function mergeMarketSplitTransactions(
  transactions: NormalizedTransaction[],
  splits: StockSplitEvent[]
): NormalizedTransaction[] {
  const existingSplitKeys = new Set<string>();

  for (const transaction of transactions) {
    if (
      transaction.type !== "SPLIT" ||
      transaction.symbol === null ||
      transaction.splitRatio === null
    ) {
      continue;
    }

    existingSplitKeys.add(
      toSplitKey(transaction.symbol.trim().toUpperCase(), transaction.date, transaction.splitRatio)
    );
  }

  const marketSplitTransactions = buildMarketSplitTransactions(splits).filter((transaction) => {
    if (transaction.symbol === null || transaction.splitRatio === null) {
      return false;
    }

    return !existingSplitKeys.has(
      toSplitKey(transaction.symbol, transaction.date, transaction.splitRatio)
    );
  });

  return [...transactions, ...marketSplitTransactions].sort((left, right) => {
    if (left.date < right.date) return -1;
    if (left.date > right.date) return 1;
    return 0;
  });
}