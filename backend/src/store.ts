import type { NormalizedTransaction } from "./models/index.js";
import type { Baseline } from "./models/index.js";
import type { Upload } from "./models/index.js";
import { readJson, writeJson } from "./persistence.js";

// ─── In-memory store ──────────────────────────────────────────────────────────
// Keyed by transaction ID for O(1) deduplication.
// Baselines and upload actions are append-only.

const transactions = new Map<string, NormalizedTransaction>();
const baselines: Baseline[] = [];
const uploads: Upload[] = [];

// ─── Persistence ──────────────────────────────────────────────────────────────

function saveStore(): void {
  writeJson("baselines.json", baselines);
  writeJson("transactions.json", Array.from(transactions.values()));
  writeJson("uploads.json", uploads);
}

// Loads persisted data from disk into the in-memory store.
// Must be called once at server startup before handling any requests.
export function initStore(): void {
  const savedBaselines = readJson<Baseline[]>("baselines.json", []);
  const savedTransactions = readJson<NormalizedTransaction[]>("transactions.json", []);
  const savedUploads = readJson<Upload[]>("uploads.json", []);

  for (const b of savedBaselines) {
    baselines.push(b);
  }
  for (const tx of savedTransactions) {
    transactions.set(tx.id, tx);
  }
  for (const u of savedUploads) {
    uploads.push(u);
  }

  console.log(
    `[store] Loaded from disk: ${baselines.length} baselines, ${transactions.size} transactions, ${uploads.length} uploads`
  );
}

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

  if (added > 0) {
    saveStore();
  }

  return { added, duplicates };
}

export function getAllTransactions(): NormalizedTransaction[] {
  return Array.from(transactions.values());
}

export function clearTransactions(): void {
  transactions.clear();
  saveStore();
}

// ─── Baseline ─────────────────────────────────────────────────────────────────

export function setBaseline(b: Baseline): void {
  baselines.push(b);
  saveStore();
}

export function getBaseline(): Baseline | null {
  if (baselines.length === 0) {
    return null;
  }

  let latest = baselines[0]!;

  for (let index = 1; index < baselines.length; index += 1) {
    const candidate = baselines[index]!;
    if (candidate.date >= latest.date) {
      latest = candidate;
    }
  }

  return latest;
}

export function getAllBaselines(): Baseline[] {
  return [...baselines];
}

export function recordUpload(upload: Upload): void {
  uploads.push(upload);
  saveStore();
}

export function getUploads(): Upload[] {
  return [...uploads];
}
