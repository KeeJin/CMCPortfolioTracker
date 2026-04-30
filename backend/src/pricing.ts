// ─── Price abstraction layer ──────────────────────────────────────────────────
// All price lookups go through PriceProvider.
// Add new providers to PricingMethod and buildPriceProvider when integrating
// additional price sources.

export type PricePoint = {
  date: string;
  price: number;
};

// Symbol → chronologically sorted price points.
export type PriceHistory = Record<string, PricePoint[]>;

// Returns the price of a symbol at a given date (YYYY-MM-DD), or undefined
// if no price is available.
export type PriceProvider = (symbol: string, date: string) => number | undefined;

// Identifies which pricing strategy is active.
// Extend this union when adding new price sources.
export type PricingMethod = "transaction_forward_fill" | "yahoo_finance";

// ─── Provider dispatcher ─────────────────────────────────────────────────────
// Returns a PriceProvider for the given method.
// Add new cases here when integrating additional price sources.
export function buildPriceProvider(
  method: PricingMethod,
  priceHistory: PriceHistory
): PriceProvider {
  switch (method) {
    case "transaction_forward_fill":
      return buildTransactionPriceProvider(priceHistory);
    case "yahoo_finance":
      throw new Error("yahoo_finance price provider is not yet implemented");
  }
}

// ─── transaction_forward_fill ─────────────────────────────────────────────────
// Builds a PriceProvider from a sparse transaction-derived price history.
// For each symbol, the last known price on or before the requested date is
// returned (forward-fill). Dates with no transaction are valued at the
// previous trade price.
export function buildTransactionPriceProvider(priceHistory: PriceHistory): PriceProvider {
  // Pre-sort each symbol's points ascending by date once.
  const sorted: PriceHistory = {};

  for (const [symbol, points] of Object.entries(priceHistory)) {
    const copied = [...points];
    copied.sort((a, b) => {
      if (a.date < b.date) return -1;
      if (a.date > b.date) return 1;
      return 0;
    });
    sorted[symbol] = copied;
  }

  return function getPrice(symbol: string, date: string): number | undefined {
    const points = sorted[symbol];
    if (!points || points.length === 0) {
      return undefined;
    }

    let latest: number | undefined = undefined;

    for (const point of points) {
      if (point.date <= date) {
        latest = point.price;
      } else {
        break;
      }
    }

    return latest;
  };
}
