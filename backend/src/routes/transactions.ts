import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { parseTransactionText } from '../parsers.js';
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
