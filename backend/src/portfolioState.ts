import type { Baseline, NormalizedTransaction } from "./models/index.js";

export type PortfolioAnchor = {
  baseline: Baseline;
  baselines: Baseline[];
  transactionsToApply: NormalizedTransaction[];
  anchorType: "BASELINE" | "TRANSACTIONS_ONLY";
};

function shiftIsoDate(date: string, deltaDays: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + deltaDays);
  return value.toISOString().slice(0, 10);
}

function sortBaselines(baselines: Baseline[]): Baseline[] {
  return baselines
    .map((baseline, index) => ({ baseline, index }))
    .sort((left, right) => {
      if (left.baseline.date < right.baseline.date) return -1;
      if (left.baseline.date > right.baseline.date) return 1;
      return left.index - right.index;
    })
    .map((item) => item.baseline);
}

function sortTransactions(transactions: NormalizedTransaction[]): NormalizedTransaction[] {
  return transactions
    .map((tx, index) => ({ tx, index }))
    .sort((left, right) => {
      if (left.tx.date < right.tx.date) return -1;
      if (left.tx.date > right.tx.date) return 1;
      return left.index - right.index;
    })
    .map((item) => item.tx);
}

export function findPreviousBaseline(
  baselines: Baseline[],
  targetBaseline: Baseline
): Baseline | null {
  const sorted = sortBaselines(baselines);
  let previous: Baseline | null = null;

  for (const baseline of sorted) {
    if (baseline.date < targetBaseline.date) {
      previous = baseline;
    }
  }

  return previous;
}

export function getPortfolioAnchor(
  baselines: Baseline[],
  transactions: NormalizedTransaction[]
): PortfolioAnchor | null {
  const sortedBaselines = sortBaselines(baselines);
  const sortedTransactions = sortTransactions(transactions);

  if (sortedBaselines.length > 0) {
    const baseline = sortedBaselines[sortedBaselines.length - 1]!;
    const transactionsToApply = sortedTransactions.filter((tx) => tx.date > baseline.date);

    return {
      baseline,
      baselines: sortedBaselines,
      transactionsToApply,
      anchorType: "BASELINE",
    };
  }

  if (sortedTransactions.length === 0) {
    return null;
  }

  const syntheticBaseline: Baseline = {
    id: "synthetic-transactions-only",
    date: shiftIsoDate(sortedTransactions[0]!.date, -1),
    holdings: {},
    cash: 0,
    source: "transactions-only",
  };

  return {
    baseline: syntheticBaseline,
    baselines: [],
    transactionsToApply: sortedTransactions,
    anchorType: "TRANSACTIONS_ONLY",
  };
}