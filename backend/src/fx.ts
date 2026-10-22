import {
  fetchYahooFinanceHistoricalPrices,
  fetchYahooFinanceLatestPrices,
  type PricePoint,
} from "./pricing.js";

// ─── FX Rate Utilities ────────────────────────────────────────────────────────
// All internal monetary calculations use USD as the base currency.
// Transaction cash amounts from CMC Invest Singapore statements are in SGD
// and must be converted to USD before being used in performance calculations.

const USDSGD_SYMBOL = "USDSGD=X";

// Fetches historical USD/SGD daily rates via Yahoo Finance.
// Results are cached by the pricing layer (indefinitely for past dates, 15-min TTL for today).
export async function fetchUsdSgdHistory(
  startDate: string,
  endDate: string
): Promise<PricePoint[]> {
  const result = await fetchYahooFinanceHistoricalPrices(
    [USDSGD_SYMBOL],
    startDate,
    endDate
  );
  return result.history[USDSGD_SYMBOL] ?? [];
}

// Returns the current USD/SGD spot rate.
export async function fetchCurrentUsdSgdRate(): Promise<number | null> {
  const result = await fetchYahooFinanceLatestPrices([USDSGD_SYMBOL]);
  return result.livePrices[USDSGD_SYMBOL] ?? null;
}

// Returns the USD/SGD exchange rate for a given date.
// If no exact date match exists (e.g. weekend / holiday), forward-fills from
// the most recent available rate. Falls back to the earliest known rate if the
// requested date is before all available data.
export function getUsdSgdRate(date: string, fxPoints: PricePoint[]): number | null {
  if (fxPoints.length === 0) return null;

  let rate: number | null = null;
  for (const point of fxPoints) {
    if (point.date <= date) {
      rate = point.price;
    } else {
      break;
    }
  }

  // Date is before all available FX data — use the earliest known rate.
  if (rate === null) {
    rate = fxPoints[0]!.price;
  }

  return rate;
}

// Converts a SGD amount to USD using the FX rate on the given date.
// Falls back gracefully: if no FX data is available the SGD amount is returned
// unchanged (calculations remain consistent even without FX data).
export function convertSgdToUsd(
  sgdAmount: number,
  date: string,
  fxPoints: PricePoint[]
): number {
  const rate = getUsdSgdRate(date, fxPoints);
  if (rate === null || rate === 0) {
    // No FX data — pass amount through unchanged so calculations don't break.
    return sgdAmount;
  }
  // USDSGD rate = SGD per 1 USD, so to get USD: divide by rate.
  return sgdAmount / rate;
}
