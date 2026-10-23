import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Baseline, Transaction, Upload } from './parsers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

type StoreDocumentKey =
  | 'baselines'
  | 'transactions'
  | 'uploads'
  | 'portfolio_snapshot'
  | 'portfolio_history'
  | 'portfolio_value';

const state = {
  baselines: [] as Baseline[],
  transactions: [] as Transaction[],
  uploads: [] as Upload[],
};

function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

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

export async function readSupabaseDocument<T>(key: StoreDocumentKey): Promise<T | null> {
  if (!isSupabaseConfigured() || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/cache_documents?key=eq.${encodeURIComponent(key)}&select=key,value`, {
    method: 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'return=minimal',
    },
  });

  if (!response.ok) {
    return null;
  }

  const rows = (await response.json()) as Array<{ key: string; value: T }>;
  return rows[0]?.value ?? null;
}

async function writeSupabaseDocument<T>(key: StoreDocumentKey, value: T): Promise<void> {
  if (!isSupabaseConfigured() || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return;
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/cache_documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ key, value }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => 'Unable to read response body');
    throw new Error(`Supabase write failed for ${key}: ${response.status} ${response.statusText} - ${body}`);
  }
}

type SupabaseSyncContext = {
  operation: 'addBaseline' | 'addTransactions' | 'addUpload';
  baselineId?: string;
  baselineDate?: string;
  transactionAddedCount?: number;
  transactionInputCount?: number;
  uploadId?: string;
  uploadType?: Upload['type'];
  totalBaselines?: number;
  totalTransactions?: number;
  totalUploads?: number;
};

export type SupabaseSyncResult = {
  attempted: boolean;
  success: boolean;
  error?: string;
};

async function syncSupabaseDocumentWithLogging<T>(
  key: StoreDocumentKey,
  value: T,
  context: SupabaseSyncContext,
): Promise<SupabaseSyncResult> {
  if (!isSupabaseConfigured()) {
    return {
      attempted: false,
      success: false,
    };
  }

  try {
    await writeSupabaseDocument(key, value);
    console.info('[store] Supabase sync succeeded', {
      key,
      ...context,
    });
    return {
      attempted: true,
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Supabase sync error';
    console.error('[store] Supabase sync failed', {
      key,
      ...context,
      error: message,
    });
    return {
      attempted: true,
      success: false,
      error: message,
    };
  }
}

function writeLocalStoreState() {
  writeJsonFile(path.join(DATA_DIR, 'baselines.json'), state.baselines);
  writeJsonFile(path.join(DATA_DIR, 'transactions.json'), state.transactions);
  writeJsonFile(path.join(DATA_DIR, 'uploads.json'), state.uploads);
}

export async function hydrateStoreFromSupabase() {
  if (!isSupabaseConfigured()) {
    return;
  }

  const [remoteBaselines, remoteTransactions, remoteUploads] = await Promise.all([
    readSupabaseDocument<Baseline[]>('baselines'),
    readSupabaseDocument<Transaction[]>('transactions'),
    readSupabaseDocument<Upload[]>('uploads'),
  ]);

  if (remoteBaselines) {
    state.baselines = remoteBaselines;
  }

  if (remoteTransactions) {
    state.transactions = remoteTransactions;
  }

  if (remoteUploads) {
    state.uploads = remoteUploads;
  }

  writeLocalStoreState();
}

export async function initStore() {
  ensureDataDir();
  state.baselines = readJsonFile(path.join(DATA_DIR, 'baselines.json'), [] as Baseline[]);
  state.transactions = readJsonFile(path.join(DATA_DIR, 'transactions.json'), [] as Transaction[]);
  state.uploads = readJsonFile(path.join(DATA_DIR, 'uploads.json'), [] as Upload[]);

  if (isSupabaseConfigured()) {
    console.log('[store] Hydrating from Supabase cache_documents');
    await hydrateStoreFromSupabase();
    console.log('[store] Supabase hydration complete', {
      baselines: state.baselines.length,
      transactions: state.transactions.length,
      uploads: state.uploads.length,
    });
  }
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

export async function addBaseline(baseline: Baseline) {
  const exists = state.baselines.some((item) => item.id === baseline.id);
  let supabaseSync: SupabaseSyncResult = {
    attempted: false,
    success: false,
  };

  if (!exists) {
    state.baselines.push(baseline);
    state.baselines.sort((a, b) => a.date.localeCompare(b.date));
    writeJsonFile(path.join(DATA_DIR, 'baselines.json'), state.baselines);

    supabaseSync = await syncSupabaseDocumentWithLogging('baselines', state.baselines, {
      operation: 'addBaseline',
      baselineId: baseline.id,
      baselineDate: baseline.date,
      totalBaselines: state.baselines.length,
    });
  }
  return {
    baseline,
    supabaseSync,
  };
}

export async function addTransactions(items: Transaction[]) {
  const seen = new Set(state.transactions.map((tx) => tx.id));
  const newItems = items.filter((item) => !seen.has(item.id));

  for (const item of newItems) {
    state.transactions.push(item);
    seen.add(item.id);
  }

  state.transactions.sort((a, b) => a.date.localeCompare(b.date));
  writeJsonFile(path.join(DATA_DIR, 'transactions.json'), state.transactions);

  const supabaseSync = await syncSupabaseDocumentWithLogging('transactions', state.transactions, {
    operation: 'addTransactions',
    transactionAddedCount: newItems.length,
    transactionInputCount: items.length,
    totalTransactions: state.transactions.length,
  });

  return {
    added: newItems.length,
    duplicates: items.length - newItems.length,
    supabaseSync,
  };
}

export async function addUpload(upload: Upload) {
  state.uploads.unshift(upload);
  writeJsonFile(path.join(DATA_DIR, 'uploads.json'), state.uploads);

  const supabaseSync = await syncSupabaseDocumentWithLogging('uploads', state.uploads, {
    operation: 'addUpload',
    uploadId: upload.id,
    uploadType: upload.type,
    totalUploads: state.uploads.length,
  });

  return {
    upload,
    supabaseSync,
  };
}
