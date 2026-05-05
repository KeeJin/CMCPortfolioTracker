import {
  buildMarketSplitTransactions,
  collectTrackedSymbols,
  mergeMarketSplitTransactions,
} from "../src/marketSplits";
import type { Baseline, NormalizedTransaction } from "../src/models";

describe("market split helpers", () => {
  test("collectTrackedSymbols includes baseline and transaction symbols once", () => {
    const baseline: Baseline = {
      id: "baseline-1",
      date: "2025-01-01",
      holdings: { vgt: 10, NVDA: 5 },
      holdingPrices: {},
      cash: 0,
      source: "test",
    };

    const transactions: NormalizedTransaction[] = [
      {
        id: "1",
        date: "2025-02-01",
        type: "BUY",
        symbol: "VGT",
        quantity: 2,
        price: 1,
        amount: -2,
        splitRatio: null,
        source: "test",
      },
      {
        id: "2",
        date: "2025-02-02",
        type: "BUY",
        symbol: "msft",
        quantity: 1,
        price: 1,
        amount: -1,
        splitRatio: null,
        source: "test",
      },
    ];

    expect(collectTrackedSymbols(baseline, transactions)).toEqual(["MSFT", "NVDA", "VGT"]);
  });

  test("mergeMarketSplitTransactions avoids duplicating an existing split", () => {
    const transactions: NormalizedTransaction[] = [
      {
        id: "statement-split",
        date: "2026-04-21",
        type: "SPLIT",
        symbol: "VGT",
        quantity: null,
        price: null,
        amount: 0,
        splitRatio: 8,
        source: "statement",
      },
    ];

    const merged = mergeMarketSplitTransactions(transactions, [
      { symbol: "VGT", date: "2026-04-21", splitRatio: 8 },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("statement-split");
  });

  test("buildMarketSplitTransactions deduplicates duplicate market events", () => {
    const transactions = buildMarketSplitTransactions([
      { symbol: "VGT", date: "2026-04-21", splitRatio: 8 },
      { symbol: "vgt", date: "2026-04-21", splitRatio: 8 },
    ]);

    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.symbol).toBe("VGT");
    expect(transactions[0]?.type).toBe("SPLIT");
  });
});