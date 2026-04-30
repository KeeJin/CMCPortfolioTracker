import { applyTransaction } from "./reconstruction.js";
import type {
  Baseline,
  NormalizedTransaction,
  PortfolioState,
  PortfolioValuePoint,
} from "./models/index.js";
import {
  buildTransactionPriceProvider,
  type PriceProvider,
} from "./pricing.js";

// Re-export so existing consumers (routes, tests) don't need import path changes.
export type { PricePoint, PriceHistory } from "./pricing.js";
import type { PriceHistory } from "./pricing.js";

export type PerformanceResult = {
  startDate: string;
  endDate: string;
  totalReturn: number | undefined;
  twr: number | undefined;
  irr: number | undefined;
  series: PortfolioValuePoint[];
};

type CashFlow = {
  date: string;
  amount: number;
};

function deduplicateAndSortTransactions(
  transactions: NormalizedTransaction[]
): NormalizedTransaction[] {
  const seenIds = new Set<string>();
  const indexed: Array<{ tx: NormalizedTransaction; index: number }> = [];

  for (let i = 0; i < transactions.length; i += 1) {
    const tx = transactions[i]!;
    if (seenIds.has(tx.id)) {
      continue;
    }

    seenIds.add(tx.id);
    indexed.push({ tx, index: i });
  }

  indexed.sort((a, b) => {
    if (a.tx.date < b.tx.date) return -1;
    if (a.tx.date > b.tx.date) return 1;
    return a.index - b.index;
  });

  return indexed.map((item) => item.tx);
}

function collectDates(
  baselineDate: string,
  transactions: NormalizedTransaction[],
  priceHistory: PriceHistory
): string[] {
  const dateSet = new Set<string>();
  dateSet.add(baselineDate);

  for (const tx of transactions) {
    if (tx.date >= baselineDate) {
      dateSet.add(tx.date);
    }
  }

  for (const points of Object.values(priceHistory)) {
    for (const point of points) {
      if (point.date >= baselineDate) {
        dateSet.add(point.date);
      }
    }
  }

  const dates = Array.from(dateSet);
  dates.sort((a, b) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });

  return dates;
}

function calculateHoldingsValue(
  holdings: Record<string, number>,
  date: string,
  getPrice: PriceProvider
): number {
  let holdingsValue = 0;

  for (const [symbol, shares] of Object.entries(holdings)) {
    const price = getPrice(symbol, date);
    if (price === undefined) {
      continue;
    }

    holdingsValue += shares * price;
  }

  return holdingsValue;
}

export function buildPortfolioValueSeries(
  baseline: Baseline,
  transactions: NormalizedTransaction[],
  priceHistory: PriceHistory
): PortfolioValuePoint[] {
  const sortedTransactions = deduplicateAndSortTransactions(transactions);
  const postBaselineTransactions: NormalizedTransaction[] = [];

  for (const tx of sortedTransactions) {
    if (tx.date > baseline.date) {
      postBaselineTransactions.push(tx);
    }
  }

  // Route all price lookups through the provider abstraction.
  const getPrice = buildTransactionPriceProvider(priceHistory);
  const dates = collectDates(baseline.date, postBaselineTransactions, priceHistory);

  const state: PortfolioState = {
    date: baseline.date,
    holdings: { ...baseline.holdings },
    cash: baseline.cash,
  };

  const series: PortfolioValuePoint[] = [];
  let txIndex = 0;

  for (const date of dates) {
    while (
      txIndex < postBaselineTransactions.length &&
      postBaselineTransactions[txIndex]!.date <= date
    ) {
      applyTransaction(state, postBaselineTransactions[txIndex]!);
      txIndex += 1;
    }

    const holdingsValue = calculateHoldingsValue(state.holdings, date, getPrice);
    const totalValue = holdingsValue + state.cash;

    series.push({
      date,
      totalValue,
      holdingsValue,
      cash: state.cash,
    });
  }

  return series;
}

function buildExternalCashFlowMap(
  transactions: NormalizedTransaction[]
): Record<string, number> {
  const map: Record<string, number> = {};

  for (const tx of transactions) {
    if (tx.type !== "DEPOSIT" && tx.type !== "WITHDRAWAL") {
      continue;
    }

    const current = map[tx.date] ?? 0;
    map[tx.date] = current + tx.amount;
  }

  return map;
}

function sumExternalFlowsInRange(
  series: PortfolioValuePoint[],
  startIndexExclusive: number,
  endIndexInclusive: number,
  externalFlowByDate: Record<string, number>
): number {
  let sum = 0;

  for (let i = startIndexExclusive + 1; i <= endIndexInclusive; i += 1) {
    const date = series[i]!.date;
    sum += externalFlowByDate[date] ?? 0;
  }

  return sum;
}

export function calculateTwr(
  series: PortfolioValuePoint[],
  transactions: NormalizedTransaction[]
): number | undefined {
  if (series.length < 2) {
    return undefined;
  }

  const sortedTransactions = deduplicateAndSortTransactions(transactions);
  const externalFlowByDate = buildExternalCashFlowMap(sortedTransactions);

  let compounded = 1;
  let periodStartIndex = 0;

  for (let i = 1; i < series.length; i += 1) {
    const periodBoundaryDate = series[i]!.date;
    const hasExternalFlow = (externalFlowByDate[periodBoundaryDate] ?? 0) !== 0;

    if (!hasExternalFlow) {
      continue;
    }

    const startValue = series[periodStartIndex]!.totalValue;
    if (startValue === 0) {
      return undefined;
    }

    const endValue = series[i]!.totalValue;
    const externalCash = sumExternalFlowsInRange(
      series,
      periodStartIndex,
      i,
      externalFlowByDate
    );

    const periodReturn = (endValue - startValue - externalCash) / startValue;
    compounded *= 1 + periodReturn;

    periodStartIndex = i;
  }

  if (periodStartIndex < series.length - 1) {
    const startValue = series[periodStartIndex]!.totalValue;
    if (startValue === 0) {
      return undefined;
    }

    const endValue = series[series.length - 1]!.totalValue;
    const externalCash = sumExternalFlowsInRange(
      series,
      periodStartIndex,
      series.length - 1,
      externalFlowByDate
    );

    const periodReturn = (endValue - startValue - externalCash) / startValue;
    compounded *= 1 + periodReturn;
  }

  return compounded - 1;
}

