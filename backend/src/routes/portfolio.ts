import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';

import { getAllBaselines, getAllTransactions, getAllUploads, readSupabaseDocument } from '../store.js';
import { getPortfolioAnchor } from '../portfolioState.js';
import { applyTransaction, reconstructState, sortTransactions } from '../reconstruction.js';
import {
  fetchYahooFinanceHistoricalPrices,
  fetchYahooFinanceLatestPrices,
  fetchYahooFinanceStockSplits,
  lastLivePriceSyncAt,
} from '../pricing.js';
import { collectTrackedSymbols, mergeMarketSplitTransactions } from '../marketSplits.js';
import { getCachedPricesForSymbol } from '../priceCache.js';
import { convertSgdToUsd, fetchUsdSgdHistory } from '../fx.js';
import type { Baseline, Transaction, Upload } from '../parsers.js';
import type { PricePoint } from '../pricing.js';
import { buildManualLinearOptionSeries } from '../manualOptionValuation.js';

const router = Router();

export const PORTFOLIO_TIMEFRAMES = ['5d', '1m', '3m', '6m', 'ytd', '1y', '3y', '5y', 'all'] as const;
export const PORTFOLIO_TWR_MODES = ['invested_capital', 'account_total'] as const;

export function getDateRangeForTimeframe(timeframe: string, referenceDate: Date = new Date()) {
  const end = new Date(referenceDate);
  const endIso = end.toISOString().slice(0, 10);

  if (timeframe === 'all') {
    return { start: '1900-01-01', end: endIso };
  }

  if (timeframe === 'ytd') {
    const start = new Date(Date.UTC(end.getUTCFullYear(), 0, 1));
    return { start: start.toISOString().slice(0, 10), end: endIso };
  }

  const map: Record<string, number> = { '5d': 5, '1m': 30, '3m': 90, '6m': 180, '1y': 365, '3y': 1095, '5y': 1825 };
  const days = map[timeframe] ?? 365;
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - days);
  return { start: start.toISOString().slice(0, 10), end: endIso };
}

function getSamplingStepForTimeframe(timeframe: string): number {
  switch (timeframe) {
    case '5d':
      return 1;
    case '1m':
      return 1;
    case '3m':
      return 2;
    case '6m':
      return 3;
    case '1y':
      return 5;
    case '3y':
      return 7;
    case '5y':
      return 14;
    case 'all':
      return 7;
    default:
      return 5;
  }
}

function calculateAnnualizedVolatilityFromPriceSeries(points: Array<{ date: string; price: number }>): number {
  if (points.length < 2) return 0;

  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const dailyReturns: number[] = [];

  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1]?.price ?? 0;
    const current = sorted[i]?.price ?? 0;
    if (!Number.isFinite(previous) || !Number.isFinite(current) || previous <= 0) {
      continue;
    }
    dailyReturns.push((current - previous) / previous);
  }

  if (dailyReturns.length < 2) return 0;

  const mean = dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (dailyReturns.length - 1);
  if (!Number.isFinite(variance) || variance < 0) return 0;

  return Math.sqrt(variance) * Math.sqrt(252);
}

