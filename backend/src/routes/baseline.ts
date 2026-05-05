import { Router } from "express";
import multer from "multer";
import { parseBaselineText } from "../parsers/baseline.js";
import { setBaseline, getAllBaselines, getAllTransactions, recordUpload } from "../store.js";
import { randomUUID } from "crypto";
import { reconcileBaseline } from "../reconciliation.js";
import { findPreviousBaseline } from "../portfolioState.js";
import { extractTextFromUploadedFile } from "../parsers/upload.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// POST /api/baseline
//
// Accepts a multipart upload containing the baseline PDF.

router.post("/", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "multipart field 'file' is required" });
    return;
  }

  const source = file.originalname || "baseline-upload";
  const id = randomUUID();

  let text: string;

  try {
    text = await extractTextFromUploadedFile(file);
  } catch (error) {
    res.status(422).json({ error: error instanceof Error ? error.message : "Failed to read upload" });
    return;
  }

  const result = parseBaselineText(text, id, source);

  if (!result.ok) {
    res.status(422).json({ error: result.error.reason });
    return;
  }

  const previousBaseline = findPreviousBaseline(getAllBaselines(), result.baseline);
  const reconciliation = previousBaseline
    ? reconcileBaseline(previousBaseline, result.baseline, getAllTransactions())
    : undefined;

  setBaseline(result.baseline);
  recordUpload({
    id: randomUUID(),
    type: "BASELINE",
    filename: source || `baseline-${result.baseline.date}`,
    uploadedAt: new Date().toISOString(),
    dateRange: {
      start: result.baseline.date,
      end: result.baseline.date,
    },
    metadata: {
      baselineDate: result.baseline.date,
      reconciliationStatus: reconciliation?.status,
    },
  });

  res.status(200).json({ baseline: result.baseline, reconciliation });
});

// GET /api/baseline — useful for verifying stored state
router.get("/", (_req, res) => {
  const baselines = getAllBaselines();
  if (baselines.length === 0) {
    res.status(404).json({ error: "No baselines stored" });
    return;
  }
  res.status(200).json({ baselines });
});

export default router;
