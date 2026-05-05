/**
 * Baseline represents a portfolio snapshot from a CMC Invest Portfolio Report.
 * 
 * CURRENCY SEMANTICS:
 * - `cash`: SGD (from "Bank Balance" in CMC summary table)
 * - `holdingPrices` (if present): USD (from "Last Price" column in CMC equities table)
 * - Quantities are unitless (share counts)
 */
export type Baseline = {
  id: string;
  date: string; // ISO format: YYYY-MM-DD
  holdings: Record<string, number>; // symbol → share count (unitless)
  holdingPrices?: Record<string, number>; // optional: symbol → USD price (from CMC "Last Price" column)
  cash: number; // total cash balance in SGD (from CMC "Bank Balance")
  source?: string; // optional (e.g. filename)
};