function daysBetween(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00.000Z`).getTime();
  const end = new Date(`${endDate}T00:00:00.000Z`).getTime();
  return (end - start) / (1000 * 60 * 60 * 24);
}

function mergeCashFlowsByDate(cashFlows: CashFlow[]): CashFlow[] {
  const map: Record<string, number> = {};

  for (const flow of cashFlows) {
    const current = map[flow.date] ?? 0;
    map[flow.date] = current + flow.amount;
  }

  const merged = Object.entries(map).map(([date, amount]) => ({ date, amount }));
  merged.sort((a, b) => {
    if (a.date < b.date) return -1;
    if (a.date > b.date) return 1;
    return 0;
  });

  return merged;
}

function buildIrrCashFlows(
  series: PortfolioValuePoint[],
  transactions: NormalizedTransaction[]
): CashFlow[] {
  const sortedTransactions = deduplicateAndSortTransactions(transactions);

  const flows: CashFlow[] = [];
  flows.push({
    date: series[0]!.date,
    amount: -series[0]!.totalValue,
  });

  for (const tx of sortedTransactions) {
    if (tx.type === "DEPOSIT" || tx.type === "WITHDRAWAL") {
      // Investor-perspective sign convention:
      // deposit into portfolio = investor outflow (negative),
      // withdrawal from portfolio = investor inflow (positive).
      flows.push({
        date: tx.date,
        amount: -tx.amount,
      });
    }
  }

  flows.push({
    date: series[series.length - 1]!.date,
    amount: series[series.length - 1]!.totalValue,
  });

  return mergeCashFlowsByDate(flows);
}

function xnpv(rate: number, flows: CashFlow[]): number {
  const startDate = flows[0]!.date;
  let value = 0;

  for (const flow of flows) {
    const years = daysBetween(startDate, flow.date) / 365;
    value += flow.amount / Math.pow(1 + rate, years);
  }

  return value;
}

function xnpvDerivative(rate: number, flows: CashFlow[]): number {
  const startDate = flows[0]!.date;
  let derivative = 0;

  for (const flow of flows) {
    const years = daysBetween(startDate, flow.date) / 365;
    if (years === 0) {
      continue;
    }

    derivative += (-years * flow.amount) / Math.pow(1 + rate, years + 1);
  }

  return derivative;
}

export function calculateIrr(
  series: PortfolioValuePoint[],
  transactions: NormalizedTransaction[]
): number | undefined {
  if (series.length < 2) {
    return undefined;
  }

  const flows = buildIrrCashFlows(series, transactions);

  let hasPositive = false;
  let hasNegative = false;

  for (const flow of flows) {
    if (flow.amount > 0) hasPositive = true;
    if (flow.amount < 0) hasNegative = true;
  }

  if (!hasPositive || !hasNegative) {
    return undefined;
  }

  let rate = 0.1;

  for (let i = 0; i < 100; i += 1) {
    if (rate <= -0.999999) {
      break;
    }

    const f = xnpv(rate, flows);
    const df = xnpvDerivative(rate, flows);

    if (Math.abs(df) < 1e-12) {
      break;
    }

    const next = rate - f / df;

    if (!Number.isFinite(next) || next <= -0.999999) {
      break;
    }

    if (Math.abs(next - rate) < 1e-9) {
      return next;
    }

    rate = next;
  }

  let low = -0.9999;
  let high = 10;
  let fLow = xnpv(low, flows);
  let fHigh = xnpv(high, flows);

  while (fLow * fHigh > 0 && high < 1_000_000) {
    high *= 2;
    fHigh = xnpv(high, flows);
  }

  if (fLow * fHigh > 0) {
    return undefined;
  }

  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    const fMid = xnpv(mid, flows);

    if (Math.abs(fMid) < 1e-9) {
      return mid;
    }

    if (fLow * fMid < 0) {
      high = mid;
      fHigh = fMid;
    } else {
      low = mid;
      fLow = fMid;
    }

    if (Math.abs(high - low) < 1e-10) {
      return (low + high) / 2;
    }
  }

  return (low + high) / 2;
}

export function calculatePerformance(
  baseline: Baseline,
  transactions: NormalizedTransaction[],
  priceHistory: PriceHistory
): PerformanceResult {
  const series = buildPortfolioValueSeries(baseline, transactions, priceHistory);

  if (series.length === 0) {
    return {
      startDate: baseline.date,
      endDate: baseline.date,
      totalReturn: undefined,
      twr: undefined,
      irr: undefined,
      series,
    };
  }

  const startValue = series[0]!.totalValue;
  const endValue = series[series.length - 1]!.totalValue;

  const totalReturn =
    startValue === 0 ? undefined : (endValue - startValue) / startValue;

  const twr = calculateTwr(series, transactions);
  const irr = calculateIrr(series, transactions);

  return {
    startDate: series[0]!.date,
    endDate: series[series.length - 1]!.date,
    totalReturn,
    twr,
    irr,
    series,
  };
}
