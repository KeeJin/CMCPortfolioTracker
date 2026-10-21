import type { Baseline, Transaction } from './parsers.js';
import { applyTransaction, sortTransactions } from './reconstruction.js';

export type ReconciliationDiff = {
  symbol: string;
  expected: number;
  actual: number;
  difference: number;
};

export type ReconciliationResult = {
  baselineDate: string;
  status: 'MATCH' | 'MINOR_MISMATCH' | 'MAJOR_MISMATCH';
  holdingDiffs: ReconciliationDiff[];
  cashDiff: number;
  notes: string[];
};

export function reconcileBaseline(
  previousBaseline: Baseline,
  newBaseline: Baseline,
  transactions: Transaction[],
): ReconciliationResult {
  const sorted = sortTransactions(transactions.filter((tx) => tx.date > previousBaseline.date && tx.date <= newBaseline.date));
  const state = {
    holdings: { ...previousBaseline.holdings },
    cash: previousBaseline.cash,
  };

  for (const tx of sorted) {
    applyTransaction(state, tx);
  }

  const holdingDiffs: ReconciliationDiff[] = [];
  const symbols = new Set([...Object.keys(state.holdings), ...Object.keys(newBaseline.holdings)]);

  for (const symbol of [...symbols].sort()) {
    const expected = state.holdings[symbol] ?? 0;
    const actual = newBaseline.holdings[symbol] ?? 0;
    const difference = actual - expected;
    if (difference !== 0) {
      holdingDiffs.push({ symbol, expected, actual, difference });
    }
  }

  const cashDiff = newBaseline.cash - state.cash;
  const hasExactMatch = holdingDiffs.length === 0 && Math.abs(cashDiff) === 0;
  const allHoldingsClose = holdingDiffs.every((entry) => Math.abs(entry.difference) <= 1);
  const cashWithinMinor = Math.abs(cashDiff) <= 1;

  let status: ReconciliationResult['status'] = 'MAJOR_MISMATCH';
  if (hasExactMatch) {
    status = 'MATCH';
  } else if (allHoldingsClose && cashWithinMinor) {
    status = 'MINOR_MISMATCH';
  }

  const notes = [] as string[];
  if (status === 'MATCH') {
    notes.push('Portfolio matches the new baseline.');
  } else if (status === 'MINOR_MISMATCH') {
    notes.push('Minor discrepancy detected. Likely rounding or a small missing transaction.');
  } else {
    notes.push('Major discrepancy detected. Baseline may require user review.');
  }

  return {
    baselineDate: newBaseline.date,
    status,
    holdingDiffs,
    cashDiff,
    notes,
  };
}
