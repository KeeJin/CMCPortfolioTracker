import type { Baseline, Transaction } from './parsers.js';

export function getPortfolioAnchor(baselines: Baseline[], transactions: Transaction[]) {
  if (baselines.length === 0) {
    return {
      anchorType: 'TRANSACTIONS_ONLY' as const,
      baseline: null,
      baselineDate: null,
      transactionsToApply: [...transactions],
    };
  }

  const sortedBaselines = [...baselines].sort((a, b) => a.date.localeCompare(b.date));
  const latestBaseline = sortedBaselines[sortedBaselines.length - 1]!;
  return {
    anchorType: 'BASELINE' as const,
    baseline: latestBaseline,
    baselineDate: latestBaseline.date,
    transactionsToApply: transactions.filter((tx) => tx.date > latestBaseline.date),
  };
}
