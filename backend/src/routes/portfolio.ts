import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';

import { getAllBaselines, getAllTransactions, getAllUploads } from '../store.js';
import { getPortfolioAnchor } from '../portfolioState.js';
import { applyTransaction, reconstructState, sortTransactions } from '../reconstruction.js';
import { fetchYahooFinanceHistoricalPrices, fetchYahooFinanceLatestPrices, lastLivePriceSyncAt } from '../pricing.js';
import { mergeMarketSplitTransactions } from '../marketSplits.js';
import { getCachedPricesForSymbol } from '../priceCache.js';
import { convertSgdToUsd, fetchUsdSgdHistory } from '../fx.js';
import type { Transaction } from '../parsers.js';
import type { PricePoint } from '../pricing.js';

const router = Router();

export function getDateRangeForTimeframe(timeframe: string, referenceDate: Date = new Date()) {
  const end = new Date(referenceDate);
  const endIso = end.toISOString().slice(0, 10);

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
    default:
      return 5;
  }
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

export function isCorruptedStatementArtifact(tx: Pick<Transaction, 'rawDescription'>): boolean {
  const description = String(tx.rawDescription ?? '').toLowerCase();
  if (!description) return false;

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

router.get('/', (_req, res) => {
  const baselines = getAllBaselines();
  const transactions = normalizeBankTransferPairsForAnalytics(sanitizeTransactionsForAnalytics(getAllTransactions()));
  const anchor = getPortfolioAnchor(baselines, transactions);
  const reconstructed = reconstructState(anchor.baseline, anchor.transactionsToApply);

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
    transactionsApplied: anchor.transactionsToApply.length,
    state: {
      date: new Date().toISOString().slice(0, 10),
      holdings: reconstructed.holdings,
      cash: reconstructed.cash,
    },
    warnings,
  });
});

