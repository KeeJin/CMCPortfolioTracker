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
  if (description.toUpperCase().includes("SPLIT")) return "SPLIT";
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
  const match = description.match(/@\s*([\d,\s]+\.\d+)/);
  if (!match) return null;
  const value = parseFloat((match[1] ?? "").replace(/[\s,]+/g, ""));
  return isNaN(value) ? null : value;
}

// ─── Step 5b: Extract split ratio ─────────────────────────────────────────────
// Matches patterns like "20:1", "20 for 1", "1 for 20", etc.

export function extractSplitRatio(description: string): number | null {
  // Try "X:Y" format (e.g., "20:1")
  const colonMatch = description.match(/(\d+):(\d+)/);
  if (colonMatch) {
    const numerator = parseInt(colonMatch[1] ?? "0", 10);
    const denominator = parseInt(colonMatch[2] ?? "1", 10);
    if (denominator !== 0) {
      return numerator / denominator;
    }
  }

  // Try "X for Y" or "X to Y" format (e.g., "20 for 1", "1 for 20")
  const forMatch = description.match(/(\d+)\s+(?:for|to)\s+(\d+)/i);
  if (forMatch) {
    const numerator = parseInt(forMatch[1] ?? "0", 10);
    const denominator = parseInt(forMatch[2] ?? "1", 10);
    if (denominator !== 0) {
      return numerator / denominator;
    }
  }

  return null;
}

function parseAmountCell(cell: string): number | null {
  const normalized = cell.replace(/Cr$/i, "").replace(/[\s,]+/g, "").trim();
  if (!normalized) return null;

  const value = parseFloat(normalized);
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
  let columns = rest
    .split(/\s{2,}/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (columns.length < 2) {
    const refMatch = rest.match(/^(\S+)\s+/);
    if (!refMatch) return null;

    const reference = refMatch[1] as string;
    if (!/^\d+$/.test(reference)) {
      return null;
    }

    const afterRef = rest.slice(refMatch[0].length);
    const numberPattern = /[\d,]+\.\d+/g;
    const numbers = [...afterRef.matchAll(numberPattern)].map((match) => ({
      value: parseFloat((match[0] as string).replace(/,/g, "")),
      index: match.index as number,
    }));

    if (numbers.length === 0) {
      return null;
    }

    const amountEntry = numbers.length >= 2 ? numbers[numbers.length - 2]! : numbers[0]!;
    const description = afterRef.slice(0, amountEntry.index).trim();
    const type = classifyTransactionType(description);

    let debit: number | null = null;
    let credit: number | null = null;

    if (type === "BUY" || type === "WITHDRAWAL") {
      debit = amountEntry.value;
    } else {
      credit = amountEntry.value;
    }

    return { date, reference, description, debit, credit };
  }

  const reference = columns[0] as string;
  if (!/^\d+$/.test(reference)) {
    return null;
  }

  const description = columns[1] as string;
  const amount = parseAmountCell(columns[2] ?? "");
  if (amount === null) {
    return null;
  }

  const type = classifyTransactionType(description);
  let debit: number | null = null;
  let credit: number | null = null;

  if (type === "BUY" || type === "WITHDRAWAL") {
    debit = amount;
  } else {
    credit = amount;
  }

  return { date, reference, description, debit, credit };
}

export function parseTransactionStatementText(text: string): RawTransactionRow[] {
  const rows: RawTransactionRow[] = [];

  for (const line of text.split("\n")) {
    const row = parseRawRow(line);
    if (!row) {
      continue;
    }

    rows.push(row);
  }

  return rows;
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
  if (
    symbol === null &&
    (type === "BUY" || type === "SELL" || type === "DIVIDEND" || type === "SPLIT")
  ) {
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

  // Step 5b — split ratio (SPLIT only)
  const splitRatio = type === "SPLIT" ? extractSplitRatio(row.description) : null;

  // Step 6 — amount
  // For SPLIT transactions, amount should be 0 (no cash impact)
  let amount: number | null;
  if (type === "SPLIT") {
    amount = 0;
  } else {
    amount = calculateAmount(row.debit, row.credit);
  }

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
    splitRatio,
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
