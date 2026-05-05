import { applyTransaction, reconstructState } from "../src/reconstruction";
import type { Baseline, NormalizedTransaction, PortfolioState } from "../src/models/index";

describe("applyTransaction", () => {
  it("applies BUY by increasing holdings and reducing cash", () => {
    const state: PortfolioState = {
      date: "2026-01-01",
      holdings: { AMZN: 10 },
      cash: 1000,
    };

    const tx: NormalizedTransaction = {
      id: "t1",
      date: "2026-01-02",
      type: "BUY",
      symbol: "AMZN",
      quantity: 2,
      price: 100,
      amount: -200,
      splitRatio: null,
      source: "x",
    };

    const updated = applyTransaction(state, tx);

    expect(updated.holdings.AMZN).toBe(12);
    expect(updated.cash).toBe(800);
    expect(updated.date).toBe("2026-01-02");
  });

  it("applies SELL and removes symbol when quantity reaches zero", () => {
    const state: PortfolioState = {
      date: "2026-01-01",
      holdings: { AMZN: 2 },
      cash: 0,
    };

    const tx: NormalizedTransaction = {
      id: "t2",
      date: "2026-01-02",
      type: "SELL",
      symbol: "AMZN",
      quantity: 2,
      price: 100,
      amount: 200,
      splitRatio: null,
      source: "x",
    };

    const updated = applyTransaction(state, tx);

    expect(updated.holdings.AMZN).toBeUndefined();
    expect(updated.cash).toBe(200);
    expect(updated.date).toBe("2026-01-02");
  });

  it("applies SPLIT by multiplying holdings by the ratio", () => {
    const state: PortfolioState = {
      date: "2026-01-01",
      holdings: { AMZN: 10 },
      cash: 1000,
    };

    const tx: NormalizedTransaction = {
      id: "split1",
      date: "2026-01-02",
      type: "SPLIT",
      symbol: "AMZN",
      quantity: null,
      price: null,
      amount: 0,
      splitRatio: 20,
      source: "x",
    };

    const updated = applyTransaction(state, tx);

    expect(updated.holdings.AMZN).toBe(200);
    expect(updated.cash).toBe(1000);
    expect(updated.date).toBe("2026-01-02");
  });

  it("applies SPLIT with fractional ratio (reverse split)", () => {
    const state: PortfolioState = {
      date: "2026-01-01",
      holdings: { AMZN: 1000 },
      cash: 5000,
    };

    const tx: NormalizedTransaction = {
      id: "split2",
      date: "2026-01-02",
      type: "SPLIT",
      symbol: "AMZN",
      quantity: null,
      price: null,
      amount: 0,
      splitRatio: 0.1,
      source: "x",
    };

    const updated = applyTransaction(state, tx);

    expect(updated.holdings.AMZN).toBe(100);
    expect(updated.cash).toBe(5000);
    expect(updated.date).toBe("2026-01-02");
  });

  it("ignores SPLIT if symbol not held", () => {
    const state: PortfolioState = {
      date: "2026-01-01",
      holdings: {},
      cash: 1000,
    };

    const tx: NormalizedTransaction = {
      id: "split3",
      date: "2026-01-02",
      type: "SPLIT",
      symbol: "AMZN",
      quantity: null,
      price: null,
      amount: 0,
      splitRatio: 20,
      source: "x",
    };

    const updated = applyTransaction(state, tx);

    expect(updated.holdings.AMZN).toBeUndefined();
    expect(updated.cash).toBe(1000);
    expect(updated.date).toBe("2026-01-01");
  });
});

describe("reconstructState", () => {
  it("deduplicates by id, sorts by date, and matches manual calculation", () => {
    const baseline: Baseline = {
      id: "b1",
      date: "2026-01-01",
      holdings: { AMZN: 10 },
      cash: 1000,
      source: "baseline",
    };

    // Manual expected calculation (dedup + date sort):
    // Start: AMZN 10, cash 1000
    // 2026-01-02 BUY 3 AMZN amount -300  => AMZN 13, cash 700
    // 2026-01-03 DIVIDEND +50            => AMZN 13, cash 750
    // 2026-01-04 SELL 5 AMZN amount +600 => AMZN 8,  cash 1350
    const expected: PortfolioState = {
      date: "2026-01-04",
      holdings: { AMZN: 8 },
      cash: 1350,
    };

    const transactions: NormalizedTransaction[] = [
      {
        id: "tx-sell",
        date: "2026-01-04",
        type: "SELL",
        symbol: "AMZN",
        quantity: 5,
        price: 120,
        amount: 600,
        splitRatio: null,
        source: "s",
      },
      {
        id: "tx-buy",
        date: "2026-01-02",
        type: "BUY",
        symbol: "AMZN",
        quantity: 3,
        price: 100,
        amount: -300,
        splitRatio: null,
        source: "s",
      },
      {
        id: "tx-div",
        date: "2026-01-03",
        type: "DIVIDEND",
        symbol: "AMZN",
        quantity: null,
        price: null,
        amount: 50,
        splitRatio: null,
        source: "s",
      },
      {
        id: "tx-buy",
        date: "2026-01-02",
        type: "BUY",
        symbol: "AMZN",
        quantity: 999,
        price: 1,
        amount: -999,
        splitRatio: null,
        source: "duplicate-should-be-ignored",
      },
    ];

    const result = reconstructState(baseline, transactions);

    expect(result).toEqual(expected);
  });
});

describe("reconstructState with SPLIT", () => {
  it("applies SPLIT in transaction sequence", () => {
    const baseline: Baseline = {
      id: "b1",
      date: "2026-01-01",
      holdings: { AMZN: 10 },
      cash: 10000,
    };

    const transactions: NormalizedTransaction[] = [
      {
        id: "buy1",
        date: "2026-01-05",
        type: "BUY",
        symbol: "AMZN",
        quantity: 5,
        price: 150,
        amount: -750,
        splitRatio: null,
        source: "s",
      },
      {
        id: "split1",
        date: "2026-01-10",
        type: "SPLIT",
        symbol: "AMZN",
        quantity: null,
        price: null,
        amount: 0,
        splitRatio: 20,
        source: "s",
      },
      {
        id: "sell1",
        date: "2026-01-15",
        type: "SELL",
        symbol: "AMZN",
        quantity: 100,
        price: 7.5,
        amount: 750,
        splitRatio: null,
        source: "s",
      },
    ];

    const result = reconstructState(baseline, transactions);

    expect(result.holdings.AMZN).toBe(200);
    expect(result.cash).toBe(10000);
    expect(result.date).toBe("2026-01-15");
  });
});
