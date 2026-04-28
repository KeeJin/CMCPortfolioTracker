import type { NormalizedTransaction, TransactionType } from "../models/index.js";

// ─── Raw row shape extracted before classification ───────────────────────────

export type RawTransactionRow = {
  date: string; // as it appears in the statement (DD/MM/YYYY)
  reference: string;
  description: string;
  debit: number | null;
  credit: number | null;
};

// ─── Parse errors surface the original row for debugging ─────────────────────

export type ParseError = {
  row: RawTransactionRow;
  reason: string;
};

export type ParseResult =
  | { ok: true; transaction: NormalizedTransaction }
  | { ok: false; error: ParseError };

// ─── Step 2: Classify transaction type ───────────────────────────────────────
// Rules are case-sensitive and explicit — no fuzzy matching.

export function classifyTransactionType(
  description: string
): TransactionType | "UNKNOWN" {
  if (description.includes("Bght")) return "BUY";
  if (description.includes("Sold")) return "SELL";
  if (description.includes("Intl Div")) return "DIVIDEND";
  if (description.includes("Dep CHASSGSG")) return "DEPOSIT";
  if (description.includes("Wdl CHASSGSG")) return "WITHDRAWAL";
  return "UNKNOWN";
}

// ─── Step 3: Extract symbol from description ─────────────────────────────────
// Symbols appear as uppercase letters followed by ":US" (e.g. AMZN:US).
// Strip ":US" suffix before storing.

export function extractSymbol(description: string): string | null {
  const match = description.match(/\b([A-Z]+):US\b/);
  if (!match) return null;
  return match[1] ?? null;
}

// ─── Step 4: Extract quantity ─────────────────────────────────────────────────
// Number immediately after "Bght" or "Sold".

export function extractQuantity(description: string): number | null {
  const match = description.match(/(?:Bght|Sold)\s+(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const value = parseFloat(match[1] ?? "");
  return isNaN(value) ? null : value;
}

// ─── Step 5: Extract price ────────────────────────────────────────────────────
// Number after "@" in description.

export function extractPrice(description: string): number | null {
  const match = description.match(/@\s*(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const value = parseFloat(match[1] ?? "");
  return isNaN(value) ? null : value;
}

// ─── Step 6: Determine amount from debit/credit columns ──────────────────────
// Inflows (credit) → positive. Outflows (debit) → negative.

export function calculateAmount(
  debit: number | null,
  credit: number | null
): number | null {
  if (credit !== null) return credit;
  if (debit !== null) return -debit;
  return null;
}

// ─── Step 1: Parse a single raw text row into structured fields ───────────────
// Expected format: "DD/MM/YYYY  <reference>  <description>  [debit]  [credit]"
// The PDF extractor produces columnar text with values separated by whitespace.
// Debit/credit values may contain commas (e.g. "3,015.44").

export function parseRawRow(rawText: string): RawTransactionRow | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  // Match date at the start: DD/MM/YYYY
  const dateMatch = trimmed.match(/^(\d{2}\/\d{2}\/\d{4})\s+/);
  if (!dateMatch) return null;

  const date = dateMatch[1] as string;
  const rest = trimmed.slice(dateMatch[0].length);

  // Next token is the reference ID (numeric)
  const refMatch = rest.match(/^(\S+)\s+/);
  if (!refMatch) return null;

  const reference = refMatch[1] as string;
  const afterRef = rest.slice(refMatch[0].length);

  // Trailing number columns are debit/credit values (may include commas).
  // We extract up to two trailing numbers and treat the middle as description.
  const numberPattern = /[\d,]+\.\d+/g;
  const numbers = [...afterRef.matchAll(numberPattern)].map((m) => ({
    value: parseFloat((m[0] as string).replace(/,/g, "")),
    index: m.index as number,
  }));

  let debit: number | null = null;
  let credit: number | null = null;
  let descriptionEnd = afterRef.length;

  if (numbers.length >= 2) {
    // Last two numbers are the amount columns; description is everything before
    const last = numbers[numbers.length - 1]!;
    const secondLast = numbers[numbers.length - 2]!;
    descriptionEnd = secondLast.index;
    // The second-to-last column is the transaction amount (debit or credit);
    // the last column is the running balance — we don't store it.
    debit = secondLast.value;
    credit = null; // resolved in context; we carry raw value for now
    void last; // running balance, ignored
  } else if (numbers.length === 1) {
    descriptionEnd = numbers[0]!.index;
    debit = numbers[0]!.value;
  }

  const description = afterRef.slice(0, descriptionEnd).trim();

  return { date, reference, description, debit, credit };
}

// ─── Main entry point: parse a single statement row ──────────────────────────
// Accepts either a pre-structured RawTransactionRow or raw text string.
// Returns a ParseResult (ok or error) — never throws.

export function parseTransactionRow(
  input: RawTransactionRow | string,
  source: string = ""
): ParseResult {
  // Allow callers to pass a pre-parsed row or raw text
  let row: RawTransactionRow;

  if (typeof input === "string") {
    const parsed = parseRawRow(input);
    if (!parsed) {
      return {
        ok: false,
        error: {
          row: {
            date: "",
            reference: "",
            description: input,
            debit: null,
            credit: null,
          },
          reason: "Could not parse row structure (expected date + reference + description)",
        },
      };
    }
    row = parsed;
  } else {
    row = input;
  }

  // Step 2 — classify
  const type = classifyTransactionType(row.description);
  if (type === "UNKNOWN") {
    console.error("UNKNOWN TRANSACTION TYPE", { row });
    return { ok: false, error: { row, reason: "UNKNOWN TRANSACTION TYPE" } };
  }

  // Step 3 — symbol
  const symbol = extractSymbol(row.description);
  if (symbol === null && (type === "BUY" || type === "SELL" || type === "DIVIDEND")) {
    console.error("MISSING SYMBOL FOR", type, { row });
    return {
      ok: false,
      error: { row, reason: `MISSING SYMBOL FOR ${type}` },
    };
  }

  // Step 4 — quantity (BUY/SELL only)
  const quantity =
    type === "BUY" || type === "SELL" ? extractQuantity(row.description) : null;

  // Step 5 — price (BUY/SELL only)
  const price =
    type === "BUY" || type === "SELL" ? extractPrice(row.description) : null;

  // Step 6 — amount
  const amount = calculateAmount(row.debit, row.credit);
  if (amount === null) {
    return {
      ok: false,
      error: { row, reason: "Could not determine amount: both debit and credit are null" },
    };
  }

  // Step 7 — convert date from DD/MM/YYYY to YYYY-MM-DD
  const isoDate = convertDate(row.date);
  if (!isoDate) {
    return { ok: false, error: { row, reason: `INVALID DATE FORMAT: ${row.date}` } };
  }

  const transaction: NormalizedTransaction = {
    id: row.reference,
    date: isoDate,
    type,
    symbol,
    quantity,
    price,
    amount,
    source,
  };

  return { ok: true, transaction };
}

// ─── Date conversion helper ───────────────────────────────────────────────────
// Converts DD/MM/YYYY → YYYY-MM-DD

export function convertDate(ddmmyyyy: string): string | null {
  const match = ddmmyyyy.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}