router.get('/history', (_req, res) => {
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

router.get('/value', async (req: Request, res: Response) => {
  const timeframe = String(req.query.timeframe ?? '1y');
  const pricingMethod = String(req.query.pricingMethod ?? 'yahoo_finance');
  const twrMode = String(req.query.twrMode ?? 'invested_capital');
  const includeDebug = String(req.query.debug ?? '0') === '1';
  const baselines = getAllBaselines();
  const transactions = normalizeBankTransferPairsForAnalytics(sanitizeTransactionsForAnalytics(getAllTransactions()));
  const anchor = getPortfolioAnchor(baselines, transactions);
  const txs = sortTransactions(anchor.transactionsToApply);
  const usdSgdRate = (await fetchYahooFinanceLatestPrices(['USDSGD=X'])).livePrices['USDSGD=X'] ?? null;

  const startDate = baselines.length ? baselines[0].date : '1970-01-01';
  const rangeEnd = new Date().toISOString().slice(0, 10);
  const range = getDateRangeForTimeframe(timeframe);
  const start = range.start;
  const end = range.end;

  const symbols = Object.keys(reconstructState(anchor.baseline, txs).holdings);
  const priceSeries: Record<string, Array<{ date: string; price: number }>> = {};
  const rawHistory = await fetchYahooFinanceHistoricalPrices(symbols, startDate, rangeEnd);
  for (const [symbol, points] of Object.entries(rawHistory.history)) {
    if (points.length > 0) {
      priceSeries[symbol] = points;
    }
  }

  for (const symbol of symbols) {
    const cached = getCachedPricesForSymbol(symbol);
    if (Object.keys(cached).length > 0 && !(symbol in priceSeries)) {
      priceSeries[symbol] = Object.entries(cached)
        .map(([date, price]) => ({ date, price }))
        .sort((a, b) => a.date.localeCompare(b.date));
    }
  }

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
  const priceBySymbolDate = buildFilledSymbolPriceMap(symbols, rangeDates, priceSeries);
  const holdingsByDate = new Map<string, TickerHoldingsState>();

  for (const date of rangeDates) {
    const relevantTxs = txs.filter((tx) => tx.date <= date);
    const state = reconstructState(anchor.baseline, relevantTxs);
    holdingsByDate.set(date, { ...state.holdings });
    let holdingsValue = 0;
    for (const [symbol, quantity] of Object.entries(state.holdings)) {
      const price = priceBySymbolDate.get(symbol)?.get(date) ?? 0;
      holdingsValue += (quantity || 0) * price;
    }
    fullSeries.push(buildUsdPortfolioPoint(date, holdingsValue, state.cash, fxPoints));
  }

  const samplingStep = getSamplingStepForTimeframe(timeframe);
  const sampledDates = rangeDates.filter((_, index) => index % samplingStep === 0 || index === rangeDates.length - 1);
  const series = fullSeries.filter((entry) => sampledDates.includes(entry.date));
  const startDateFiltered = sampledDates.find((date) => date >= start) ?? sampledDates[0] ?? range.start;

  if (series.length === 0) {
    const fallback = [{ date: rangeEnd, totalValue: 0, holdingsValue: 0, cash: 0 }];
    res.json({
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
      timeframe,
      series: fallback,
      twrSeries: [1],
      benchmarkTwrSeries: [1],
      benchmarkReturn: 0,
      benchmarkCagr: 0,
      benchmarkVolatility: 0,
      positionValues: {},
      positionContributions: {},
      realizedGains: {},
      usdSgdRate,
      missingPriceSymbols: [],
      livePriceFetch: { fetchedSymbols: [], failedSymbols: [] },
    });
    return;
  }

  const startValue = series[0].totalValue;
  const endValue = series[series.length - 1].totalValue;
  const totalReturn = startValue === 0 ? 0 : endValue / startValue - 1;

  const externalFlows = txs
    .filter((tx) => tx.date >= start && tx.date <= end)
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
    .filter((tx) => tx.date >= start && tx.date <= end)
    .filter((tx) => tx.type === 'BUY' || tx.type === 'SELL');

  const preRangeState = reconstructState(anchor.baseline, txs.filter((tx) => tx.date < start));
  const investedCapitalResult = calculateInvestedCapitalTwrFromTradeBoundaries(
    rangeDates,
    preRangeState,
    investedCapitalTradeTransactions,
    priceBySymbolDate,
    fxPoints,
  );
  const investedCapitalTwr = investedCapitalResult.twr;
  const investedCapitalFlows = investedCapitalResult.flows;

  const twr = twrMode === 'account_total' ? accountTwr : investedCapitalTwr;
  const twrWithoutExternalFlows = twrMode === 'account_total'
    ? accountTwrWithoutExternalFlows
    : calculateInvestedCapitalTwr(
      fullSeries.map((entry) => ({ date: entry.date, holdingsValue: entry.holdingsValue })),
      [],
    );
  const attributionSeries = twrMode === 'account_total'
    ? fullSeries
    : fullSeries.map((entry) => ({
      ...entry,
      totalValue: entry.holdingsValue,
      cash: 0,
    }));
  const attributionFlows = twrMode === 'account_total' ? externalFlows : investedCapitalFlows;

  const { symbolContributions: twrSymbolContributions, residualContribution } = computeTwrSymbolContributions(
    symbols,
    rangeDates,
    attributionSeries,
    holdingsByDate,
    priceBySymbolDate,
    attributionFlows,
    txs.filter((tx) => tx.date >= start && tx.date <= end),
    fxPoints,
  );
  const twrSymbolContributionTotal = Object.values(twrSymbolContributions).reduce((sum, value) => sum + value, 0);
  const twrResidualBreakdown = computeTwrResidualBreakdown(attributionSeries, attributionFlows, twrSymbolContributionTotal);
  const years = Math.max((new Date(end).getTime() - new Date(start).getTime()) / (365.25 * 86400 * 1000), 1 / 12);
  const cagr = (1 + twr) ** (1 / years) - 1;

  const latestState = reconstructState(anchor.baseline, txs);
  const positionValues: Record<string, number> = {};
  const positionContributions: Record<string, number> = {};

  for (const [symbol, quantity] of Object.entries(latestState.holdings)) {
    const pricePoints = priceSeries[symbol] ?? [];
    const latestPoint = [...pricePoints].reverse().find((point) => point.date <= end) ?? pricePoints[pricePoints.length - 1];
    if (latestPoint) {
      positionValues[symbol] = quantity * latestPoint.price;
    }
  }

  const baselineState = reconstructState(anchor.baseline, txs.filter((tx) => tx.date <= startDateFiltered));
  for (const [symbol, quantity] of Object.entries(baselineState.holdings)) {
    const startPoints = priceSeries[symbol] ?? [];
    const startPoint = [...startPoints].reverse().find((point) => point.date <= startDateFiltered) ?? startPoints[0];
    const endPoint = [...startPoints].reverse().find((point) => point.date <= end) ?? startPoints[startPoints.length - 1];
    if (startPoint && endPoint) {
      positionContributions[symbol] = quantity * (endPoint.price - startPoint.price);
    }
  }

  const response: Record<string, unknown> = {
    date: new Date().toISOString().slice(0, 10),
    holdingsValue: series[series.length - 1].holdingsValue,
    totalValue: series[series.length - 1].totalValue,
    startDate: start,
    endDate: end,
    totalReturn,
    // Flow-adjusted gain/loss helps explain performance independent of user cash movements.
    totalGainLoss: (endValue - startValue) - netExternalFlow,
    netExternalFlow,
    twr,
    twrMode,
    accountTwr,
    investedCapitalTwr,
    cagr,
    pricingMethod,
    timeframe,
    series,
    twrSeries: series.map((entry) => entry.totalValue / series[0].totalValue),
    benchmarkTwrSeries: series.map((entry) => 1),
    benchmarkReturn: 0,
    benchmarkCagr: 0,
    benchmarkVolatility: 0,
    positionValues,
    positionContributions,
    twrSymbolContributions,
    twrUnattributedContribution: residualContribution,
    twrResidualBreakdown,
    realizedGains: {},
    usdSgdRate,
    missingPriceSymbols: [],
    livePriceFetch: null,
    lastPriceSyncAt: lastLivePriceSyncAt,
  };

  if (includeDebug) {
    const transactionUploads = getAllUploads().filter((upload) => upload.type === 'TRANSACTIONS');
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
      timeframe,
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

  res.json(response);
});

export default router;
