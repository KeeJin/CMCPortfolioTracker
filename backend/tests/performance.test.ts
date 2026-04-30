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

    expect(series.map((p) => p.date)).toEqual(["2025-01-01", "2025-01-10"]);
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

    expect(result.series).toEqual([
      { date: "2025-01-01", holdingsValue: 1000, cash: 0, totalValue: 1000 },
      { date: "2026-01-01", holdingsValue: 1200, cash: 0, totalValue: 1200 },
    ]);

    expect(result.twr).toBeCloseTo(0.2, 6);
    expect(result.irr).toBeDefined();
    expect(result.irr!).toBeCloseTo(0.2, 6);

    const diff = Math.abs((result.twr ?? 0) - (result.irr ?? 0));
    expect(diff).toBeLessThan(1e-4);
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
    expect(series).toEqual([
      { date: "2025-01-01", holdingsValue: 1000, cash: 0, totalValue: 1000 },
      { date: "2025-07-01", holdingsValue: 1200, cash: 1000, totalValue: 2200 },
      { date: "2026-01-01", holdingsValue: 1200, cash: 1000, totalValue: 2200 },
    ]);

    const result = calculatePerformance(baseline, transactions, prices);

    expect(result.twr).toBeDefined();
    expect(result.irr).toBeDefined();

    // TWR captures pure portfolio performance (20% first period, 0% second period).
    expect(result.twr!).toBeCloseTo(0.2, 6);

    // IRR includes timing and size of external cash flow, so it diverges from TWR.
    const diff = Math.abs(result.twr! - result.irr!);
    expect(diff).toBeGreaterThan(0.03);
  });
});
