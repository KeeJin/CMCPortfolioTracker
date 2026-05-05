import {
  buildPortfolioValueSeries,
  calculatePerformance,
  type PriceHistory,
} from "../src/performance";
import type { Baseline, NormalizedTransaction } from "../src/models/index";

describe("performance calculations", () => {
  it("does not emit pre-baseline series points", () => {
    const baseline: Baseline = {
      id: "b0",
      date: "2025-01-01",
      holdings: { AMZN: 10 },
      cash: 0,
      source: "baseline",
    };

    const transactions: NormalizedTransaction[] = [];

    const prices: PriceHistory = {
      AMZN: [
        { date: "2024-12-20", price: 90 },
        { date: "2025-01-01", price: 100 },
        { date: "2025-01-10", price: 105 },
      ],
    };

    const series = buildPortfolioValueSeries(baseline, transactions, prices);

    expect(series[0]?.date).toBe("2025-01-01");
    expect(series.some((p) => p.date < "2025-01-01")).toBe(false);
    expect(series.some((p) => p.date === "2025-01-10")).toBe(true);
  });

  it("no deposits: TWR is approximately IRR", () => {
    const baseline: Baseline = {
      id: "b1",
      date: "2025-01-01",
      holdings: { AMZN: 10 },
      cash: 0,
      source: "baseline",
    };

    const transactions: NormalizedTransaction[] = [];

    const prices: PriceHistory = {
      AMZN: [
        { date: "2025-01-01", price: 100 },
        { date: "2026-01-01", price: 120 },
      ],
    };

    const result = calculatePerformance(baseline, transactions, prices);

    expect(result.series[0]).toEqual({
      date: "2025-01-01",
      holdingsValue: 1000,
      totalValue: 1000,
    });

    const oneYearPoint = result.series.find((p) => p.date === "2026-01-01");
    expect(oneYearPoint).toEqual({
      date: "2026-01-01",
      holdingsValue: 1200,
      totalValue: 1200,
    });

    const today = new Date().toISOString().slice(0, 10);
    expect(result.series[result.series.length - 1]?.date).toBe(today);
    expect(result.series[result.series.length - 1]?.totalValue).toBe(1200);

    expect(result.twr).toBeCloseTo(0.2, 6);
    expect(result.irr).toBeDefined();

    const startMs = new Date("2025-01-01T00:00:00.000Z").getTime();
    const endMs = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`).getTime();
    const elapsedDays = (endMs - startMs) / (1000 * 60 * 60 * 24);
    const expectedIrr = Math.pow(1.2, 365 / elapsedDays) - 1;
    expect(result.irr!).toBeCloseTo(expectedIrr, 6);
  });

  it("with deposits: TWR and IRR diverge", () => {
    const baseline: Baseline = {
      id: "b2",
      date: "2025-01-01",
      holdings: { AMZN: 10 },
      cash: 0,
      source: "baseline",
    };

    const transactions: NormalizedTransaction[] = [
      {
        id: "dep-1",
        date: "2025-07-01",
        type: "DEPOSIT",
        symbol: null,
        quantity: null,
        price: null,
        amount: 1000,
        source: "mock",
      },
    ];

    const prices: PriceHistory = {
      AMZN: [
        { date: "2025-01-01", price: 100 },
        { date: "2025-07-01", price: 120 },
        { date: "2026-01-01", price: 120 },
      ],
    };

    const series = buildPortfolioValueSeries(baseline, transactions, prices);
    expect(series[0]).toEqual({
      date: "2025-01-01",
      holdingsValue: 1000,
      totalValue: 1000,
    });
    expect(series.find((p) => p.date === "2025-07-01")).toEqual({
      date: "2025-07-01",
      holdingsValue: 1200,
      totalValue: 1200,
    });
    expect(series.find((p) => p.date === "2026-01-01")).toEqual({
      date: "2026-01-01",
      holdingsValue: 1200,
      totalValue: 1200,
    });

    const result = calculatePerformance(baseline, transactions, prices);

    expect(result.twr).toBeDefined();
    expect(result.irr).toBeDefined();

    // In stock-only mode, deposits are external cash flows that do not raise
    // portfolio value directly (cash is excluded from valuation).
    expect(result.twr!).toBeCloseTo(-0.8, 6);

    // IRR includes timing and size of external cash flow, so it diverges from TWR.
    const diff = Math.abs(result.twr! - result.irr!);
    expect(diff).toBeGreaterThan(0.03);
  });
});
