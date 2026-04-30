import type { NormalizedTransaction } from "./models/index.js";
import type { Baseline } from "./models/index.js";

// ─── In-memory store ──────────────────────────────────────────────────────────
// Keyed by transaction ID for O(1) deduplication.
// A single baseline is kept; a new POST replaces it.

const transactions = new Map<string, NormalizedTransaction>();
let baseline: Baseline | null = null;

// ─── Transactions ─────────────────────────────────────────────────────────────

export function addTransactions(incoming: NormalizedTransaction[]): {
  added: number;
  duplicates: number;
} {
  let added = 0;
  let duplicates = 0;

  for (const tx of incoming) {
    if (transactions.has(tx.id)) {
      duplicates++;
    } else {
      transactions.set(tx.id, tx);
      added++;
    }
  }

  return { added, duplicates };
}

export function getAllTransactions(): NormalizedTransaction[] {
  return Array.from(transactions.values());
}

export function clearTransactions(): void {
  transactions.clear();
}

// ─── Baseline ─────────────────────────────────────────────────────────────────

export function setBaseline(b: Baseline): void {
  baseline = b;
}

export function getBaseline(): Baseline | null {
  return baseline;
}
