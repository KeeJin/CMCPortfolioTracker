import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { parseTransactionText } from '../parsers.js';
import { buildManualTransaction } from '../manualTrades.js';
import { addTransactions, addUpload, getAllTransactions } from '../store.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

function readTextFromUpload(file: Express.Multer.File): string {
  const isPdf = file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf') || file.buffer.includes(Buffer.from('%PDF'));

  if (!isPdf) {
    return file.buffer.toString('utf8');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmc-transactions-'));
  const tempPath = path.join(tempDir, file.originalname || 'transactions.pdf');
  fs.writeFileSync(tempPath, file.buffer);

  try {
    const stdout = execFileSync('pdftotext', ['-layout', tempPath, '-'], { encoding: 'utf8' });
    return stdout;
  } catch {
    try {
      const stdout = execFileSync('pdftotext', [tempPath, '-'], { encoding: 'utf8' });
      return stdout;
    } catch {
      return file.buffer.toString('utf8');
    }
  }
}

router.post('/', upload.single('file'), (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'A transactions file is required.' });
    return;
  }

  try {
    const text = readTextFromUpload(file);
    const result = parseTransactionText(text, file.originalname);

    const seen = new Set(getAllTransactions().map((tx) => tx.id));
    const deduped = result.accepted.filter((tx) => {
      if (seen.has(tx.id)) {
        return false;
      }
      seen.add(tx.id);
      return true;
    });

    const persisted = addTransactions(deduped);
    addUpload({
      id: `upload-${Date.now()}`,
      type: 'TRANSACTIONS',
      filename: file.originalname,
      uploadedAt: new Date().toISOString(),
      dateRange: deduped.length > 0
        ? { start: deduped[0].date, end: deduped[deduped.length - 1].date }
        : undefined,
      metadata: {
        transactionCount: deduped.length,
        duplicatesIgnored: persisted.duplicates,
        parseErrors: result.parseErrors,
        unknownTypeRows: result.diagnostics.unknownTypeRows,
        heuristicClassifiedRows: result.diagnostics.heuristicClassifiedRows,
        rowsConsidered: result.diagnostics.rowsConsidered,
      },
    });

    res.status(201).json({
      added: deduped.length,
      duplicates: persisted.duplicates,
      parseErrors: result.parseErrors,
      diagnostics: result.diagnostics,
      errors: result.errors,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected transaction parsing failure.';
    res.status(400).json({ error: message });
  }
});

router.post('/manual', (req, res) => {
  const payload = req.body ?? {};
  console.info('[manual-entry] Received submission', {
    date: payload.date,
    type: payload.type,
    instrumentType: payload.instrumentType,
    symbol: payload.symbol,
    underlyingSymbol: payload.underlyingSymbol,
    quantity: payload.quantity,
    price: payload.price,
    contractMultiplier: payload.contractMultiplier,
    ownershipShare: payload.ownershipShare,
    valuationMethod: payload.valuationMethod,
    valuationStartDate: payload.valuationStartDate,
    valuationStartPrice: payload.valuationStartPrice,
    valuationStartAmount: payload.valuationStartAmount,
    valuationEndDate: payload.valuationEndDate,
    valuationEndPrice: payload.valuationEndPrice,
    valuationEndAmount: payload.valuationEndAmount,
    source: payload.source,
  });

  try {
    const tx = buildManualTransaction({
      date: payload.date,
      type: payload.type,
      instrumentType: payload.instrumentType,
      symbol: payload.symbol,
      underlyingSymbol: payload.underlyingSymbol,
      optionType: payload.optionType,
      strikePrice: payload.strikePrice,
      expiryDate: payload.expiryDate,
      quantity: payload.quantity,
      price: payload.price,
      amount: payload.amount,
      contractMultiplier: payload.contractMultiplier,
      ownershipShare: payload.ownershipShare,
      valuationMethod: payload.valuationMethod,
      valuationStartDate: payload.valuationStartDate,
      valuationStartPrice: payload.valuationStartPrice,
      valuationStartAmount: payload.valuationStartAmount,
      valuationEndDate: payload.valuationEndDate,
      valuationEndPrice: payload.valuationEndPrice,
      valuationEndAmount: payload.valuationEndAmount,
      source: payload.source ?? 'manual-entry',
    });

    console.info('[manual-entry] Built transaction', {
      id: tx.id,
      date: tx.date,
      type: tx.type,
      symbol: tx.symbol,
      quantity: tx.quantity,
      price: tx.price,
      amount: tx.amount,
      valuationMethod: tx.valuationMethod,
      valuationStartDate: tx.valuationStartDate,
      valuationStartPrice: tx.valuationStartPrice,
      valuationEndDate: tx.valuationEndDate,
      valuationEndPrice: tx.valuationEndPrice,
      source: tx.source,
    });

    const result = addTransactions([tx]);
    addUpload({
      id: `manual-${Date.now()}`,
      type: 'TRANSACTIONS',
      filename: `manual-${tx.symbol ?? 'trade'}.json`,
      uploadedAt: new Date().toISOString(),
      dateRange: { start: tx.date, end: tx.date },
      metadata: {
        transactionCount: result.added,
        source: 'manual-entry',
      },
    });

    res.status(201).json({
      transaction: tx,
      added: result.added,
      duplicates: result.duplicates,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected manual transaction failure.';
    console.error('[manual-entry] Submission failed', {
      error: message,
      payload,
    });
    res.status(400).json({ error: message });
  }
});

router.get('/', (req, res) => {
  const { startDate, endDate } = req.query;
  const all = getAllTransactions();
  const filtered = all.filter((tx) => {
    if (startDate && tx.date < String(startDate)) return false;
    if (endDate && tx.date > String(endDate)) return false;
    return true;
  });
  res.json(filtered);
});

export default router;
