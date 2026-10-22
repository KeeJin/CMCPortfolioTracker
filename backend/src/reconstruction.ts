import type { Baseline, Transaction } from './parsers.js';

export type PortfolioState = {
  holdings: Record<string, number>;
  cash: number;
};

export function sortTransactions(transactions: Transaction[]) {
  return [...transactions].sort((a, b) => a.date.localeCompare(b.date));
}

export function applyTransaction(state: PortfolioState, tx: Transaction) {
  switch (tx.type) {
    case 'BUY': {
      const quantity = tx.quantity ?? 0;
      state.holdings[tx.symbol ?? ''] = (state.holdings[tx.symbol ?? ''] ?? 0) + quantity;
      state.cash -= Math.abs(tx.amount);
      break;
    }
    case 'SELL': {
      const quantity = tx.quantity ?? 0;
      state.holdings[tx.symbol ?? ''] = (state.holdings[tx.symbol ?? ''] ?? 0) - quantity;
      state.cash += Math.abs(tx.amount);
      break;
    }
    case 'DIVIDEND': {
      state.cash += Math.abs(tx.amount);
      break;
    }
    case 'DEPOSIT': {
      state.cash += Math.abs(tx.amount);
      break;
    }
    case 'WITHDRAWAL': {
      state.cash -= Math.abs(tx.amount);
      break;
    }
    case 'SPLIT': {
      if (tx.symbol && tx.splitRatio) {
        state.holdings[tx.symbol] = (state.holdings[tx.symbol] ?? 0) * tx.splitRatio;
      }
      break;
    }
    default:
      break;
  }
}

export function reconstructState(anchor: Baseline | null, transactions: Transaction[]): PortfolioState {
  const state: PortfolioState = {
    holdings: anchor ? { ...anchor.holdings } : {},
    cash: anchor ? anchor.cash : 0,
  };

  for (const tx of sortTransactions(transactions)) {
    if (tx.date < (anchor?.date ?? '1970-01-01')) {
      continue;
    }
    applyTransaction(state, tx);
  }

  return state;
}