function buildNormalizedBenchmarkSeries(sampledDates: string[], pricePoints: Array<{ date: string; price: number }>): number[] {
  if (sampledDates.length === 0 || pricePoints.length === 0) {
    return sampledDates.map(() => 1);
  }

  const sortedPoints = [...pricePoints]
    .filter((point) => point.date && Number.isFinite(point.price) && point.price > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (sortedPoints.length === 0) {
    return sampledDates.map(() => 1);
  }

  const seriesRaw: number[] = [];
  let pointer = 0;
  let lastKnownPrice: number | null = null;

  for (const date of sampledDates) {
    while (pointer < sortedPoints.length && sortedPoints[pointer].date <= date) {
      lastKnownPrice = sortedPoints[pointer].price;
      pointer += 1;
    }

    if (lastKnownPrice === null) {
      lastKnownPrice = sortedPoints[0].price;
    }

    seriesRaw.push(lastKnownPrice);
  }

  const base = seriesRaw[0];
  if (!Number.isFinite(base) || base <= 0) {
    return sampledDates.map(() => 1);
  }

  return seriesRaw.map((price) => price / base);
}

function toNumber(value: unknown, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function calculateTwrFromSeries(series: Array<{ date: string; totalValue: number; cash: number; holdingsValue: number }>, externalFlows: Array<{ date: string; amount: number }>) {
  if (series.length === 0) return 0;

  let cumulative = 1;
  for (let index = 1; index < series.length; index += 1) {
    const previous = series[index - 1];
    const current = series[index];

    const flow = externalFlows
      .filter((flow) => flow.date > previous.date && flow.date <= current.date)
      .reduce((sum, entry) => sum + entry.amount, 0);

    const startValue = previous.totalValue;
    const adjustedStartValue = startValue + flow;
    const periodReturn = adjustedStartValue === 0 ? 0 : (current.totalValue - adjustedStartValue) / adjustedStartValue;

    cumulative *= 1 + periodReturn;
  }

  return cumulative - 1;
}

function calculateCumulativeTwrFactorSeries(
  series: Array<{ date: string; totalValue: number }>,
  flows: Array<{ date: string; amount: number }>,
) {
  if (series.length === 0) {
    return [] as number[];
  }

  const factors = [1];
  let cumulative = 1;

  for (let index = 1; index < series.length; index += 1) {
    const previous = series[index - 1];
    const current = series[index];

    const flow = flows
      .filter((entry) => entry.date > previous.date && entry.date <= current.date)
      .reduce((sum, entry) => sum + entry.amount, 0);

    const adjustedStart = previous.totalValue + flow;
    const periodReturn = adjustedStart === 0 ? 0 : (current.totalValue - adjustedStart) / adjustedStart;
    cumulative *= 1 + periodReturn;
    factors.push(cumulative);
  }

  return factors;
}

async function fetchBenchmarkSeriesWithFallback(
  candidates: string[],
  sampledDates: string[],
  startDate: string,
  effectiveStartDate: string,
  rangeEnd: string,
) {
  const uniqueStarts = [...new Set([startDate, effectiveStartDate])];

  for (const benchmarkCandidate of candidates) {
    for (const candidateStart of uniqueStarts) {
      const benchmarkHistory = await fetchYahooFinanceHistoricalPrices([benchmarkCandidate], candidateStart, rangeEnd);
      const benchmarkPoints = benchmarkHistory.history[benchmarkCandidate] ?? [];
      if (benchmarkPoints.length === 0) {
        continue;
      }

      const normalized = buildNormalizedBenchmarkSeries(sampledDates, benchmarkPoints);
      if (normalized.length === 0) {
        continue;
      }

      return {
        symbol: benchmarkCandidate,
        normalized,
        points: benchmarkPoints,
      };
    }
  }

  return null;
}

// Modified TWR for active positions only (ignores idle cash):
// - portfolio value = holdings market value only
// - BUY amount = external inflow (capital deployed into active positions)
// - SELL proceeds = external outflow (capital removed from active positions)
export function calculateInvestedCapitalTwr(
  holdingsSeries: Array<{ date: string; holdingsValue: number }>,
  tradeFlows: Array<{ date: string; amount: number }>,
) {
  if (holdingsSeries.length === 0) return 0;

  let cumulative = 1;
  for (let index = 1; index < holdingsSeries.length; index += 1) {
    const previous = holdingsSeries[index - 1];
    const current = holdingsSeries[index];

    const flow = tradeFlows
      .filter((entry) => entry.date > previous.date && entry.date <= current.date)
      .reduce((sum, entry) => sum + entry.amount, 0);

    const adjustedStart = previous.holdingsValue + flow;
    if (adjustedStart === 0) {
      continue;
    }

    const periodReturn = (current.holdingsValue - adjustedStart) / adjustedStart;
    cumulative *= 1 + periodReturn;
  }

  return cumulative - 1;
}

function getHoldingsValueOnDate(
  holdings: Record<string, number>,
  date: string,
  priceBySymbolDate: Map<string, Map<string, number>>,
) {
  let total = 0;
  for (const [symbol, quantity] of Object.entries(holdings)) {
    const price = priceBySymbolDate.get(symbol)?.get(date) ?? 0;
    total += (quantity || 0) * price;
  }
  return total;
}

function assignTradeToBoundaryDate(tradeDate: string, rangeDates: string[]): string | null {
  if (rangeDates.length === 0) return null;

  for (const boundary of rangeDates) {
    if (boundary >= tradeDate) {
      return boundary;
    }
  }

  return rangeDates[rangeDates.length - 1];
}

export function calculateInvestedCapitalTwrFromTradeBoundaries(
  rangeDates: string[],
  anchorStateBeforeRange: { holdings: Record<string, number>; cash: number },
  tradeTransactions: Transaction[],
  priceBySymbolDate: Map<string, Map<string, number>>,
  fxPoints: PricePoint[],
) {
  if (rangeDates.length === 0) {
    return { twr: 0, flows: [] as Array<{ date: string; amount: number }> };
  }

  const state = {
    holdings: { ...anchorStateBeforeRange.holdings },
    cash: anchorStateBeforeRange.cash,
  };

  const tradesByBoundaryDate = new Map<string, Transaction[]>();
  for (const tx of tradeTransactions) {
    const boundary = assignTradeToBoundaryDate(tx.date, rangeDates);
    if (!boundary) continue;

    const current = tradesByBoundaryDate.get(boundary) ?? [];
    current.push(tx);
    tradesByBoundaryDate.set(boundary, current);
  }

  for (const [date, trades] of tradesByBoundaryDate) {
    tradesByBoundaryDate.set(date, [...trades].sort((a, b) => a.id.localeCompare(b.id)));
  }

  let cumulative = 1;
  let baseline = getHoldingsValueOnDate(state.holdings, rangeDates[0], priceBySymbolDate);
  const flows: Array<{ date: string; amount: number }> = [];
  let lastTradeBoundaryDate: string | null = null;

  for (const date of rangeDates) {
    const trades = tradesByBoundaryDate.get(date) ?? [];
    if (trades.length === 0) {
      continue;
    }

    const endingBeforeTrades = getHoldingsValueOnDate(state.holdings, date, priceBySymbolDate);
    if (baseline !== 0) {
      const periodReturn = (endingBeforeTrades - baseline) / baseline;
      cumulative *= 1 + periodReturn;
    }

    let boundaryFlow = 0;
    for (const tx of trades) {
      const signedSgd = tx.type === 'BUY' ? Math.abs(tx.amount) : -Math.abs(tx.amount);
      const signedUsd = convertSgdToUsd(signedSgd, tx.date, fxPoints);
      boundaryFlow += signedUsd;
      flows.push({ date, amount: signedUsd });
      applyTransaction(state, tx);
    }
    lastTradeBoundaryDate = date;

    baseline = endingBeforeTrades + boundaryFlow;
  }

  const finalDate = rangeDates[rangeDates.length - 1];
  const hasPostTradeWindow = !lastTradeBoundaryDate || finalDate > lastTradeBoundaryDate;
  if (hasPostTradeWindow) {
    const finalValue = getHoldingsValueOnDate(state.holdings, finalDate, priceBySymbolDate);
    if (baseline !== 0) {
      const finalPeriodReturn = (finalValue - baseline) / baseline;
      cumulative *= 1 + finalPeriodReturn;
    }
  }

  return {
    twr: cumulative - 1,
    flows,
  };
}

function calculateInvestedCapitalTwrFactorSeriesFromTradeBoundaries(
  rangeDates: string[],
  anchorStateBeforeRange: { holdings: Record<string, number>; cash: number },
  tradeTransactions: Transaction[],
  priceBySymbolDate: Map<string, Map<string, number>>,
  fxPoints: PricePoint[],
) {
  if (rangeDates.length === 0) {
    return [] as number[];
  }

  const state = {
    holdings: { ...anchorStateBeforeRange.holdings },
    cash: anchorStateBeforeRange.cash,
  };

  const tradesByBoundaryDate = new Map<string, Transaction[]>();
  for (const tx of tradeTransactions) {
    const boundary = assignTradeToBoundaryDate(tx.date, rangeDates);
    if (!boundary) continue;

    const current = tradesByBoundaryDate.get(boundary) ?? [];
    current.push(tx);
    tradesByBoundaryDate.set(boundary, current);
  }

  for (const [date, trades] of tradesByBoundaryDate) {
    tradesByBoundaryDate.set(date, [...trades].sort((a, b) => a.id.localeCompare(b.id)));
  }

  const factors: number[] = [1];
  let cumulative = 1;
  let baseline = getHoldingsValueOnDate(state.holdings, rangeDates[0], priceBySymbolDate);
  let lastTradeBoundaryDate: string | null = null;

  for (let index = 1; index < rangeDates.length; index += 1) {
    const date = rangeDates[index];
    const trades = tradesByBoundaryDate.get(date) ?? [];

    if (trades.length > 0) {
      const endingBeforeTrades = getHoldingsValueOnDate(state.holdings, date, priceBySymbolDate);
      if (baseline !== 0) {
        const periodReturn = (endingBeforeTrades - baseline) / baseline;
        cumulative *= 1 + periodReturn;
      }

      let boundaryFlow = 0;
      for (const tx of trades) {
        const signedSgd = tx.type === 'BUY' ? Math.abs(tx.amount) : -Math.abs(tx.amount);
        const signedUsd = convertSgdToUsd(signedSgd, tx.date, fxPoints);
        boundaryFlow += signedUsd;
        applyTransaction(state, tx);
      }
      lastTradeBoundaryDate = date;
      baseline = endingBeforeTrades + boundaryFlow;
      factors.push(cumulative);
      continue;
    }

    const isFinalDate = index === rangeDates.length - 1;
    const shouldApplyFinalPostTradeReturn = isFinalDate
      && lastTradeBoundaryDate !== null
      && date > lastTradeBoundaryDate;

    if (shouldApplyFinalPostTradeReturn) {
      const finalValue = getHoldingsValueOnDate(state.holdings, date, priceBySymbolDate);
      if (baseline !== 0) {
        const finalPeriodReturn = (finalValue - baseline) / baseline;
        cumulative *= 1 + finalPeriodReturn;
      }
      factors.push(cumulative);
      continue;
    }

    factors.push(cumulative);
  }

  return factors;
}

export function buildUsdPortfolioPoint(
  date: string,
  holdingsValueUsd: number,
  cashSgd: number,
  fxPoints: PricePoint[],
) {
  const cashUsd = convertSgdToUsd(cashSgd, date, fxPoints);
  return {
    date,
    holdingsValue: holdingsValueUsd,
    cash: cashUsd,
    totalValue: holdingsValueUsd + cashUsd,
  };
}

type PortfolioSeriesPoint = {
  date: string;
  totalValue: number;
  holdingsValue: number;
  cash: number;
};

type TickerHoldingsState = Record<string, number>;

type TwrResidualBreakdown = {
  symbolContributionTotal: number;
  cashCarryContribution: number;
  tradeTimingContribution: number;
  residualRemainder: number;
};

function buildFilledSymbolPriceMap(
  symbols: string[],
  rangeDates: string[],
  priceSeries: Record<string, Array<{ date: string; price: number }>>,
) {
  const filled = new Map<string, Map<string, number>>();

  for (const symbol of symbols) {
    const points = [...(priceSeries[symbol] ?? [])].sort((a, b) => a.date.localeCompare(b.date));
    const byDate = new Map<string, number>();
    let pointer = 0;
    let lastPrice = 0;

    for (const date of rangeDates) {
      while (pointer < points.length && points[pointer].date <= date) {
        lastPrice = points[pointer].price;
        pointer += 1;
      }
      byDate.set(date, lastPrice);
    }

    filled.set(symbol, byDate);
  }

  return filled;
}

function getOppositeTradeType(type: Transaction['type']): Transaction['type'] {
  return type === 'SELL' ? 'BUY' : 'SELL';
}

export function expandManualLinearOptionTransactions(
  transactions: Transaction[],
  asOfDate: string = new Date().toISOString().slice(0, 10),
): Transaction[] {
  const sorted = sortTransactions(transactions);
  const expanded: Transaction[] = [];

  for (const tx of sorted) {
    const isLinearOption = tx.instrumentType === 'OPTION'
      && tx.valuationMethod === 'LINEAR'
      && (tx.type === 'BUY' || tx.type === 'SELL');

    if (!isLinearOption) {
      expanded.push(tx);
      continue;
    }

    if (!tx.symbol || !tx.quantity || tx.quantity <= 0 || !tx.valuationStartDate || !tx.valuationEndDate) {
      expanded.push(tx);
      continue;
    }

    const valuationStartDate = tx.valuationStartDate;
    const valuationEndDate = tx.valuationEndDate;
    if (valuationEndDate < valuationStartDate) {
      expanded.push(tx);
      continue;
    }

    const multiplier = Number(tx.contractMultiplier ?? 100);
    const startPrice = Number(tx.valuationStartPrice);
    const endPrice = Number(tx.valuationEndPrice);
    if (!Number.isFinite(multiplier) || multiplier <= 0) continue;
    if (!Number.isFinite(startPrice) || startPrice < 0) continue;
    if (!Number.isFinite(endPrice) || endPrice < 0) continue;

    const quantity = Math.abs(tx.quantity);
    const openAmountAbs = quantity * startPrice * multiplier;
    const openAmount = tx.type === 'SELL' ? openAmountAbs : -openAmountAbs;

    expanded.push({
      ...tx,
      id: `manual-open-${tx.id}`,
      date: valuationStartDate,
      quantity,
      price: startPrice,
      amount: openAmount,
      source: `${tx.source ?? 'manual-entry'}:auto-open`,
      rawDescription: `Auto-open ${tx.symbol} from valuation start date`,
    });

    if (valuationEndDate > asOfDate) {
      continue;
    }

    const closeType = getOppositeTradeType(tx.type);
    const closeQuantity = quantity;
    const closeAmountAbs = closeQuantity * endPrice * multiplier;
    const closeAmount = closeType === 'SELL' ? closeAmountAbs : -closeAmountAbs;

    expanded.push({
      id: `manual-close-${tx.id}`,
      date: valuationEndDate,
      type: closeType,
      symbol: tx.symbol,
      quantity: closeQuantity,
      price: endPrice,
      amount: closeAmount,
      splitRatio: null,
      source: `${tx.source ?? 'manual-entry'}:auto-close`,
      rawDescription: `Auto-close ${tx.symbol} at valuation end date`,
      instrumentType: 'OPTION',
      underlyingSymbol: tx.underlyingSymbol ?? null,
      optionType: tx.optionType,
      strikePrice: tx.strikePrice ?? null,
      expiryDate: tx.expiryDate ?? null,
      contractMultiplier: multiplier,
      ownershipShare: tx.ownershipShare ?? null,
      valuationMethod: tx.valuationMethod,
      valuationStartDate: tx.valuationStartDate ?? null,
      valuationStartPrice: tx.valuationStartPrice ?? null,
      valuationEndDate,
      valuationEndPrice: tx.valuationEndPrice ?? null,
    });
  }

  return expanded;
}

export function deriveManualOptionCloseTransactions(
  transactions: Transaction[],
  asOfDate: string = new Date().toISOString().slice(0, 10),
): Transaction[] {
  return expandManualLinearOptionTransactions(transactions, asOfDate)
    .filter((tx) => String(tx.source ?? '').includes(':auto-close'));
}

function computeTwrSymbolContributions(
  symbols: string[],
  rangeDates: string[],
  series: PortfolioSeriesPoint[],
  holdingsByDate: Map<string, TickerHoldingsState>,
  priceBySymbolDate: Map<string, Map<string, number>>,
  externalFlows: Array<{ date: string; amount: number }>,
  transactions: Transaction[],
  fxPoints: PricePoint[],
) {
  const symbolContributions: Record<string, number> = {};
  let residualContribution = 0;

  if (rangeDates.length <= 1 || series.length <= 1) {
    return {
      symbolContributions,
      residualContribution,
    };
  }

  const dividendByDateAndSymbol = new Map<string, number>();
  for (const tx of transactions) {
    if (tx.type !== 'DIVIDEND' || !tx.symbol) continue;
    if (!rangeDates.includes(tx.date)) continue;
    const amountUsd = convertSgdToUsd(Math.abs(tx.amount), tx.date, fxPoints);
    const key = `${tx.date}::${tx.symbol}`;
    dividendByDateAndSymbol.set(key, (dividendByDateAndSymbol.get(key) ?? 0) + amountUsd);
  }

  for (let index = 1; index < series.length; index += 1) {
    const previous = series[index - 1];
    const current = series[index];

    const flow = externalFlows
      .filter((entry) => entry.date > previous.date && entry.date <= current.date)
      .reduce((sum, entry) => sum + entry.amount, 0);

    const adjustedStart = previous.totalValue + flow;
    if (adjustedStart === 0) {
      continue;
    }

    const periodReturn = (current.totalValue - adjustedStart) / adjustedStart;
    let explainedReturn = 0;

    const holdings = holdingsByDate.get(previous.date) ?? {};
    for (const symbol of symbols) {
      const quantity = holdings[symbol] ?? 0;
      if (!quantity) continue;

      const priceMap = priceBySymbolDate.get(symbol);
      const prevPrice = priceMap?.get(previous.date) ?? 0;
      const currPrice = priceMap?.get(current.date) ?? prevPrice;
      const pricePnl = quantity * (currPrice - prevPrice);

      let dividendPnl = 0;
      for (const date of rangeDates) {
        if (date > previous.date && date <= current.date) {
          dividendPnl += dividendByDateAndSymbol.get(`${date}::${symbol}`) ?? 0;
        }
      }

      const contribution = (pricePnl + dividendPnl) / adjustedStart;
      symbolContributions[symbol] = (symbolContributions[symbol] ?? 0) + contribution;
      explainedReturn += contribution;
    }

    residualContribution += periodReturn - explainedReturn;
  }

  return {
    symbolContributions,
    residualContribution,
  };
}

function computeTwrResidualBreakdown(
  series: PortfolioSeriesPoint[],
  externalFlows: Array<{ date: string; amount: number }>,
  symbolContributionTotal: number,
) {
  let cashCarryContribution = 0;

  for (let index = 1; index < series.length; index += 1) {
    const previous = series[index - 1];
    const current = series[index];

    const flow = externalFlows
      .filter((entry) => entry.date > previous.date && entry.date <= current.date)
      .reduce((sum, entry) => sum + entry.amount, 0);

    const adjustedStart = previous.totalValue + flow;
    if (adjustedStart === 0) continue;

    // Cash component in USD earns approximately zero return; its start weight contributes
    // to explaining why weighted symbol returns do not add up to total portfolio TWR.
    cashCarryContribution += 0 * (previous.cash / adjustedStart);
  }

  const twr = calculateTwrFromSeries(series, externalFlows);
  const explainedByModel = symbolContributionTotal + cashCarryContribution;
  const totalResidual = twr - explainedByModel;

  // The remaining residual is mainly trade-timing/rebalancing interaction between changing weights
  // and period returns (plus any minor data-forward-fill drift).
  const tradeTimingContribution = totalResidual;

  return {
    symbolContributionTotal,
    cashCarryContribution,
    tradeTimingContribution,
    residualRemainder: twr - (symbolContributionTotal + cashCarryContribution + tradeTimingContribution),
  } satisfies TwrResidualBreakdown;
}

export function computeRealizedGainsForRange(
  transactions: Transaction[],
  startDate: string,
  endDate: string,
  fxPoints: PricePoint[],
) {
  const realizedBySymbol: Record<string, number> = {};
  const costBasisBySymbol = new Map<string, { quantity: number; totalCostUsd: number }>();
  const sorted = sortTransactions(transactions).filter((tx) => tx.date <= endDate);

  for (const tx of sorted) {
    if (!tx.symbol) {
      continue;
    }

    if (tx.type === 'SPLIT') {
      const ratio = Number(tx.splitRatio ?? 0);
      if (!Number.isFinite(ratio) || ratio <= 0) {
        continue;
      }
      const basis = costBasisBySymbol.get(tx.symbol);
      if (!basis || basis.quantity <= 0) {
        continue;
      }

      basis.quantity *= ratio;
      costBasisBySymbol.set(tx.symbol, basis);
      continue;
    }

    if ((tx.type !== 'BUY' && tx.type !== 'SELL') || !tx.quantity || tx.quantity <= 0) {
      continue;
    }

    const quantity = Math.abs(tx.quantity);
    const amountUsd = convertSgdToUsd(Math.abs(tx.amount), tx.date, fxPoints);
    const basis = costBasisBySymbol.get(tx.symbol) ?? { quantity: 0, totalCostUsd: 0 };

    if (tx.type === 'BUY') {
      basis.quantity += quantity;
      basis.totalCostUsd += amountUsd;
      costBasisBySymbol.set(tx.symbol, basis);
      continue;
    }

    const averageCostUsd = basis.quantity > 0 ? basis.totalCostUsd / basis.quantity : 0;
    const realizedUsd = amountUsd - averageCostUsd * quantity;

    if (tx.date >= startDate && tx.date <= endDate) {
      realizedBySymbol[tx.symbol] = (realizedBySymbol[tx.symbol] ?? 0) + realizedUsd;
    }

    const removedCostUsd = averageCostUsd * quantity;
    basis.quantity = Math.max(0, basis.quantity - quantity);
    basis.totalCostUsd = Math.max(0, basis.totalCostUsd - removedCostUsd);
    costBasisBySymbol.set(tx.symbol, basis);
  }

  return realizedBySymbol;
}

function buildAverageCostBasisBySymbol(
  transactions: Transaction[],
  endDate: string,
  fxPoints: PricePoint[],
  initialLots: Map<string, { quantity: number; totalCostUsd: number }> = new Map(),
) {
  const costBasisBySymbol = new Map<string, { quantity: number; totalCostUsd: number }>();
  for (const [symbol, lot] of initialLots) {
    costBasisBySymbol.set(symbol, {
      quantity: lot.quantity,
      totalCostUsd: lot.totalCostUsd,
    });
  }
  const sorted = sortTransactions(transactions).filter((tx) => tx.date <= endDate);

  for (const tx of sorted) {
    if (!tx.symbol) {
      continue;
    }

    if (tx.type === 'SPLIT') {
      const ratio = Number(tx.splitRatio ?? 0);
      if (!Number.isFinite(ratio) || ratio <= 0) {
        continue;
      }
      const basis = costBasisBySymbol.get(tx.symbol);
      if (!basis || basis.quantity <= 0) {
        continue;
      }

      basis.quantity *= ratio;
      costBasisBySymbol.set(tx.symbol, basis);
      continue;
    }

    if ((tx.type !== 'BUY' && tx.type !== 'SELL') || !tx.quantity || tx.quantity <= 0) {
      continue;
    }

    const quantity = Math.abs(tx.quantity);
    const amountUsd = convertSgdToUsd(Math.abs(tx.amount), tx.date, fxPoints);
    const basis = costBasisBySymbol.get(tx.symbol) ?? { quantity: 0, totalCostUsd: 0 };

    if (tx.type === 'BUY') {
      basis.quantity += quantity;
      basis.totalCostUsd += amountUsd;
      costBasisBySymbol.set(tx.symbol, basis);
      continue;
    }

    const averageCostUsd = basis.quantity > 0 ? basis.totalCostUsd / basis.quantity : 0;
    const removedCostUsd = averageCostUsd * quantity;
    basis.quantity = Math.max(0, basis.quantity - quantity);
    basis.totalCostUsd = Math.max(0, basis.totalCostUsd - removedCostUsd);
    costBasisBySymbol.set(tx.symbol, basis);
  }

  return costBasisBySymbol;
}

// Build baseline opening lots for contribution/cost-basis math:
// 1) start from baseline quantities (authoritative)
// 2) infer per-symbol average cost from any pre-baseline BUY/SELL history
// 3) keep fallback assumption when no older history exists
function buildInitialLotsFromBaselineAndPreBaselineTransactions(
  baseline: Baseline | null,
  preBaselineTransactions: Transaction[],
  fxPoints: PricePoint[],
) {
  const initialLots = new Map<string, { quantity: number; totalCostUsd: number }>();

  if (!baseline) {
    return initialLots;
  }

  for (const [symbol, quantityRaw] of Object.entries(baseline.holdings)) {
    const quantity = Number(quantityRaw);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      continue;
    }

    const baselinePrice = Number(baseline.holdingPrices?.[symbol]);
    if (Number.isFinite(baselinePrice) && baselinePrice > 0) {
      initialLots.set(symbol, {
        quantity,
        totalCostUsd: quantity * baselinePrice,
      });
      continue;
    }

    initialLots.set(symbol, {
      quantity,
      totalCostUsd: 0,
    });
  }

  if (preBaselineTransactions.length === 0) {
    return initialLots;
  }

  const inferredPreBaselineLots = buildAverageCostBasisBySymbol(
    preBaselineTransactions,
    baseline.date,
    fxPoints,
    new Map(),
  );

  for (const [symbol, lot] of initialLots) {
    const inferredLot = inferredPreBaselineLots.get(symbol);
    const baselinePrice = Number(baseline.holdingPrices?.[symbol]);

    if (!inferredLot || inferredLot.quantity <= 0) {
      if (Number.isFinite(baselinePrice) && baselinePrice > 0) {
        lot.totalCostUsd = lot.quantity * baselinePrice;
      }
      initialLots.set(symbol, lot);
      continue;
    }

    const inferredAvg = inferredLot.totalCostUsd / inferredLot.quantity;
    const hasInferredAvg = Number.isFinite(inferredAvg) && inferredAvg > 0;
    const knownQuantity = Math.min(lot.quantity, inferredLot.quantity);
    const unknownQuantity = Math.max(0, lot.quantity - knownQuantity);

    const knownCostUsd = hasInferredAvg ? knownQuantity * inferredAvg : 0;
    const assumedUnknownPrice = Number.isFinite(baselinePrice) && baselinePrice > 0
      ? baselinePrice
      : (hasInferredAvg ? inferredAvg : 0);
    const unknownCostUsd = unknownQuantity * assumedUnknownPrice;

    lot.totalCostUsd = knownCostUsd + unknownCostUsd;
    initialLots.set(symbol, lot);
  }

  return initialLots;
}

function getLastPriceOnOrBefore(points: Array<{ date: string; price: number }>, date: string): number | null {
  if (points.length === 0) {
    return null;
  }

  const point = [...points].reverse().find((candidate) => candidate.date <= date) ?? points[0];
  if (!point || !Number.isFinite(point.price)) {
    return null;
  }

  return point.price;
}

// Only true bank-account in/out should be treated as external performance flows.
// Internal FX settlement rows are cash mechanics of trade execution and must be excluded.
export function isUserControlledExternalFlow(tx: Pick<Transaction, 'type' | 'rawDescription'>): boolean {
  if (tx.type !== 'DEPOSIT' && tx.type !== 'WITHDRAWAL') {
    return false;
  }

  const description = String(tx.rawDescription ?? '').toLowerCase();
  if (!description) {
    return false;
  }

  if (description.includes('transfer to nom ac')) {
    return false;
  }
  if (description.includes('jpmsg:deposit')) {
    return true;
  }
  if (description.includes('de: dbsssgsg')) {
    return true;
  }
  if (description.includes('statement balance alignment')) {
    return true;
  }

  return false;
}

export function isCorruptedStatementArtifact(tx: Pick<Transaction, 'type' | 'symbol' | 'rawDescription'>): boolean {
  const description = String(tx.rawDescription ?? '').toLowerCase();
  if (!description) return false;

  // Keep valid position-changing rows even if OCR/page footer text is appended.
  if ((tx.type === 'BUY' || tx.type === 'SELL' || tx.type === 'SPLIT') && tx.symbol) {
    return false;
  }

  if (description.includes('this statement and its contents are subject to the terms and conditions')) {
    return true;
  }
  if (description.includes('generated :')) {
    return true;
  }
  if (/\bpage\s+\d+\s+of\s+\d+\b/i.test(description)) {
    return true;
  }
  if (description.includes('trading account statement')) {
    return true;
  }

  return false;
}

export function isInternalSettlementCashRow(tx: Pick<Transaction, 'type' | 'rawDescription'>): boolean {
  if (tx.type !== 'DEPOSIT' && tx.type !== 'WITHDRAWAL') {
    return false;
  }

  const description = String(tx.rawDescription ?? '').toLowerCase();
  if (!description.includes('chassgsg')) {
    return false;
  }

  // FX-settlement rows mirror trade cash effects already captured by BUY/SELL rows.
  if (description.includes('(fx)')) {
    return true;
  }

  // Plain CHASSGSG rows are internal statement settlement postings (e.g. dividend sweeps).
  // Keep explicit bank transfer rows so true account transfer events remain visible.
  if (description.includes('transfer to nom ac')) {
    return false;
  }

  return true;
}

export function sanitizeTransactionsForAnalytics(transactions: Transaction[]): Transaction[] {
  return transactions.filter((tx) => !isCorruptedStatementArtifact(tx) && !isInternalSettlementCashRow(tx));
}

function isNomineeTransferWithdrawal(tx: Pick<Transaction, 'type' | 'rawDescription'>): boolean {
  if (tx.type !== 'WITHDRAWAL') {
    return false;
  }

  const description = String(tx.rawDescription ?? '').toLowerCase();
  return description.includes('transfer to nom ac');
}

function isBankDepositRow(tx: Pick<Transaction, 'type' | 'rawDescription'>): boolean {
  if (tx.type !== 'DEPOSIT') {
    return false;
  }

  const description = String(tx.rawDescription ?? '').toLowerCase();
  return description.includes('de: dbsssgsg') || description.includes('jpmsg:deposit');
}

// Some parsed bank-transfer deposits can be clipped in statement text (e.g. 88.18 vs 988.18).
// Align each same-day bank deposit to its paired transfer withdrawal so net external flow stays accurate.
export function normalizeBankTransferPairsForAnalytics(transactions: Transaction[]): Transaction[] {
  const byDate = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    const current = byDate.get(tx.date) ?? [];
    current.push(tx);
    byDate.set(tx.date, current);
  }

  return transactions.map((tx) => {
    if (!isBankDepositRow(tx)) {
      return tx;
    }

    const sameDay = byDate.get(tx.date) ?? [];
    const pairedWithdrawal = sameDay.find((candidate) => isNomineeTransferWithdrawal(candidate));
    if (!pairedWithdrawal) {
      return tx;
    }

    const withdrawalAbs = Math.abs(toNumber(pairedWithdrawal.amount));
    if (withdrawalAbs <= 0) {
      return tx;
    }

    return {
      ...tx,
      amount: withdrawalAbs,
    };
  });
}

