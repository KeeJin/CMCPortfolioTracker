import { Router } from "express";
import { parseTransactionRow } from "../parsers/transaction.js";
import { addTransactions, getAllTransactions } from "../store.js";
import type { RawTransactionRow } from "../parsers/transaction.js";
import type { NormalizedTransaction } from "../models/index.js";

const router = Router();

// POST /api/transactions
//
// Accepts a JSON body:
//   { rows: RawTransactionRow[], source?: string }
//
// Each row is a pre-structured object (no PDF parsing required at this stage).
// Returns a summary of how many transactions were added vs deduplicated.

router.post("/", (req, res) => {
  const body = req.body as { rows?: unknown; source?: unknown };

  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    res.status(400).json({ error: "body.rows must be a non-empty array" });
    return;
  }

  const source = typeof body.source === "string" ? body.source : "";

  const accepted: NormalizedTransaction[] = [];
  const errors: { row: unknown; reason: string }[] = [];

  for (const row of body.rows as RawTransactionRow[]) {
    const result = parseTransactionRow(row, source);
    if (result.ok) {
      accepted.push(result.transaction);
    } else {
      errors.push({ row: result.error.row, reason: result.error.reason });
    }
  }

  const { added, duplicates } = addTransactions(accepted);

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
