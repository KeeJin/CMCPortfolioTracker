import type { Baseline, NormalizedTransaction } from "./models/index.js";

export type PortfolioAnchor = {
  baseline: Baseline;
  baselines: Baseline[];
  transactionsToApply: NormalizedTransaction[];
  anchorType: "BASELINE" | "TRANSACTIONS_ONLY";
  estimation?: {
    enabled: boolean;
    inferredBaselineDate: string;
    originalBaselineDate: string;
    knownPreBaselineTransactions: number;
  };
};

type AnchorOptions = {
  includePreBaselineEstimates?: boolean;
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

function applyReverseTransaction(
  holdings: Record<string, number>,
  cash: number,
  tx: NormalizedTransaction
): { holdings: Record<string, number>; cash: number } {
  const nextHoldings = { ...holdings };
  let nextCash = cash;

  if (tx.type === "BUY") {
    if (tx.symbol !== null && tx.quantity !== null) {
      const current = nextHoldings[tx.symbol] ?? 0;
      const next = current - tx.quantity;
      if (next === 0) {
        delete nextHoldings[tx.symbol];
      } else {
        nextHoldings[tx.symbol] = next;
      }
    }
    nextCash -= tx.amount;
    return { holdings: nextHoldings, cash: nextCash };
  }

  if (tx.type === "SELL") {
    if (tx.symbol !== null && tx.quantity !== null) {
      const current = nextHoldings[tx.symbol] ?? 0;
      nextHoldings[tx.symbol] = current + tx.quantity;
    }
    nextCash -= tx.amount;
    return { holdings: nextHoldings, cash: nextCash };
  }

  if (tx.type === "DIVIDEND" || tx.type === "DEPOSIT" || tx.type === "WITHDRAWAL") {
    nextCash -= tx.amount;
    return { holdings: nextHoldings, cash: nextCash };
  }

  if (tx.type === "SPLIT") {
    if (tx.symbol !== null && tx.splitRatio !== null && tx.splitRatio > 0) {
      const current = nextHoldings[tx.symbol] ?? 0;
      if (current !== 0) {
        nextHoldings[tx.symbol] = current / tx.splitRatio;
      }
    }
    return { holdings: nextHoldings, cash: nextCash };
  }

  return { holdings: nextHoldings, cash: nextCash };
}

function inferBaselineFromKnownPreBaselineTransactions(
  baseline: Baseline,
  preBaselineTransactions: NormalizedTransaction[]
): Baseline {
  let inferredHoldings = { ...baseline.holdings };
  let inferredCash = baseline.cash;

  for (let i = preBaselineTransactions.length - 1; i >= 0; i -= 1) {
    const tx = preBaselineTransactions[i]!;
    const reversed = applyReverseTransaction(inferredHoldings, inferredCash, tx);
    inferredHoldings = reversed.holdings;
    inferredCash = reversed.cash;
  }

  const earliestDate = preBaselineTransactions[0]!.date;

  return {
    id: `inferred-prebaseline-${baseline.id}`,
    date: shiftIsoDate(earliestDate, -1),
    holdings: inferredHoldings,
    cash: inferredCash,
    source: "inferred-prebaseline-estimate",
  };
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
  transactions: NormalizedTransaction[],
  options?: AnchorOptions
): PortfolioAnchor | null {
  const sortedBaselines = sortBaselines(baselines);
  const sortedTransactions = sortTransactions(transactions);

  if (sortedBaselines.length > 0) {
    const latestBaseline = sortedBaselines[sortedBaselines.length - 1]!;

    if (!options?.includePreBaselineEstimates) {
      const transactionsToApply = sortedTransactions.filter((tx) => tx.date > latestBaseline.date);

      return {
        baseline: latestBaseline,
        baselines: sortedBaselines,
        transactionsToApply,
        anchorType: "BASELINE",
      };
    }

    const preBaselineTransactions = sortedTransactions.filter((tx) => tx.date < latestBaseline.date);

    if (preBaselineTransactions.length === 0) {
      const transactionsToApply = sortedTransactions.filter((tx) => tx.date > latestBaseline.date);

      return {
        baseline: latestBaseline,
        baselines: sortedBaselines,
        transactionsToApply,
        anchorType: "BASELINE",
      };
    }

    const inferredBaseline = inferBaselineFromKnownPreBaselineTransactions(
      latestBaseline,
      preBaselineTransactions
    );
    const transactionsToApply = sortedTransactions.filter((tx) => tx.date > inferredBaseline.date);

    return {
      baseline: inferredBaseline,
      baselines: sortedBaselines,
      transactionsToApply,
      anchorType: "BASELINE",
      estimation: {
        enabled: true,
        inferredBaselineDate: inferredBaseline.date,
        originalBaselineDate: latestBaseline.date,
        knownPreBaselineTransactions: preBaselineTransactions.length,
      },
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