router.get('/', async (_req, res) => {
  const prepared = await readSupabaseDocument<Record<string, unknown>>('portfolio_snapshot');
  if (prepared) {
    res.json(prepared);
    return;
  }

  const baselines = getAllBaselines();
  const transactions = normalizeBankTransferPairsForAnalytics(sanitizeTransactionsForAnalytics(getAllTransactions()));
  const anchor = getPortfolioAnchor(baselines, transactions);
  const trackedSymbols = collectTrackedSymbols(anchor.baseline, anchor.transactionsToApply);
  const splitStart = anchor.baseline?.date ?? (anchor.transactionsToApply[0]?.date ?? '1970-01-01');
  const splitEnd = new Date().toISOString().slice(0, 10);
  const splitResult = await fetchYahooFinanceStockSplits(trackedSymbols, splitStart, splitEnd);
  const enrichedTransactions = mergeMarketSplitTransactions(anchor.transactionsToApply, splitResult.splits);
  const effectiveTransactions = sortTransactions(expandManualLinearOptionTransactions(enrichedTransactions));
  const reconstructed = reconstructState(anchor.baseline, effectiveTransactions);

  const warnings = [] as Array<{ type: string; details: unknown }>;
  for (const [symbol, qty] of Object.entries(reconstructed.holdings)) {
    if (qty < 0) {
      warnings.push({ type: 'NEGATIVE_HOLDINGS', details: { symbol, quantity: qty } });
    }
  }

  res.json({
    anchorType: anchor.anchorType,
    baselineDate: anchor.baselineDate ?? null,
    baselinesStored: baselines.length,
    transactionsStored: transactions.length,
    transactionsApplied: effectiveTransactions.length,
    state: {
      date: new Date().toISOString().slice(0, 10),
      holdings: reconstructed.holdings,
      cash: reconstructed.cash,
    },
    warnings,
  });
});

