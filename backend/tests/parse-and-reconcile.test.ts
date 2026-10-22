import { describe, expect, test } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Transaction } from '../src/parsers.js';
import { parseBaselineText, parseTransactionText } from '../src/parsers.js';
import { reconcileBaseline } from '../src/reconciliation.js';
import { getCachedPriceRange, setCachedPriceRange } from '../src/priceCache.js';
import { getMissingPreloadWindows, getPreloadDateWindows } from '../src/eagerLoader.js';
import {
  buildUsdPortfolioPoint,
  calculateTwrFromSeries,
  calculateInvestedCapitalTwrFromTradeBoundaries,
  computeRealizedGainsForRange,
  getDateRangeForTimeframe,
  isCorruptedStatementArtifact,
  isInternalSettlementCashRow,
  isUserControlledExternalFlow,
  sanitizeTransactionsForAnalytics,
  normalizeBankTransferPairsForAnalytics,
  deriveManualOptionCloseTransactions,
} from '../src/routes/portfolio.js';
import { applyTransaction, reconstructState, sortTransactions } from '../src/reconstruction.js';
import { buildManualTransaction, buildOptionContractSymbol } from '../src/manualTrades.js';
import { buildManualLinearOptionSeries } from '../src/manualOptionValuation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function extractPdfTextOrSkip(samplePath: string): string | null {
  if (!existsSync(samplePath)) {
    return null;
  }

  const pdfBuffer = readFileSync(samplePath);

  try {
    return execFileSync('pdftotext', ['-layout', '-', '-'], {
      input: pdfBuffer,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch {
    try {
      return execFileSync('pdftotext', ['-', '-'], {
        input: pdfBuffer,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
      });
    } catch {
      return null;
    }
  }
}

describe('transaction parsing', () => {
  test('parses buy, sell and dividend rows from a statement CSV', () => {
    const csv = `Date,Description,Debit $,Credit $,Balance $
"05/02/2025","Bght 186 AMDG:US @ 18.0177 SGD","3351.30","","77.98"
"07/02/2025","Sold 186 AMDG:US @ 15.6466 SGD","","2910.20","2988.18"
"11/02/2025","JNL2974255 MA:US Intl Div  Ex:10/01/25","","2.88","2.88"`;

    const result = parseTransactionText(csv, 'sample.csv');

    expect(result.errors).toHaveLength(0);
    expect(result.accepted).toHaveLength(3);
    expect(result.diagnostics.rowsConsidered).toBe(3);
    expect(result.diagnostics.unknownTypeRows).toBe(0);
    expect(result.accepted[0]).toMatchObject({ type: 'BUY', symbol: 'AMDG', quantity: 186, amount: -3351.3 });
    expect(result.accepted[1]).toMatchObject({ type: 'SELL', symbol: 'AMDG', quantity: 186, amount: 2910.2 });
    expect(result.accepted[2]).toMatchObject({ type: 'DIVIDEND', symbol: 'MA', amount: 2.88 });
  });

  test('parses detailed statement rows with explicit reference ids so trade quantities are preserved', () => {
    const statement = `Date               Reference          Description                                                                                                   Debit                 Credit          Balance
28/01/2025         16118              Bght 15 NVDA:US @ 161.7654 SGD                                                                                2,426.48                           2,426.48
29/01/2025         16272              Bght 14 NVDA:US @ 170.8668 SGD                                                                                2,392.14                           4,818.62
28/04/2025         21343              Bght 14 GOOGL:US @ 208.0124 SGD                                                                               2,912.17                           2,912.17
30/06/2025         24515              Bght 9 GOOGL:US @ 222.9619 SGD                                                                                2,006.66                           2,006.66
28/07/2025         26199              Bght 22 GOOGL:US @ 248.9617 SGD                                                                               5,477.16                           5,477.16
18/09/2025         29415              Bght 10 GOOGL:US @ 318.7962 SGD                                                                               3,187.96                           5,837.14
26/09/2025         29967              Bght 15 GOOGL:US @ 312.5781 SGD                                                                               4,688.67                           9,839.08`;

    const result = parseTransactionText(statement, 'statement.txt');

    expect(result.errors).toHaveLength(0);
    expect(result.accepted).toHaveLength(7);
    expect(result.accepted[0]).toMatchObject({ id: '16118', type: 'BUY', symbol: 'NVDA', quantity: 15 });
    expect(result.accepted[1]).toMatchObject({ id: '16272', type: 'BUY', symbol: 'NVDA', quantity: 14 });
    expect(result.accepted[6]).toMatchObject({ id: '29967', type: 'BUY', symbol: 'GOOGL', quantity: 15 });
  });

  test('flags missing referenced trade rows when only settlement rows are present', () => {
    const statement = `Date               Reference          Description                                                                                                   Debit                 Credit          Balance
31/01/2025         26496159           Wdl CHASSGSG 100000003011513 16118(FX) 16272(FX)                                                                                  4,818.62                0.00`;

    const result = parseTransactionText(statement, 'statement.txt');

    expect(result.parseErrors).toBeGreaterThan(0);
    expect(result.errors.some((entry) => entry.reason.includes('Missing referenced trade rows'))).toBe(true);
  });

  test('classifies Wdl TRANSFER rows as WITHDRAWAL to keep cash-flow signs correct', () => {
    const csv = `Date,Description,Debit $,Credit $,Balance $\n"10/02/2025","Wdl TRANSFER TO NOM AC","2988.18","","0.00"`;
    const result = parseTransactionText(csv, 'summary.csv');

    expect(result.errors).toHaveLength(0);
    expect(result.accepted).toHaveLength(1);
    expect(result.diagnostics.heuristicClassifiedRows).toBe(1);
    expect(result.accepted[0]).toMatchObject({ type: 'WITHDRAWAL', amount: -2988.18 });
  });

  test('quarantines unknown transaction descriptions instead of defaulting to deposit', () => {
    const csv = `Date,Description,Debit $,Credit $,Balance $\n"12/02/2025","Random unmatched broker text","10.00","","0.00"`;
    const result = parseTransactionText(csv, 'unknown.csv');

    expect(result.accepted).toHaveLength(0);
    expect(result.parseErrors).toBeGreaterThan(0);
    expect(result.diagnostics.rowsConsidered).toBe(1);
    expect(result.diagnostics.unknownTypeRows).toBe(1);
    expect(result.errors.some((entry) => entry.reason.includes('Unknown transaction type'))).toBe(true);
  });

  test('ignores statement page header/footer noise without corrupting transaction amounts', () => {
    const statement = `Date               Reference          Description                                                                                                   Debit                 Credit          Balance
04/04/2025         3145597            JNL3145597 NVDA:US Intl Div Ex:12/03/25                                                                                                 2.09           2.09Cr
This statement and its contents are subject to the terms and conditions governing your CMC Invest account with CMC Markets Singapore Pte. Ltd
Page 1 of 6
Generated : 21/10/2026 11:48 AM
MR CHEO KEE JIN
27 HILLVIEW AVENUE
Trading Account Statement
05/10/2026         5263574            JNL5263574 NVDA:US Intl Div Ex:10/09/26                                                                                               49.69           52.01Cr`;

    const result = parseTransactionText(statement, 'statement.txt');

    expect(result.errors).toHaveLength(0);
    expect(result.accepted).toHaveLength(2);
    expect(result.accepted[0]).toMatchObject({ id: '3145597', type: 'DIVIDEND', amount: 2.09 });
    expect(result.accepted[1]).toMatchObject({ id: '5263574', type: 'DIVIDEND', amount: 49.69 });
  });

  test('reads trade prices correctly when the statement uses a space as a thousands separator', () => {
    const statement = `Date               Reference          Description                                                                                                   Debit                 Credit          Balance
11/02/2026         38801              Sold 1 COST:US @ 1 242.1078 SGD                                                                                               1,242.11        1,242.11Cr
11/02/2026         38803              Bght 1 META:US @ 852.2297 SGD                                                                                852.23                                389.88Cr`;

    const result = parseTransactionText(statement, 'statement.txt');

    expect(result.errors).toHaveLength(0);
    expect(result.accepted).toHaveLength(2);
    expect(result.accepted[0]).toMatchObject({ id: '38801', type: 'SELL', symbol: 'COST', quantity: 1, price: 1242.1078, amount: 1242.11 });
    expect(result.accepted[1]).toMatchObject({ id: '38803', type: 'BUY', symbol: 'META', quantity: 1, price: 852.2297, amount: -852.23 });
  });
});

describe('baseline parsing', () => {
  test('parses bank balance as cash instead of total shares market value', () => {
    const baseline = `Portfolio Report\nAt Close of Trading Day: 01/01/2025\nADBE:US Technology ADOBE INC 8 444.680USD\nGOOGL:US Communications ALPHABET INC 54 189.300USD\nTotal Market Value of Shares 110,259.37\nBank Balance 207.30\nTotal 110,466.67`;
    const result = parseBaselineText(baseline, 'baseline.txt');

    expect(result.ok).toBe(true);
    expect(result.baseline?.cash).toBe(207.3);
    expect(result.baseline?.holdings?.ADBE).toBe(8);
    expect(result.baseline?.holdings?.GOOGL).toBe(54);
  });
});

describe('holdings reconstruction from baseline + trades', () => {
  test('reconstructs NVDA and GOOGL quantities from baseline plus statement trades', () => {
    const baseline = {
      id: 'baseline-2025-01-01',
      date: '2025-01-01',
      holdings: { NVDA: 193, GOOGL: 54 },
      cash: 207.3,
      source: 'baseline.pdf',
    };

    const statement = `Date               Reference          Description                                                                                                   Debit                 Credit          Balance
28/01/2025         16118              Bght 15 NVDA:US @ 161.7654 SGD                                                                             2,426.48                                 2,426.48
29/01/2025         16272              Bght 14 NVDA:US @ 170.8668 SGD                                                                             2,392.14                                 4,818.62
28/04/2025         21343              Bght 14 GOOGL:US @ 208.0124 SGD                                                                            2,912.17                                 2,912.17
30/06/2025         24515              Bght 9 GOOGL:US @ 222.9619 SGD                                                                             2,006.66                                 2,006.66
28/07/2025         26199              Bght 22 GOOGL:US @ 248.9617 SGD                                                                            5,477.16                                 5,477.16
18/09/2025         29415              Bght 10 GOOGL:US @ 318.7962 SGD                                                                            3,187.96                                 5,837.14
26/09/2025         29967              Bght 15 GOOGL:US @ 312.5781 SGD                                                                            4,688.67                                 9,839.08`;

    const parsed = parseTransactionText(statement, 'statement.txt');
    const reconstructed = reconstructState(baseline, parsed.accepted);

    expect(parsed.errors).toHaveLength(0);
    expect(reconstructed.holdings.NVDA).toBe(222);
    expect(reconstructed.holdings.GOOGL).toBe(124);
  });
});

describe('price range cache', () => {
  test('reuses a cached date range for repeated lookups', () => {
    const symbol = 'AAPL';
    const points = [
      { date: '2025-01-01', price: 100 },
      { date: '2025-01-02', price: 101 },
    ];

    setCachedPriceRange(symbol, '2025-01-01', '2025-01-02', points);

    expect(getCachedPriceRange(symbol, '2025-01-01', '2025-01-02')).toEqual(points);
  });
});

describe('eager preload windows', () => {
  test('includes the common timeframe windows users switch between', () => {
    const windows: Array<{ label: string; start: string; end: string }> = getPreloadDateWindows(new Date('2026-10-21T00:00:00Z'));

    expect(windows.map((entry: { label: string; start: string; end: string }) => entry.label)).toEqual(expect.arrayContaining(['5d', '1m', '3m', '6m', 'ytd', '1y', '3y', '5y']));
    expect(windows.some((entry: { label: string; start: string; end: string }) => entry.label === '5y' && entry.start < entry.end)).toBe(true);
    expect(windows.some((entry: { label: string; start: string; end: string }) => entry.label === '5y' && entry.start < '2026-01-01')).toBe(true);
  });

  test('skips already-cached preload windows during a restart', () => {
    const referenceDate = new Date('2026-10-21T00:00:00Z');
    const symbols = ['AAPL', 'MSFT'];
    const windows = getPreloadDateWindows(referenceDate);

    for (const window of windows) {
      for (const symbol of symbols) {
        setCachedPriceRange(symbol, window.start, window.end, [{ date: window.end, price: 100 }]);
      }
    }

    expect(getMissingPreloadWindows(symbols, referenceDate)).toEqual([]);
  });
});

describe('timeframe ranges', () => {
  test('uses the calendar year start for ytd and a trailing-year window for 1y', () => {
    const referenceDate = new Date('2026-10-21T00:00:00Z');

    const ytd = getDateRangeForTimeframe('ytd', referenceDate);
    const oneYear = getDateRangeForTimeframe('1y', referenceDate);

    expect(ytd).toEqual({ start: '2026-01-01', end: '2026-10-21' });
    expect(oneYear).toEqual({ start: '2025-10-21', end: '2026-10-21' });
    expect(ytd.start).not.toBe(oneYear.start);
  });
});

describe('time-weighted returns', () => {
  test('uses the full underlying series instead of a coarsely sampled one', () => {
    const series = [
      { date: '2026-01-01', totalValue: 100, holdingsValue: 100, cash: 0 },
      { date: '2026-01-15', totalValue: 120, holdingsValue: 100, cash: 20 },
      { date: '2026-03-31', totalValue: 150, holdingsValue: 120, cash: 30 },
    ];

    const flows = [{ date: '2026-01-15', amount: 20 }];

    expect(calculateTwrFromSeries(series, flows)).toBeCloseTo(0.25, 5);
  });

  test('uses the start value of each sub-period, not the first value in the whole series', () => {
    const series = [
      { date: '2026-01-01', totalValue: 1000, holdingsValue: 1000, cash: 0 },
      { date: '2026-01-15', totalValue: 1100, holdingsValue: 1000, cash: 100 },
      { date: '2026-02-01', totalValue: 1150, holdingsValue: 1000, cash: 150 },
    ];

    const flows = [{ date: '2026-01-15', amount: 100 }];

    expect(calculateTwrFromSeries(series, flows)).toBeCloseTo(0.0454545454545454, 5);
  });

  test('ignores a deposit as an external cash flow when calculating TWR', () => {
    const series = [
      { date: '2026-01-01', totalValue: 1000, holdingsValue: 1000, cash: 0 },
      { date: '2026-01-15', totalValue: 1200, holdingsValue: 1000, cash: 200 },
      { date: '2026-02-01', totalValue: 1300, holdingsValue: 1000, cash: 300 },
    ];

    const flows = [{ date: '2026-01-15', amount: 200 }];

    expect(calculateTwrFromSeries(series, flows)).toBeCloseTo(0.08333333333333337, 5);
  });

  test('uses the adjusted start value when a deposit or withdrawal changes the period base', () => {
    const series = [
      { date: '2026-01-01', totalValue: 100, holdingsValue: 100, cash: 0 },
      { date: '2026-01-15', totalValue: 190, holdingsValue: 90, cash: 100 },
    ];

    const flows = [{ date: '2026-01-15', amount: 100 }];

    expect(calculateTwrFromSeries(series, flows)).toBeCloseTo(-0.05, 5);
  });

  test('treats a new stock purchase as a buy, not as a performance-driving cash flow', () => {
    const series = [
      { date: '2026-01-01', totalValue: 2000, holdingsValue: 1000, cash: 1000 },
      { date: '2026-01-15', totalValue: 2100, holdingsValue: 1650, cash: 450 },
      { date: '2026-02-01', totalValue: 2250, holdingsValue: 1800, cash: 450 },
    ];

    expect(calculateTwrFromSeries(series, [])).toBeCloseTo(0.125, 5);
  });

  test('treats a partial sell or closeout as a trade, not as an external performance flow', () => {
    const series = [
      { date: '2026-01-01', totalValue: 2000, holdingsValue: 1000, cash: 1000 },
      { date: '2026-01-15', totalValue: 2100, holdingsValue: 660, cash: 1440 },
      { date: '2026-02-01', totalValue: 2160, holdingsValue: 720, cash: 1440 },
    ];

    expect(calculateTwrFromSeries(series, [])).toBeCloseTo(0.08, 3);
  });

  test('does not inflate return when a withdrawal happens within the timeframe', () => {
    const series = [
      { date: '2026-01-01', totalValue: 1000, holdingsValue: 900, cash: 100 },
      { date: '2026-01-15', totalValue: 900, holdingsValue: 800, cash: 100 },
      { date: '2026-02-01', totalValue: 950, holdingsValue: 850, cash: 100 },
    ];

    const flows = [{ date: '2026-01-15', amount: -100 }];

    expect(calculateTwrFromSeries(series, flows)).toBeCloseTo(0.05555555555555558, 5);
  });

  test('does not treat internal FX settlement rows as external TWR flows', () => {
    expect(isUserControlledExternalFlow({
      type: 'WITHDRAWAL',
      rawDescription: 'Wdl CHASSGSG 100000003011513 16118(FX) 16272(FX)',
    })).toBe(false);

    expect(isUserControlledExternalFlow({
      type: 'DEPOSIT',
      rawDescription: 'Dep CHASSGSG 100000003011513 16745(FX)',
    })).toBe(false);
  });

  test('treats bank in/out rows as external TWR flows', () => {
    expect(isUserControlledExternalFlow({
      type: 'WITHDRAWAL',
      rawDescription: 'Wdl CHASSGSG 100000003011513 TRANSFER TO NOM AC',
    })).toBe(false);

    expect(isUserControlledExternalFlow({
      type: 'DEPOSIT',
      rawDescription: 'DE: DBSSSGSG 2712310956',
    })).toBe(true);

    expect(isUserControlledExternalFlow({
      type: 'DEPOSIT',
      rawDescription: 'JPMSG:DEPOSIT',
    })).toBe(true);
  });

  test('normalizes clipped DBSSSGSG transfer deposits to the paired withdrawal amount on the same day', () => {
    const rows: Transaction[] = [
      {
        id: 'w-1',
        date: '2026-10-07',
        type: 'WITHDRAWAL',
        symbol: null,
        quantity: null,
        price: null,
        amount: 921.19,
        splitRatio: null,
        rawDescription: 'Wdl CHASSGSG 100000003011513 TRANSFER TO NOM AC',
        source: 'statement.pdf',
      },
      {
        id: 'd-1',
        date: '2026-10-07',
        type: 'DEPOSIT',
        symbol: null,
        quantity: null,
        price: null,
        amount: -21.19,
        splitRatio: null,
        rawDescription: 'DE: DBSSSGSG 2712310956 9',
        source: 'statement.pdf',
      },
    ];

    const normalized = normalizeBankTransferPairsForAnalytics(rows);
    const repairedDeposit = normalized.find((entry) => entry.id === 'd-1');
    expect(repairedDeposit?.amount).toBeCloseTo(921.19, 5);
  });

  test('filters corrupted statement-artifact rows from analytics input', () => {
    const clean = {
      id: 'ok-1',
      date: '2026-01-01',
      type: 'DIVIDEND' as const,
      symbol: 'NVDA',
      quantity: null,
      price: null,
      amount: 1.99,
      splitRatio: null,
      rawDescription: 'JNL4552724 NVDA:US Intl Div Ex:11/03/26',
      source: 'statement.pdf',
    };

    const corrupted = {
      id: 'bad-1',
      date: '2026-01-01',
      type: 'DIVIDEND' as const,
      symbol: 'NVDA',
      quantity: null,
      price: null,
      amount: 2026,
      splitRatio: null,
      rawDescription:
        'JNL4552724 NVDA:US Intl Div Ex:11/03/26 1.99 8.72Cr This statement and its contents are subject to the terms and conditions governing your CMC Invest account',
      source: 'statement.pdf',
    };

    expect(isCorruptedStatementArtifact(corrupted)).toBe(true);
    expect(isCorruptedStatementArtifact(clean)).toBe(false);

    const sanitized = sanitizeTransactionsForAnalytics([clean, corrupted]);
    expect(sanitized).toHaveLength(1);
    expect(sanitized[0]?.id).toBe('ok-1');
  });

  test('keeps valid BUY rows even when footer text is appended by OCR', () => {
    const noisyBuy = {
      id: '33799',
      date: '2025-11-18',
      type: 'BUY' as const,
      symbol: 'HOOD',
      quantity: 22,
      price: 154.2137,
      amount: -3392.7,
      splitRatio: null,
      rawDescription:
        'Bght 22 HOOD:US @ 154.2137 SGD 3,3 This statement and its contents are subject to the terms and conditions governing your CMC Invest account',
      source: 'statement.pdf',
    };

    expect(isCorruptedStatementArtifact(noisyBuy)).toBe(false);

    const sanitized = sanitizeTransactionsForAnalytics([noisyBuy]);
    expect(sanitized).toHaveLength(1);
    expect(sanitized[0]?.id).toBe('33799');
  });

  test('filters internal CHASSGSG settlement rows from analytics input', () => {
    const internalFxSettlement = {
      id: 'fx-1',
      date: '2026-01-10',
      type: 'WITHDRAWAL' as const,
      symbol: null,
      quantity: null,
      price: null,
      amount: -2912.17,
      splitRatio: null,
      rawDescription: 'Wdl CHASSGSG 100000003011513 21343(FX)',
      source: 'statement.pdf',
    };

    const internalDividendSweep = {
      id: 'div-sweep-1',
      date: '2026-01-11',
      type: 'DEPOSIT' as const,
      symbol: null,
      quantity: null,
      price: null,
      amount: 2.88,
      splitRatio: null,
      rawDescription: 'Dep CHASSGSG 100000003011513',
      source: 'statement.pdf',
    };

    const externalBankRow = {
      id: 'bank-1',
      date: '2026-01-12',
      type: 'DEPOSIT' as const,
      symbol: null,
      quantity: null,
      price: null,
      amount: 3000,
      splitRatio: null,
      rawDescription: 'DE: DBSSSGSG 2712310956',
      source: 'statement.pdf',
    };

    expect(isInternalSettlementCashRow(internalFxSettlement)).toBe(true);
    expect(isInternalSettlementCashRow(internalDividendSweep)).toBe(true);
    expect(isInternalSettlementCashRow(externalBankRow)).toBe(false);

    const sanitized = sanitizeTransactionsForAnalytics([
      internalFxSettlement,
      internalDividendSweep,
      externalBankRow,
    ]);

    expect(sanitized).toHaveLength(1);
    expect(sanitized[0]?.id).toBe('bank-1');
  });

  test('keeps total value in USD by converting reconstructed cash before combining with USD holdings', () => {
    const fxPoints = [
      { date: '2026-01-01', price: 1.35 },
      { date: '2026-02-01', price: 1.36 },
    ];

    const point = buildUsdPortfolioPoint('2026-02-01', 1000, 136, fxPoints);

    expect(point.holdingsValue).toBe(1000);
    expect(point.cash).toBeCloseTo(100, 5);
    expect(point.totalValue).toBeCloseTo(1100, 5);
  });

  test('produces a positive return when holdings rise and no true external flow occurs', () => {
    const series = [
      { date: '2026-01-01', totalValue: 1000, holdingsValue: 900, cash: 100 },
      { date: '2026-02-01', totalValue: 1100, holdingsValue: 1000, cash: 100 },
    ];

    const twr = calculateTwrFromSeries(series, []);
    expect(twr).toBeCloseTo(0.1, 5);
  });

  test('computes invested-capital TWR using trade boundaries with BUY as inflow and SELL as outflow', () => {
    const rangeDates = ['2026-01-01', '2026-01-10', '2026-01-20'];
    const anchorState = { holdings: { AAA: 10 }, cash: 0 };
    const priceBySymbolDate = new Map<string, Map<string, number>>([
      ['AAA', new Map([
        ['2026-01-01', 100],
        ['2026-01-10', 120],
        ['2026-01-20', 130],
      ])],
    ]);

    const trades: Transaction[] = [
      {
        id: 'buy-1',
        date: '2026-01-10',
        type: 'BUY',
        symbol: 'AAA',
        quantity: 1,
        price: 120,
        amount: -120,
        splitRatio: null,
        source: 'test',
      },
      {
        id: 'sell-1',
        date: '2026-01-20',
        type: 'SELL',
        symbol: 'AAA',
        quantity: 2,
        price: 130,
        amount: 260,
        splitRatio: null,
        source: 'test',
      },
    ];

    const fxPoints = [
      { date: '2026-01-01', price: 1.35 },
      { date: '2026-01-10', price: 1.35 },
      { date: '2026-01-20', price: 1.35 },
    ];

    const result = calculateInvestedCapitalTwrFromTradeBoundaries(
      rangeDates,
      anchorState,
      trades,
      priceBySymbolDate,
      fxPoints,
    );

    // Subperiod returns:
    // r1 = (1200 - 1000) / 1000 = 0.20
    // baseline after buy = 1200 + (120/1.35)
    // ending before sell = 11 * 130 = 1430
    // r2 = (1430 - baseline) / baseline
    // final after sell baseline then no further price change => r3 = 0
    const buyUsd = 120 / 1.35;
    const baseline2 = 1200 + buyUsd;
    const r2 = (1430 - baseline2) / baseline2;
    const expected = (1 + 0.2) * (1 + r2) - 1;

    expect(result.twr).toBeCloseTo(expected, 5);
    expect(result.flows).toHaveLength(2);
    expect(result.flows[0]?.amount).toBeCloseTo(buyUsd, 5);
    expect(result.flows[1]?.amount).toBeCloseTo(-260 / 1.35, 5);
  });

  test('invested-capital trade-boundary TWR equals holdings return when there are no trades', () => {
    const rangeDates = ['2026-01-01', '2026-01-10'];
    const anchorState = { holdings: { AAA: 10 }, cash: 0 };
    const priceBySymbolDate = new Map<string, Map<string, number>>([
      ['AAA', new Map([
        ['2026-01-01', 100],
        ['2026-01-10', 110],
      ])],
    ]);

    const result = calculateInvestedCapitalTwrFromTradeBoundaries(
      rangeDates,
      anchorState,
      [],
      priceBySymbolDate,
      [],
    );

    expect(result.twr).toBeCloseTo(0.1, 5);
    expect(result.flows).toHaveLength(0);
  });

  test('computes realized gains within timeframe for symbols opened and closed inside range', () => {
    const txs: Transaction[] = [
      {
        id: 'buy-1',
        date: '2026-08-21',
        type: 'BUY',
        symbol: 'META270615C00620000',
        quantity: 1,
        price: 83.8192,
        amount: -8381.92,
        splitRatio: null,
        source: 'manual-ui:auto-open',
      },
      {
        id: 'sell-1',
        date: '2026-09-22',
        type: 'SELL',
        symbol: 'META270615C00620000',
        quantity: 1,
        price: 241.8306,
        amount: 24183.06,
        splitRatio: null,
        source: 'manual-ui:auto-close',
      },
    ];

    const fxPoints = [
      { date: '2026-08-21', price: 1.35 },
      { date: '2026-09-22', price: 1.35 },
    ];

    const realized = computeRealizedGainsForRange(txs, '2026-08-01', '2026-10-01', fxPoints);
    expect(realized.META270615C00620000).toBeCloseTo((24183.06 / 1.35) - (8381.92 / 1.35), 5);
  });
});

describe('cash accounting', () => {
  test('reduces cash for a buy even when the raw trade amount is negative', () => {
    const state = { holdings: { AAPL: 2 }, cash: 1000 };
    applyTransaction(state, {
      id: 'buy-1',
      date: '2026-01-15',
      type: 'BUY',
      symbol: 'AAPL',
      quantity: 2,
      price: 100,
      amount: -200,
      splitRatio: null,
      source: 'test',
    });

    expect(state.cash).toBe(800);
  });

  test('builds manual equity and option transactions with the correct cash sign and contract metadata', () => {
    const equityTrade = buildManualTransaction({
      date: '2025-02-03',
      type: 'BUY',
      instrumentType: 'EQUITY',
      symbol: 'MSFT',
      quantity: 10,
      price: 225.5,
      source: 'manual-ui',
    });

    const optionTrade = buildManualTransaction({
      date: '2025-02-03',
      type: 'BUY',
      instrumentType: 'OPTION',
      optionType: 'CALL',
      underlyingSymbol: 'MSFT',
      symbol: 'MSFT250220C00225000',
      strikePrice: 225,
      expiryDate: '2025-02-20',
      quantity: 2,
      price: 4.2,
      ownershipShare: 0.5,
      source: 'manual-ui',
    });

    expect(equityTrade.amount).toBe(-2255);
    expect(equityTrade.type).toBe('BUY');
    expect(equityTrade.symbol).toBe('MSFT');

    expect(optionTrade.amount).toBe(-420);
    expect(optionTrade.type).toBe('BUY');
    expect(optionTrade.symbol).toBe('MSFT250220C00225000');
    expect(optionTrade.quantity).toBe(1);
    expect(optionTrade.optionType).toBe('CALL');
    expect(optionTrade.strikePrice).toBe(225);
    expect(optionTrade.expiryDate).toBe('2025-02-20');
    expect(optionTrade.contractMultiplier).toBe(100);
    expect(optionTrade.ownershipShare).toBe(0.5);
  });

  test('derives the standard Yahoo option ticker from the contract details', () => {
    expect(buildOptionContractSymbol('MSFT', '2025-02-20', 225, 'CALL')).toBe('MSFT250220C00225000');
    expect(buildOptionContractSymbol('AAPL', '2026-01-15', 210, 'PUT')).toBe('AAPL260115P00210000');
  });

  test('builds a linear manual option valuation series using contract notional prices', () => {
    const tx = buildManualTransaction({
      date: '2026-01-02',
      type: 'BUY',
      instrumentType: 'OPTION',
      underlyingSymbol: 'TSLA',
      optionType: 'CALL',
      strikePrice: 300,
      expiryDate: '2026-02-20',
      quantity: 1,
      price: 2,
      contractMultiplier: 100,
      valuationMethod: 'LINEAR',
      valuationStartDate: '2026-01-02',
      valuationStartPrice: 2,
      valuationEndDate: '2026-01-04',
      valuationEndPrice: 4,
      source: 'manual-ui',
    });

    const result = buildManualLinearOptionSeries([tx], '2026-01-01', '2026-01-05');
    const series = result.series[tx.symbol ?? ''];

    expect(series).toBeDefined();
    expect(series).toEqual([
      { date: '2026-01-02', price: 200 },
      { date: '2026-01-03', price: 300 },
      { date: '2026-01-04', price: 400 },
    ]);
  });

  test('builds a linear manual option valuation series from booked amounts', () => {
    const tx = buildManualTransaction({
      date: '2026-01-02',
      type: 'BUY',
      instrumentType: 'OPTION',
      underlyingSymbol: 'TSLA',
      optionType: 'CALL',
      strikePrice: 300,
      expiryDate: '2026-02-20',
      quantity: 2,
      price: 1.5,
      contractMultiplier: 100,
      valuationMethod: 'LINEAR',
      valuationStartDate: '2026-01-02',
      valuationStartAmount: 300,
      valuationEndDate: '2026-01-04',
      valuationEndAmount: 500,
      source: 'manual-ui',
    });

    const result = buildManualLinearOptionSeries([tx], '2026-01-01', '2026-01-05');
    const series = result.series[tx.symbol ?? ''];

    expect(series).toBeDefined();
    expect(series).toEqual([
      { date: '2026-01-02', price: 150 },
      { date: '2026-01-03', price: 200 },
      { date: '2026-01-04', price: 250 },
    ]);
  });

  test('applies ownership share correctly for amount-based linear valuation inputs', () => {
    const tx = buildManualTransaction({
      date: '2026-10-22',
      type: 'BUY',
      instrumentType: 'OPTION',
      underlyingSymbol: 'NFLX',
      optionType: 'CALL',
      strikePrice: 89,
      expiryDate: '2026-08-15',
      quantity: 1,
      price: 0,
      contractMultiplier: 100,
      ownershipShare: 0.333,
      valuationMethod: 'LINEAR',
      valuationStartDate: '2026-01-15',
      valuationStartAmount: 7938.85,
      valuationEndDate: '2026-04-13',
      valuationEndAmount: 11469.31,
      source: 'manual-ui',
    });

    expect(tx.quantity).toBeCloseTo(0.333, 10);
    expect(tx.valuationStartPrice).toBeCloseTo(79.3885, 6);
    expect(tx.valuationEndPrice).toBeCloseTo(114.6931, 6);
  });

  test('derives auto-close transactions for manual linear option positions at valuation end date', () => {
    const tx = buildManualTransaction({
      date: '2026-01-02',
      type: 'BUY',
      instrumentType: 'OPTION',
      underlyingSymbol: 'META',
      optionType: 'CALL',
      strikePrice: 500,
      expiryDate: '2026-03-20',
      quantity: 1,
      price: 2,
      contractMultiplier: 100,
      ownershipShare: 1,
      valuationMethod: 'LINEAR',
      valuationStartDate: '2026-01-02',
      valuationStartAmount: 200,
      valuationEndDate: '2026-01-04',
      valuationEndAmount: 350,
      source: 'manual-ui',
    });

    const derived = deriveManualOptionCloseTransactions([tx], '2026-01-10');
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({
      type: 'SELL',
      symbol: tx.symbol,
      date: '2026-01-04',
      quantity: 1,
      price: 3.5,
      amount: 350,
    });

    const reconstructed = reconstructState(null, sortTransactions([tx, ...derived]));
    expect(reconstructed.holdings[tx.symbol ?? '']).toBeCloseTo(0, 10);
  });
});

describe('reconciliation', () => {
  test('flags a match when reconstructed state matches the new baseline', () => {
    const previousBaseline = {
      id: 'baseline-a',
      date: '2025-01-01',
      holdings: { AMZN: 10 },
      cash: 100,
      source: 'baseline-a.pdf',
    };

    const newBaseline = {
      id: 'baseline-b',
      date: '2025-01-10',
      holdings: { AMZN: 10 },
      cash: 125,
      source: 'baseline-b.pdf',
    };

    const txs: Transaction[] = [
      {
        id: 't-1',
        date: '2025-01-02',
        type: 'DIVIDEND',
        symbol: 'AMZN',
        quantity: null,
        price: null,
        amount: 5,
        splitRatio: null,
        source: 'Statement-xyz.pdf',
      },
      {
        id: 't-2',
        date: '2025-01-05',
        type: 'DEPOSIT',
        symbol: null,
        quantity: null,
        price: null,
        amount: 20,
        splitRatio: null,
        source: 'Statement-xyz.pdf',
      },
    ];

    const result = reconcileBaseline(previousBaseline, newBaseline, txs);

    expect(result.status).toBe('MATCH');
    expect(result.cashDiff).toBe(0);
    expect(result.holdingDiffs).toHaveLength(0);
  });
});

describe('sample PDF parsing integration', () => {
  const baselinePdf = path.resolve(__dirname, '../../samples/PortfolioReport-010125.pdf');
  const statementPdf = path.resolve(__dirname, '../../samples/Statement-010125-211026.pdf');

  const baselineText = extractPdfTextOrSkip(baselinePdf);
  const statementText = extractPdfTextOrSkip(statementPdf);

  const integrationTest = baselineText && statementText ? test : test.skip;

  integrationTest('parses sample baseline and statement PDFs end-to-end and reconstructs expected quantities', () => {
    const baselineResult = parseBaselineText(baselineText ?? '', 'PortfolioReport-010125.pdf');
    const txResult = parseTransactionText(statementText ?? '', 'Statement-010125-211026.pdf');

    expect(baselineResult.ok).toBe(true);
    expect(baselineResult.baseline?.date).toBe('2025-01-01');
    expect(baselineResult.baseline?.cash).toBeCloseTo(207.3, 2);
    expect(baselineResult.baseline?.holdings?.NVDA).toBe(193);
    expect(baselineResult.baseline?.holdings?.GOOGL).toBe(54);

    expect(txResult.errors).toHaveLength(0);
    expect(txResult.accepted.some((tx) => tx.id === '16118' && tx.type === 'BUY' && tx.symbol === 'NVDA' && tx.quantity === 15)).toBe(true);
    expect(txResult.accepted.some((tx) => tx.id === '16272' && tx.type === 'BUY' && tx.symbol === 'NVDA' && tx.quantity === 14)).toBe(true);
    expect(txResult.accepted.some((tx) => tx.id === '24515' && tx.type === 'BUY' && tx.symbol === 'GOOGL' && tx.quantity === 9)).toBe(true);
    expect(txResult.accepted.some((tx) => tx.id === '29415' && tx.type === 'BUY' && tx.symbol === 'GOOGL' && tx.quantity === 10)).toBe(true);
    expect(txResult.accepted.some((tx) => tx.id === '29967' && tx.type === 'BUY' && tx.symbol === 'GOOGL' && tx.quantity === 15)).toBe(true);

    const reconstructed = reconstructState(baselineResult.baseline ?? null, txResult.accepted);
    expect(reconstructed.holdings.NVDA).toBe(222);
    expect(reconstructed.holdings.GOOGL).toBe(124);
  });

  integrationTest('preserves the full SGD amount for large stock buys in statement rows', () => {
    const txResult = parseTransactionText(statementText ?? '', 'Statement-010125-211026.pdf');
    const metaBuy = txResult.accepted.find((tx) => tx.id === '34151');

    expect(metaBuy).toBeDefined();
    expect(metaBuy?.type).toBe('BUY');
    expect(metaBuy?.symbol).toBe('META');
    expect(metaBuy?.quantity).toBe(6);
    expect(metaBuy?.amount).toBe(-4717.59);
    expect(metaBuy?.rawDescription).toContain('Bght 6 META:US @ 786.2644 SGD');
    expect(metaBuy?.rawDescription).not.toContain('Bght 6 META:US @ 786.2644 SGD 4,7');
  });
});
