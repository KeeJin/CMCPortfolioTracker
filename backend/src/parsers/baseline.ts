import type { Baseline } from "../models/index.js";

// ─── Result types ─────────────────────────────────────────────────────────────

export type BaselineParseError = {
  reason: string;
};

export type BaselineParseResult =
  | { ok: true; baseline: Baseline }
  | { ok: false; error: BaselineParseError };

// ─── Step 1: Extract date ─────────────────────────────────────────────────────
// Header line format: "At Close of Trading Day: DD/MM/YYYY"

export function extractBaselineDate(text: string): string | null {
  const match = text.match(/At Close of Trading Day:\s*(\d{2}\/\d{2}\/\d{4})/);
  if (!match) return null;
  return convertDate(match[1] as string);
}

// ─── Step 2: Extract cash balance ────────────────────────────────────────────
// Summary section: "Bank Balance    5,890.15"

export function extractCash(text: string): number | null {
  const match = text.match(/Bank Balance\s+([\d,]+\.\d+)/);
  if (!match) return null;
  const value = parseFloat((match[1] as string).replace(/,/g, ""));
  return isNaN(value) || value < 0 ? null : value;
}

// ─── Step 3: Extract holdings ────────────────────────────────────────────────
// Expects text produced by `pdftotext -layout`.
// Each holding row is a single long line starting with the security code:
//
//   " AMZN:US   Communications  AMAZON.COM INC    128    230.820USD ..."
//   " ASML:US   Technology      ASML HOLDING         4 1,069.860USD ..."
//
// Quantity rule: the integer immediately preceding the USD price on the same line.
// Per docs: rows with zero quantity are ignored.

export function extractHoldings(text: string): Record<string, number> {
  const holdings: Record<string, number> = {};

  for (const line of text.split("\n")) {
    // Line must start with a security code like "AMZN:US"
    const symbolMatch = line.match(/^\s*([A-Z]+):US\b/);
    if (!symbolMatch) continue;

    const symbol = symbolMatch[1] as string;

    // Quantity is the integer immediately before the USD price on this line.
    // e.g. "128       230.820USD" or "4 1,069.860USD"
    const qtyMatch = line.match(/\b(\d+)\s+[\d,]+\.\d+USD/);
    if (!qtyMatch) {
      console.error("MISSING QUANTITY FOR SYMBOL", symbol, { line: line.trim() });
      continue;
    }

    const quantity = parseInt(qtyMatch[1] as string, 10);

    // Per docs: ignore zero-quantity rows
    if (quantity === 0) continue;

    holdings[symbol] = quantity;
  }

  return holdings;
}

// ─── Main entry point ────────────────────────────────────────────────────────
// Parse extracted text from a CMC Invest Portfolio Report into a Baseline object.
// The `id` parameter should be a unique identifier supplied by the caller
// (e.g. derived from filename + upload timestamp).

export function parseBaselineText(
  text: string,
  id: string,
  source: string = ""
): BaselineParseResult {
  // Extract date
  const date = extractBaselineDate(text);
  if (!date) {
    return {
      ok: false,
      error: { reason: "MISSING DATE: could not find 'At Close of Trading Day'" },
    };
  }

  // Extract cash
  const cash = extractCash(text);
  if (cash === null) {
    return {
      ok: false,
      error: { reason: "MISSING CASH: could not find 'Bank Balance'" },
    };
  }

  // Extract holdings
  const holdings = extractHoldings(text);
  if (Object.keys(holdings).length === 0) {
    return {
      ok: false,
      error: { reason: "NO HOLDINGS FOUND in extracted text" },
    };
  }

  const baseline: Baseline = {
    id,
    date,
    holdings,
    cash,
    ...(source ? { source } : {}),
  };

  return { ok: true, baseline };
}

// ─── Date conversion: DD/MM/YYYY → YYYY-MM-DD ────────────────────────────────

function convertDate(ddmmyyyy: string): string | null {
  const match = ddmmyyyy.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}