router.get('/history', async (_req, res) => {
  const prepared = await readSupabaseDocument<Record<string, unknown>>('portfolio_history');
  if (prepared) {
    res.json(prepared);
    return;
  }

  const baselines = getAllBaselines();
  const uploadsPath = path.resolve(process.cwd(), 'data/uploads.json');
  const uploads = fs.existsSync(uploadsPath)
    ? (JSON.parse(fs.readFileSync(uploadsPath, 'utf8')) as any[])
    : [];

  const cleanTransactions = normalizeBankTransferPairsForAnalytics(sanitizeTransactionsForAnalytics(getAllTransactions()));
  const anchor = getPortfolioAnchor(baselines, cleanTransactions);
  res.json({
    anchorType: anchor.anchorType,
    currentAnchorDate: anchor.baselineDate ?? null,
    baselines,
    uploads,
    totals: {
      baselines: baselines.length,
      transactions: cleanTransactions.length,
      uploads: uploads.length,
    },
  });
});

type BuildPortfolioValueResponseParams = {
  timeframe: string;
  pricingMethod: string;
  twrMode: string;
  includeDebug: boolean;
  baselines?: Baseline[];
  transactions?: Transaction[];
  uploads?: Upload[];
};

export async function buildPortfolioValueResponse({
  timeframe,
  pricingMethod,
  twrMode,
  includeDebug,
  baselines,
  transactions,
  uploads,
}: BuildPortfolioValueResponseParams) {
  const resolvedBaselines = baselines ?? getAllBaselines();
  const resolvedTransactions = normalizeBankTransferPairsForAnalytics(
    sanitizeTransactionsForAnalytics(transactions ?? getAllTransactions()),
  );

  const validTimeframe = PORTFOLIO_TIMEFRAMES.includes(timeframe as (typeof PORTFOLIO_TIMEFRAMES)[number])
    ? timeframe
    : '1y';
  const validTwrMode = PORTFOLIO_TWR_MODES.includes(twrMode as (typeof PORTFOLIO_TWR_MODES)[number])
    ? twrMode
    : 'invested_capital';

  const requestedRange = getDateRangeForTimeframe(validTimeframe);

  const anchor = getPortfolioAnchor(resolvedBaselines, resolvedTransactions);
  const baselineDate = anchor.baseline?.date ?? null;
  const sortedResolvedTransactions = sortTransactions(resolvedTransactions);
  const earliestTransactionDate = sortedResolvedTransactions[0]?.date ?? null;
  const earliestPreBaselineTransactionDate = baselineDate
    ? sortedResolvedTransactions.find((tx) => tx.date < baselineDate)?.date ?? null
    : earliestTransactionDate;
  const includePreBaselineHistory = Boolean(
    baselineDate
    && earliestPreBaselineTransactionDate
    && requestedRange.start < baselineDate,
  );

  const valuationTransactions = includePreBaselineHistory
    ? sortedResolvedTransactions
    : anchor.transactionsToApply;

  const trackedSymbolsSet = new Set<string>();
  if (anchor.baseline) {
    for (const symbol of Object.keys(anchor.baseline.holdings)) {
      trackedSymbolsSet.add(symbol);
    }
  }
  for (const tx of valuationTransactions) {
    if (tx.symbol) {
      trackedSymbolsSet.add(tx.symbol);
    }
  }
  const trackedSymbols = [...trackedSymbolsSet].sort((a, b) => a.localeCompare(b));

  const splitStart = includePreBaselineHistory
    ? (earliestTransactionDate ?? baselineDate ?? '1970-01-01')
    : (baselineDate ?? (anchor.transactionsToApply[0]?.date ?? '1970-01-01'));
  const splitEnd = new Date().toISOString().slice(0, 10);
  const splitResult = await fetchYahooFinanceStockSplits(trackedSymbols, splitStart, splitEnd);
  const splitEnriched = mergeMarketSplitTransactions(valuationTransactions, splitResult.splits);
  const txs = sortTransactions(expandManualLinearOptionTransactions(splitEnriched));
  const liveUsdSgdRate = (await fetchYahooFinanceLatestPrices(['USDSGD=X'])).livePrices['USDSGD=X'] ?? null;

  const baselineStartDate = resolvedBaselines.length ? resolvedBaselines[0].date : '1970-01-01';
  const startDate = includePreBaselineHistory && earliestTransactionDate
    ? (earliestTransactionDate < baselineStartDate ? earliestTransactionDate : baselineStartDate)
    : baselineStartDate;
  const rangeEnd = new Date().toISOString().slice(0, 10);
  const range = requestedRange;
  const start = range.start;
  const end = range.end;

  const symbols = Object.keys(reconstructState(anchor.baseline, txs).holdings);
  const priceSeries: Record<string, Array<{ date: string; price: number }>> = {};
  const { series: manualOptionSeries, optionMultipliers } = buildManualLinearOptionSeries(txs, startDate, rangeEnd);
  const manualOptionSymbols = new Set(Object.keys(manualOptionSeries));
  const symbolsToFetchFromYahoo = symbols.filter((symbol) => !manualOptionSymbols.has(symbol));
  const rawHistory = await fetchYahooFinanceHistoricalPrices(symbolsToFetchFromYahoo, startDate, rangeEnd);
  for (const [symbol, points] of Object.entries(rawHistory.history)) {
    const multiplier = optionMultipliers.get(symbol) ?? 1;
    if (points.length > 0) {
      priceSeries[symbol] = points.map((point) => ({
        date: point.date,
        price: point.price * multiplier,
      }));
    }
  }

  for (const symbol of symbols) {
    const cached = getCachedPricesForSymbol(symbol);
    if (Object.keys(cached).length > 0 && !(symbol in priceSeries)) {
      const multiplier = optionMultipliers.get(symbol) ?? 1;
      priceSeries[symbol] = Object.entries(cached)
        .map(([date, price]) => ({ date, price: price * multiplier }))
        .sort((a, b) => a.date.localeCompare(b.date));
    }
  }

  for (const [symbol, points] of Object.entries(manualOptionSeries)) {
    if (points.length > 0) {
      priceSeries[symbol] = points;
    }
  }

  const missingPriceSymbols = symbols
    .filter((symbol) => (priceSeries[symbol]?.length ?? 0) === 0)
    .sort((a, b) => a.localeCompare(b));

  const dates = new Set<string>();
  for (const points of Object.values(priceSeries)) {
    for (const point of points) {
      dates.add(point.date);
    }
  }
  const allDates = [...dates].sort();
  const fullSeries: PortfolioSeriesPoint[] = [];
  const rangeDates = allDates.filter((date) => date >= start && date <= end);
  const fxPoints = await fetchUsdSgdHistory(start, end);
  const fallbackUsdSgdRate = fxPoints.length > 0 ? fxPoints[fxPoints.length - 1]?.price ?? null : null;
  const usdSgdRate = liveUsdSgdRate ?? fallbackUsdSgdRate;
  const priceBySymbolDate = buildFilledSymbolPriceMap(symbols, rangeDates, priceSeries);
  const holdingsByDate = new Map<string, TickerHoldingsState>();

  for (const date of rangeDates) {
    const state = (() => {
      if (includePreBaselineHistory && baselineDate && date < baselineDate) {
        const relevantPreBaselineTxs = txs.filter((tx) => tx.date <= date);
        return reconstructState(null, relevantPreBaselineTxs);
      }

      if (baselineDate) {
        const relevantPostBaselineTxs = txs.filter((tx) => tx.date > baselineDate && tx.date <= date);
        return reconstructState(anchor.baseline, relevantPostBaselineTxs);
      }

      const relevantTxs = txs.filter((tx) => tx.date <= date);
      return reconstructState(null, relevantTxs);
    })();

    holdingsByDate.set(date, { ...state.holdings });
    let holdingsValue = 0;
    for (const [symbol, quantity] of Object.entries(state.holdings)) {
      const price = priceBySymbolDate.get(symbol)?.get(date) ?? 0;
      holdingsValue += (quantity || 0) * price;
    }
    fullSeries.push(buildUsdPortfolioPoint(date, holdingsValue, state.cash, fxPoints));
  }

  const samplingStep = getSamplingStepForTimeframe(validTimeframe);
  const sampledDates = rangeDates.filter((_, index) => index % samplingStep === 0 || index === rangeDates.length - 1);
  const series = fullSeries.filter((entry) => sampledDates.includes(entry.date));
  const startDateFiltered = sampledDates.find((date) => date >= start) ?? sampledDates[0] ?? range.start;

  if (series.length === 0) {
    const fallback = [{ date: rangeEnd, totalValue: 0, holdingsValue: 0, cash: 0 }];
    return {
      date: rangeEnd,
      holdingsValue: 0,
      totalValue: 0,
      startDate: range.start,
      endDate: range.end,
      twa: 0,
      totalReturn: 0,
      twr: 0,
      cagr: 0,
      pricingMethod,
      timeframe: validTimeframe,
      series: fallback,
      twrSeries: [1],
      benchmarkTwrSeries: [1],
      benchmarkReturn: 0,
      benchmarkCagr: 0,
      benchmarkVolatility: 0,
      benchmarkSymbol: null,
      positionValues: {},
      positionContributions: {},
      realizedGains: {},
      usdSgdRate,
      missingPriceSymbols,
      livePriceFetch: {
        fetchedSymbols: rawHistory.fetchedSymbols,
        failedSymbols: rawHistory.failedSymbols,
      },
    };
  }

  const effectiveStartDate = series[0].date;
  const startValue = series[0].totalValue;
  const endValue = series[series.length - 1].totalValue;
  const totalReturn = startValue === 0 ? 0 : endValue / startValue - 1;

  const externalFlows = txs
    .filter((tx) => tx.date >= effectiveStartDate && tx.date <= end)
    .filter((tx) => isUserControlledExternalFlow(tx))
    .map((tx) => {
      const signedSgd = tx.type === 'DEPOSIT' ? Math.abs(tx.amount) : -Math.abs(tx.amount);
      const signedUsd = convertSgdToUsd(signedSgd, tx.date, fxPoints);
      return { date: tx.date, amount: signedUsd };
    });

  const netExternalFlow = externalFlows.reduce((sum, entry) => sum + entry.amount, 0);

  const accountTwr = calculateTwrFromSeries(fullSeries, externalFlows);
  const accountTwrWithoutExternalFlows = calculateTwrFromSeries(fullSeries, []);

  const investedCapitalTradeTransactions = txs
    .filter((tx) => tx.date >= effectiveStartDate && tx.date <= end)
    .filter((tx) => tx.type === 'BUY' || tx.type === 'SELL');

  const preRangeState = reconstructState(anchor.baseline, txs.filter((tx) => tx.date < effectiveStartDate));
  const investedCapitalResult = calculateInvestedCapitalTwrFromTradeBoundaries(
    rangeDates,
    preRangeState,
    investedCapitalTradeTransactions,
    priceBySymbolDate,
    fxPoints,
  );
  const investedCapitalTwr = investedCapitalResult.twr;
  const investedCapitalFlows = investedCapitalResult.flows;

  const twr = validTwrMode === 'account_total' ? accountTwr : investedCapitalTwr;
  const twrWithoutExternalFlows = validTwrMode === 'account_total'
    ? accountTwrWithoutExternalFlows
    : calculateInvestedCapitalTwr(
      fullSeries.map((entry) => ({ date: entry.date, holdingsValue: entry.holdingsValue })),
      [],
    );
  const attributionSeries = validTwrMode === 'account_total'
    ? fullSeries
    : fullSeries.map((entry) => ({
      ...entry,
      totalValue: entry.holdingsValue,
      cash: 0,
    }));
  const attributionFlows = validTwrMode === 'account_total' ? externalFlows : investedCapitalFlows;

  const { symbolContributions: twrSymbolContributions, residualContribution } = computeTwrSymbolContributions(
    symbols,
    rangeDates,
    attributionSeries,
    holdingsByDate,
    priceBySymbolDate,
    attributionFlows,
    txs.filter((tx) => tx.date >= effectiveStartDate && tx.date <= end),
    fxPoints,
  );
  const twrSymbolContributionTotal = Object.values(twrSymbolContributions).reduce((sum, value) => sum + value, 0);
  const twrResidualBreakdown = computeTwrResidualBreakdown(attributionSeries, attributionFlows, twrSymbolContributionTotal);
  const accountStartValue = series[0]?.totalValue ?? 0;
  const hasValidAccountStartBase = validTwrMode === 'account_total'
    ? Number.isFinite(accountStartValue) && accountStartValue > 0
    : true;

  const displayTwr = hasValidAccountStartBase ? twr : null;
  const years = Math.max((new Date(end).getTime() - new Date(effectiveStartDate).getTime()) / (365.25 * 86400 * 1000), 1 / 12);
  const cagr = displayTwr === null ? null : (1 + displayTwr) ** (1 / years) - 1;

  const displayTwrSeries = validTwrMode === 'account_total'
    ? calculateCumulativeTwrFactorSeries(
      attributionSeries.map((entry) => ({ date: entry.date, totalValue: entry.totalValue })),
      attributionFlows,
    )
    : calculateInvestedCapitalTwrFactorSeriesFromTradeBoundaries(
      rangeDates,
      preRangeState,
      investedCapitalTradeTransactions,
      priceBySymbolDate,
      fxPoints,
    );

  let benchmarkTwrSeries = series.map(() => 1);
  let benchmarkReturn = 0;
  let benchmarkCagr = 0;
  let benchmarkVolatility = 0;
  let benchmarkSymbol: string | null = null;

  const sampledDatesForBenchmark = series.map((entry) => entry.date);
  const benchmarkCandidates = ['^GSPC', 'VOO'];
  const benchmarkResult = await fetchBenchmarkSeriesWithFallback(
    benchmarkCandidates,
    sampledDatesForBenchmark,
    startDate,
    effectiveStartDate,
    rangeEnd,
  );
  if (benchmarkResult) {
    benchmarkTwrSeries = benchmarkResult.normalized;
    benchmarkSymbol = benchmarkResult.symbol;
    const first = benchmarkResult.normalized[0] ?? 1;
    const last = benchmarkResult.normalized[benchmarkResult.normalized.length - 1] ?? first;
    benchmarkReturn = first === 0 ? 0 : last / first - 1;
    benchmarkCagr = (1 + benchmarkReturn) ** (1 / years) - 1;
    benchmarkVolatility = calculateAnnualizedVolatilityFromPriceSeries(
      benchmarkResult.points.filter((point) => point.date >= effectiveStartDate && point.date <= end),
    );
  }

  const latestState = reconstructState(anchor.baseline, txs);
  const preBaselineTransactions = anchor.baseline
    ? resolvedTransactions.filter((tx) => tx.date < anchor.baseline!.date)
    : [];
  const initialLots = buildInitialLotsFromBaselineAndPreBaselineTransactions(
    anchor.baseline,
    preBaselineTransactions,
    fxPoints,
  );
  const realizedGains = computeRealizedGainsForRange(txs, effectiveStartDate, end, fxPoints);
  const costBasisAtStart = buildAverageCostBasisBySymbol(txs, effectiveStartDate, fxPoints, initialLots);
  const costBasisAtEnd = buildAverageCostBasisBySymbol(txs, end, fxPoints, initialLots);
  const positionValues: Record<string, number> = {};
  const positionContributions: Record<string, number> = {};

  for (const [symbol, quantity] of Object.entries(latestState.holdings)) {
    const pricePoints = priceSeries[symbol] ?? [];
    const latestPoint = [...pricePoints].reverse().find((point) => point.date <= end) ?? pricePoints[pricePoints.length - 1];
    if (latestPoint) {
      positionValues[symbol] = quantity * latestPoint.price;
    }
  }

  const contributionSymbols = new Set<string>([
    ...Object.keys(realizedGains),
    ...[...costBasisAtStart.keys()],
    ...[...costBasisAtEnd.keys()],
  ]);

  for (const symbol of contributionSymbols) {
    const symbolPriceSeries = priceSeries[symbol] ?? [];
    const startPrice = getLastPriceOnOrBefore(symbolPriceSeries, effectiveStartDate);
    const endPrice = getLastPriceOnOrBefore(symbolPriceSeries, end);

    const startBasis = costBasisAtStart.get(symbol);
    const endBasis = costBasisAtEnd.get(symbol);

    const startUnrealized =
      startBasis && startBasis.quantity > 0 && startPrice !== null
        ? startBasis.quantity * (startPrice - startBasis.totalCostUsd / startBasis.quantity)
        : 0;

    const endUnrealized =
      endBasis && endBasis.quantity > 0 && endPrice !== null
        ? endBasis.quantity * (endPrice - endBasis.totalCostUsd / endBasis.quantity)
        : 0;

    const realized = realizedGains[symbol] ?? 0;
    const contribution = realized + (endUnrealized - startUnrealized);
    if (Math.abs(contribution) > 1e-9) {
      positionContributions[symbol] = contribution;
    }
  }

  const response: Record<string, unknown> = {
    date: new Date().toISOString().slice(0, 10),
    holdingsValue: series[series.length - 1].holdingsValue,
    totalValue: series[series.length - 1].totalValue,
    startDate: effectiveStartDate,
    endDate: end,
    totalReturn,
    // Flow-adjusted gain/loss helps explain performance independent of user cash movements.
    totalGainLoss: (endValue - startValue) - netExternalFlow,
    netExternalFlow,
    twr: displayTwr ?? undefined,
    twrMode: validTwrMode,
    accountTwr,
    investedCapitalTwr,
    cagr: cagr ?? undefined,
    pricingMethod,
    timeframe: validTimeframe,
    series,
    twrSeries: displayTwrSeries,
    benchmarkTwrSeries,
    benchmarkReturn,
    benchmarkCagr,
    benchmarkVolatility,
    benchmarkSymbol,
    positionValues,
    positionContributions,
    twrSymbolContributions,
    twrUnattributedContribution: residualContribution,
    twrResidualBreakdown,
    realizedGains,
    usdSgdRate,
    missingPriceSymbols,
    livePriceFetch: {
      fetchedSymbols: rawHistory.fetchedSymbols,
      failedSymbols: rawHistory.failedSymbols,
    },
    lastPriceSyncAt: lastLivePriceSyncAt,
  };

  if (includeDebug) {
    const allUploads = uploads ?? getAllUploads();
    const transactionUploads = allUploads.filter((upload) => upload.type === 'TRANSACTIONS');
    const parserRowsConsidered = transactionUploads.reduce((sum, upload) => {
      const value = Number(upload.metadata?.rowsConsidered ?? 0);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
    const parserUnknownTypeRows = transactionUploads.reduce((sum, upload) => {
      const value = Number(upload.metadata?.unknownTypeRows ?? 0);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
    const parserHeuristicClassifiedRows = transactionUploads.reduce((sum, upload) => {
      const value = Number(upload.metadata?.heuristicClassifiedRows ?? 0);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);

    response.debug = {
      timeframe: validTimeframe,
      pricePointCount: fullSeries.length,
      sampledPointCount: series.length,
      twrWithoutExternalFlows,
      twrFlowImpact: twr - twrWithoutExternalFlows,
      externalFlowCount: externalFlows.length,
      externalFlows,
      investedCapitalFlowCount: investedCapitalFlows.length,
      investedCapitalFlows,
      twrResidualBreakdown,
      parserRowsConsidered,
      parserUnknownTypeRows,
      parserHeuristicClassifiedRows,
      parserUnknownTypeRate: parserRowsConsidered === 0 ? 0 : parserUnknownTypeRows / parserRowsConsidered,
      parserHeuristicClassifiedRate: parserRowsConsidered === 0 ? 0 : parserHeuristicClassifiedRows / parserRowsConsidered,
    };
  }

  return response;
}

router.get('/value', async (req: Request, res: Response) => {
  const timeframe = String(req.query.timeframe ?? '1y');
  const pricingMethod = String(req.query.pricingMethod ?? 'yahoo_finance');
  const twrMode = String(req.query.twrMode ?? 'invested_capital');
  const includeDebug = String(req.query.debug ?? '0') === '1';

  const prepared = await readSupabaseDocument<Record<string, any>>('portfolio_value');
  const preparedSlice = prepared?.byTimeframe?.[timeframe]?.[twrMode];
  if (preparedSlice && !includeDebug) {
    res.json(preparedSlice);
    return;
  }

  if (prepared && !prepared.byTimeframe && !includeDebug) {
    res.json(prepared);
    return;
  }

  const computed = await buildPortfolioValueResponse({
    timeframe,
    pricingMethod,
    twrMode,
    includeDebug,
  });
  res.json(computed);
});

export default router;
