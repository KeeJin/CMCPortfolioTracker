import { reconcileBaseline } from "../src/reconciliation";
import type { Baseline, NormalizedTransaction } from "../src/models/index";

describe("reconcileBaseline", () => {
  const baselineA: Baseline = {
    id: "b-a",
    date: "2026-01-01",
    holdings: { AMZN: 10 },
    cash: 1000,
    source: "baseline-a",
  };

  const transactions: NormalizedTransaction[] = [
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
  ];

  it("returns MATCH for a perfect match baseline", () => {
    const baselineB: Baseline = {
      id: "b-b",
      date: "2026-01-04",
      holdings: { AMZN: 8 },
      cash: 1350,
      source: "baseline-b",
    };

    const result = reconcileBaseline(baselineA, baselineB, transactions);

    expect(result.status).toBe("MATCH");
    expect(result.holdingDiffs).toEqual([]);
    expect(result.cashDiff).toBe(0);
    expect(result.baselineDate).toBe("2026-01-04");
  });

  it("returns MINOR_MISMATCH for small differences", () => {
    const baselineB: Baseline = {
      id: "b-b",
      date: "2026-01-04",
      holdings: { AMZN: 9 },
      cash: 1350.5,
      source: "baseline-b",
    };

    const result = reconcileBaseline(baselineA, baselineB, transactions);

    expect(result.status).toBe("MINOR_MISMATCH");
    expect(result.holdingDiffs).toEqual([
      {
        symbol: "AMZN",
        expected: 8,
        actual: 9,
        difference: 1,
      },
    ]);
    expect(result.cashDiff).toBe(0.5);
    expect(result.notes).toContain(
      "Minor discrepancy detected. Likely due to rounding or missing small transactions."
    );
  });

  it("returns MAJOR_MISMATCH for large differences", () => {
    const baselineB: Baseline = {
      id: "b-b",
      date: "2026-01-04",
      holdings: { AMZN: 12 },
      cash: 1365,
      source: "baseline-b",
    };

    const result = reconcileBaseline(baselineA, baselineB, transactions);

    expect(result.status).toBe("MAJOR_MISMATCH");
    expect(result.holdingDiffs).toEqual([
      {
        symbol: "AMZN",
        expected: 8,
        actual: 12,
        difference: 4,
      },
    ]);
    expect(result.cashDiff).toBe(15);
  });
});
