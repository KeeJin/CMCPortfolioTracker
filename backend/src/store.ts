import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Baseline, Transaction, Upload } from './parsers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');

const state = {
  baselines: [] as Baseline[],
  transactions: [] as Transaction[],
  uploads: [] as Upload[],
};

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.trim()) {
      return fallback;
    }
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile<T>(filePath: string, value: T) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function initStore() {
  ensureDataDir();
  state.baselines = readJsonFile(path.join(DATA_DIR, 'baselines.json'), [] as Baseline[]);
  state.transactions = readJsonFile(path.join(DATA_DIR, 'transactions.json'), [] as Transaction[]);
  state.uploads = readJsonFile(path.join(DATA_DIR, 'uploads.json'), [] as Upload[]);
}

export function getAllBaselines(): Baseline[] {
  return [...state.baselines].sort((a, b) => a.date.localeCompare(b.date));
}

export function getAllTransactions(): Transaction[] {
  return [...state.transactions].sort((a, b) => a.date.localeCompare(b.date));
}

export function getAllUploads(): Upload[] {
  return [...state.uploads].sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));
}

export function addBaseline(baseline: Baseline) {
  const exists = state.baselines.some((item) => item.id === baseline.id);
  if (!exists) {
    state.baselines.push(baseline);
    state.baselines.sort((a, b) => a.date.localeCompare(b.date));
    writeJsonFile(path.join(DATA_DIR, 'baselines.json'), state.baselines);
  }
  return baseline;
}

export function addTransactions(items: Transaction[]) {
  const seen = new Set(state.transactions.map((tx) => tx.id));
  const newItems = items.filter((item) => !seen.has(item.id));

  for (const item of newItems) {
    state.transactions.push(item);
    seen.add(item.id);
  }

  state.transactions.sort((a, b) => a.date.localeCompare(b.date));
  writeJsonFile(path.join(DATA_DIR, 'transactions.json'), state.transactions);

  return {
    added: newItems.length,
    duplicates: items.length - newItems.length,
  };
}

export function addUpload(upload: Upload) {
  state.uploads.unshift(upload);
  writeJsonFile(path.join(DATA_DIR, 'uploads.json'), state.uploads);
  return upload;
}
