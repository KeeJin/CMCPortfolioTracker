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
      source: "x",
    };

    const updated = applyTransaction(state, tx);

    expect(updated.holdings.AMZN).toBeUndefined();
    expect(updated.cash).toBe(200);
    expect(updated.date).toBe("2026-01-02");
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
        source: "s",
      },
      // Duplicate id (must be ignored)
      {
        id: "tx-buy",
        date: "2026-01-05",
        type: "BUY",
        symbol: "AMZN",
        quantity: 100,
        price: 1,
        amount: -100,
        source: "duplicate",
      },
    ];

    const result = reconstructState(baseline, transactions);

    expect(result).toEqual(expected);
  });
});
