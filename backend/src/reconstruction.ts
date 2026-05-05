import type { Baseline, NormalizedTransaction, PortfolioState } from "./models/index.js";

// Apply one normalized transaction to a mutable portfolio state.
export function applyTransaction(
  state: PortfolioState,
  tx: NormalizedTransaction
): PortfolioState {
  if (tx.type === "BUY") {
    if (tx.symbol === null || tx.quantity === null) {
      return state;
    }

    const current = state.holdings[tx.symbol] ?? 0;
    state.holdings[tx.symbol] = current + tx.quantity;
    state.cash = state.cash + tx.amount;
    state.date = tx.date;
    return state;
  }

  if (tx.type === "SELL") {
    if (tx.symbol === null || tx.quantity === null) {
      return state;
    }

    const current = state.holdings[tx.symbol] ?? 0;
    const next = current - tx.quantity;

    if (next === 0) {
      delete state.holdings[tx.symbol];
    } else {
      state.holdings[tx.symbol] = next;
    }

    state.cash = state.cash + tx.amount;
    state.date = tx.date;
    return state;
  }

  if (tx.type === "DIVIDEND") {
    state.cash = state.cash + tx.amount;
    state.date = tx.date;
    return state;
  }

  if (tx.type === "DEPOSIT") {
    state.cash = state.cash + tx.amount;
    state.date = tx.date;
    return state;
  }

  if (tx.type === "WITHDRAWAL") {
    state.cash = state.cash + tx.amount;
    state.date = tx.date;
    return state;
  }

  if (tx.type === "SPLIT") {
    if (tx.symbol === null || tx.splitRatio === null || tx.splitRatio <= 0) {
      return state;
    }

    const current = state.holdings[tx.symbol] ?? 0;
    if (current === 0) {
      return state;
    }

    state.holdings[tx.symbol] = current * tx.splitRatio;
    state.date = tx.date;
    return state;
  }

  return state;
}

// Reconstruct state from baseline + transactions.
// Rules:
// 1) Deduplicate transactions by id (first seen wins)
// 2) Sort ascending by date
// 3) Preserve original order for same-date transactions
export function reconstructState(
  baseline: Baseline,
  transactions: NormalizedTransaction[]
): PortfolioState {
  const state: PortfolioState = {
    date: baseline.date,
    holdings: { ...baseline.holdings },
    cash: baseline.cash,
  };

  const seenIds = new Set<string>();
  const deduplicated: Array<{ tx: NormalizedTransaction; originalIndex: number }> = [];

  for (let i = 0; i < transactions.length; i += 1) {
    const tx = transactions[i]!;

    if (seenIds.has(tx.id)) {
      continue;
    }

    seenIds.add(tx.id);
    deduplicated.push({ tx, originalIndex: i });
  }

  deduplicated.sort((a, b) => {
    if (a.tx.date < b.tx.date) return -1;
    if (a.tx.date > b.tx.date) return 1;

    if (a.originalIndex < b.originalIndex) return -1;
    if (a.originalIndex > b.originalIndex) return 1;
    return 0;
  });

  for (const item of deduplicated) {
    applyTransaction(state, item.tx);
  }

  return state;
}
