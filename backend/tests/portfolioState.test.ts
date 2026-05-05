import { findPreviousBaseline, getPortfolioAnchor } from "../src/portfolioState";
import type { Baseline, NormalizedTransaction } from "../src/models/index";

describe("getPortfolioAnchor", () => {
  it("falls back to a synthetic transactions-only anchor when no baselines exist", () => {
    const transactions: NormalizedTransaction[] = [
      {
        id: "tx-1",
        date: "2026-01-02",
        type: "DEPOSIT",
        symbol: null,
        quantity: null,
        price: null,
        amount: 1000,
        source: "seed",
      },
    ];

    const anchor = getPortfolioAnchor([], transactions);

    expect(anchor).not.toBeNull();
    expect(anchor?.anchorType).toBe("TRANSACTIONS_ONLY");
    expect(anchor?.baseline.date).toBe("2026-01-01");
    expect(anchor?.transactionsToApply).toEqual(transactions);
  });

  it("uses the latest baseline by date and applies only later transactions", () => {
    const baselines: Baseline[] = [
      {
        id: "b1",
        date: "2026-01-01",
        holdings: { AMZN: 1 },
        cash: 100,
        source: "b1",
      },
      {
        id: "b2",
        date: "2026-02-01",
        holdings: { AMZN: 3 },
        cash: 80,
        source: "b2",
      },
    ];

    const transactions: NormalizedTransaction[] = [
      {
        id: "tx-before",
        date: "2026-01-10",
        type: "BUY",
        symbol: "AMZN",
        quantity: 1,
        price: 10,
        amount: -10,
        source: "seed",
      },
      {
        id: "tx-after",
        date: "2026-02-10",
        type: "DIVIDEND",
        symbol: "AMZN",
        quantity: null,
        price: null,
        amount: 5,
        source: "seed",
      },
    ];

    const anchor = getPortfolioAnchor(baselines, transactions);

    expect(anchor?.anchorType).toBe("BASELINE");
    expect(anchor?.baseline.id).toBe("b2");
    expect(anchor?.transactionsToApply.map((tx) => tx.id)).toEqual(["tx-after"]);
  });

  it("can infer an earlier baseline from known pre-baseline transactions when enabled", () => {
    const baselines: Baseline[] = [
      {
        id: "b1",
        date: "2026-02-01",
        holdings: { AMZN: 3 },
        cash: 80,
        source: "b1",
      },
    ];

    const transactions: NormalizedTransaction[] = [
      {
        id: "tx-before",
        date: "2026-01-10",
        type: "BUY",
        symbol: "AMZN",
        quantity: 1,
        price: 10,
        amount: -10,
        splitRatio: null,
        source: "seed",
      },
      {
        id: "tx-after",
        date: "2026-02-10",
        type: "DIVIDEND",
        symbol: "AMZN",
        quantity: null,
        price: null,
        amount: 5,
        splitRatio: null,
        source: "seed",
      },
    ];

    const anchor = getPortfolioAnchor(baselines, transactions, {
      includePreBaselineEstimates: true,
    });

    expect(anchor?.anchorType).toBe("BASELINE");
    expect(anchor?.estimation?.enabled).toBe(true);
    expect(anchor?.estimation?.originalBaselineDate).toBe("2026-02-01");
    expect(anchor?.estimation?.inferredBaselineDate).toBe("2026-01-09");
    expect(anchor?.baseline.holdings.AMZN).toBe(2);
    expect(anchor?.baseline.cash).toBe(90);
    expect(anchor?.transactionsToApply.map((tx) => tx.id)).toEqual(["tx-before", "tx-after"]);
  });

  it("keeps baseline anchor unchanged when estimation is enabled but no pre-baseline transactions exist", () => {
    const baselines: Baseline[] = [
      {
        id: "b1",
        date: "2026-02-01",
        holdings: { AMZN: 3 },
        cash: 80,
        source: "b1",
      },
    ];

    const transactions: NormalizedTransaction[] = [
      {
        id: "tx-after",
        date: "2026-02-10",
        type: "DIVIDEND",
        symbol: "AMZN",
        quantity: null,
        price: null,
        amount: 5,
        splitRatio: null,
        source: "seed",
      },
    ];

    const anchor = getPortfolioAnchor(baselines, transactions, {
      includePreBaselineEstimates: true,
    });

    expect(anchor?.baseline.id).toBe("b1");
    expect(anchor?.estimation).toBeUndefined();
    expect(anchor?.transactionsToApply.map((tx) => tx.id)).toEqual(["tx-after"]);
  });
});

describe("findPreviousBaseline", () => {
  it("finds the nearest earlier baseline regardless of upload order", () => {
    const baselines: Baseline[] = [
      {
        id: "b3",
        date: "2026-03-01",
        holdings: {},
        cash: 0,
        source: "b3",
      },
      {
        id: "b1",
        date: "2026-01-01",
        holdings: {},
        cash: 0,
        source: "b1",
      },
      {
        id: "b2",
        date: "2026-02-01",
        holdings: {},
        cash: 0,
        source: "b2",
      },
    ];

    const target: Baseline = {
      id: "b4",
      date: "2026-02-15",
      holdings: {},
      cash: 0,
      source: "b4",
    };

    expect(findPreviousBaseline(baselines, target)?.id).toBe("b2");
  });
});