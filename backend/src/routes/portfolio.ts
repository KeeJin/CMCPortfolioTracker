import { Router } from "express";
import { getAllTransactions, getBaseline } from "../store.js";
import { reconstructState } from "../reconstruction.js";
import type { NormalizedTransaction } from "../models/index.js";
import { calculatePerformance, type PriceHistory } from "../performance.js";
import { type PricingMethod } from "../pricing.js";

const ACTIVE_PRICING_METHOD: PricingMethod = "transaction_forward_fill";

const router = Router();

function getReconstructedFromLatestBaseline() {
  const baseline = getBaseline();
  if (!baseline) {
    return { ok: false as const, error: "No baseline stored" };
  }

  const allTransactions = getAllTransactions();

  // Baseline is authoritative at baseline.date.
  // Only transactions strictly after baseline date should be applied on top.
  const postBaselineTransactions: NormalizedTransaction[] = [];
  for (const tx of allTransactions) {
    if (tx.date > baseline.date) {
      postBaselineTransactions.push(tx);
    }
  }

  const state = reconstructState(baseline, postBaselineTransactions);

  return {
    ok: true as const,
    baseline,
    transactionsApplied: postBaselineTransactions.length,
    postBaselineTransactions,
    state,
    allTransactions,
  };
}

// GET /api/portfolio
// Returns reconstructed portfolio state from latest baseline + post-baseline transactions.
router.get("/", (_req, res) => {
  const reconstructed = getReconstructedFromLatestBaseline();

  if (!reconstructed.ok) {
    res.status(404).json({ error: reconstructed.error });
    return;
  }

  const negativeHoldings: Array<{ symbol: string; quantity: number }> = [];
  for (const [symbol, quantity] of Object.entries(reconstructed.state.holdings)) {
    if (quantity < 0) {
      negativeHoldings.push({ symbol, quantity });
    }
  }

  res.status(200).json({
    baselineDate: reconstructed.baseline.date,
    transactionsApplied: reconstructed.transactionsApplied,
    state: reconstructed.state,
    warnings:
      negativeHoldings.length > 0
        ? [
            {
              type: "NEGATIVE_HOLDINGS",
              details: negativeHoldings,
            },
          ]
        : undefined,
  });
});

// GET /api/portfolio/value
// Uses reconstructed state and transaction-derived price history to return
// value time series, TWR, and IRR.
router.get("/value", (_req, res) => {
  const reconstructed = getReconstructedFromLatestBaseline();

  if (!reconstructed.ok) {
    res.status(404).json({ error: reconstructed.error });
    return;
  }

  const priceHistory: PriceHistory = {};

  // Build a simple symbol price history from transaction prices.
  for (const tx of reconstructed.allTransactions) {
    if (tx.symbol === null || tx.price === null) {
      continue;
    }

    if (!priceHistory[tx.symbol]) {
      priceHistory[tx.symbol] = [];
    }

    priceHistory[tx.symbol]!.push({
      date: tx.date,
      price: tx.price,
    });
  }

  const performance = calculatePerformance(
    reconstructed.baseline,
    reconstructed.postBaselineTransactions,
    priceHistory
  );

  const latestPoint = performance.series[performance.series.length - 1];
  if (!latestPoint) {
    res.status(200).json({
      date: reconstructed.state.date,
      holdingsValue: 0,
      cash: reconstructed.state.cash,
      totalValue: reconstructed.state.cash,
      startDate: performance.startDate,
      endDate: performance.endDate,
      totalReturn: performance.totalReturn,
      twr: performance.twr,
      irr: performance.irr,
      series: performance.series,
      pricingMethod: ACTIVE_PRICING_METHOD,
    });
    return;
  }

  const missingPriceSymbols: string[] = [];
  for (const symbol of Object.keys(reconstructed.state.holdings)) {
    if (!priceHistory[symbol] || priceHistory[symbol]!.length === 0) {
      missingPriceSymbols.push(symbol);
    }
  }

  res.status(200).json({
    date: latestPoint.date,
    holdingsValue: latestPoint.holdingsValue,
    cash: latestPoint.cash,
    totalValue: latestPoint.totalValue,
    startDate: performance.startDate,
    endDate: performance.endDate,
    totalReturn: performance.totalReturn,
    twr: performance.twr,
    irr: performance.irr,
    series: performance.series,
    pricingMethod: ACTIVE_PRICING_METHOD,
    missingPriceSymbols,
  });
});

export default router;
