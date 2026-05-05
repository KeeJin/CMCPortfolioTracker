import { Router } from "express";
import multer from "multer";
import { parseTransactionRow, parseTransactionStatementText } from "../parsers/transaction.js";
import { addTransactions, getAllTransactions, recordUpload } from "../store.js";
import type { NormalizedTransaction } from "../models/index.js";
import { randomUUID } from "crypto";
import { extractTextFromUploadedFile } from "../parsers/upload.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// POST /api/transactions
//
// Accepts a multipart upload containing the statement PDF.

router.post("/", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "multipart field 'file' is required" });
    return;
  }

  const source = file.originalname || "transactions-upload";

  let text: string;

  try {
    text = await extractTextFromUploadedFile(file);
  } catch (error) {
    res.status(422).json({ error: error instanceof Error ? error.message : "Failed to read upload" });
    return;
  }

  const rows = parseTransactionStatementText(text);
  if (rows.length === 0) {
    res.status(422).json({ error: "No transaction rows found in uploaded file" });
    return;
  }

  const accepted: NormalizedTransaction[] = [];
  const errors: { row: unknown; reason: string }[] = [];

  for (const row of rows) {
    const result = parseTransactionRow(row, source);
    if (result.ok) {
      accepted.push(result.transaction);
    } else {
      errors.push({ row: result.error.row, reason: result.error.reason });
    }
  }

  const { added, duplicates } = addTransactions(accepted);

  let startDate: string | undefined;
  let endDate: string | undefined;

  for (const tx of accepted) {
    if (!startDate || tx.date < startDate) {
      startDate = tx.date;
    }
    if (!endDate || tx.date > endDate) {
      endDate = tx.date;
    }
  }

  recordUpload({
    id: randomUUID(),
    type: "TRANSACTIONS",
    filename: source || `transactions-${new Date().toISOString()}`,
    uploadedAt: new Date().toISOString(),
    dateRange:
      startDate && endDate
        ? {
            start: startDate,
            end: endDate,
          }
        : undefined,
    metadata: {
      transactionCount: added,
      duplicatesIgnored: duplicates,
      parseErrors: errors.length,
    },
  });

  res.status(200).json({
    added,
    duplicates,
    parseErrors: errors.length,
    errors: errors.length > 0 ? errors : undefined,
  });
});

// GET /api/transactions — useful for verifying stored state
router.get("/", (_req, res) => {
  res.status(200).json({ transactions: getAllTransactions() });
});

export default router;
