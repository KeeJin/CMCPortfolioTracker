import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { parseBaselineText } from '../parsers.js';
import { addBaseline, addUpload, getAllBaselines, getAllTransactions } from '../store.js';
import { reconcileBaseline } from '../reconciliation.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

function readTextFromUpload(file: Express.Multer.File): string {
  const isPdf = file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf') || file.buffer.includes(Buffer.from('%PDF'));

  if (!isPdf) {
    return file.buffer.toString('utf8');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmc-baseline-'));
  const tempPath = path.join(tempDir, file.originalname || 'baseline.pdf');
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

router.post('/', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'A baseline file is required.' });
    return;
  }

  try {
    const text = readTextFromUpload(file);
    const parsed = parseBaselineText(text, file.originalname);

    if (!parsed.ok || !parsed.baseline) {
      res.status(400).json({ error: parsed.error ?? 'Unable to parse the baseline file.' });
      return;
    }

    const allBaselines = getAllBaselines();
    const latestBaseline = allBaselines.length > 0 ? allBaselines[allBaselines.length - 1] : null;
    const baseline = { ...parsed.baseline, id: `baseline-${parsed.baseline.date}-${Date.now()}` };

    const baselineResult = await addBaseline(baseline);
    const uploadResult = await addUpload({
      id: `upload-${Date.now()}`,
      type: 'BASELINE',
      filename: file.originalname,
      uploadedAt: new Date().toISOString(),
      dateRange: { start: baseline.date, end: baseline.date },
      metadata: { baselineDate: baseline.date },
    });

    let reconciliation: { status: 'MATCH' | 'MINOR_MISMATCH' | 'MAJOR_MISMATCH'; notes?: string[] } | undefined;

    if (latestBaseline) {
      const relevantTransactions = getAllTransactions().filter(
        (tx) => tx.date > latestBaseline.date && tx.date <= baseline.date,
      );
      reconciliation = reconcileBaseline(latestBaseline, baseline, relevantTransactions);
    }

    res.status(201).json({
      baseline: baselineResult.baseline,
      reconciliation: reconciliation
        ? { status: reconciliation.status, notes: reconciliation.notes }
        : undefined,
      syncStatus: {
        baselines: baselineResult.supabaseSync,
        uploads: uploadResult.supabaseSync,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected baseline parsing failure.';
    res.status(400).json({ error: message });
  }
});

router.get('/', (_req, res) => {
  const baselines = getAllBaselines();
  res.json({ baselines });
});

export default router;
