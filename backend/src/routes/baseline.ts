import { Router } from "express";
import { parseBaselineText } from "../parsers/baseline.js";
import { setBaseline, getBaseline } from "../store.js";
import { randomUUID } from "crypto";

const router = Router();

// POST /api/baseline
//
// Accepts a JSON body:
//   { text: string, source?: string }
//
// `text` is the raw extracted text from a portfolio report PDF
// (pdftotext -layout output). No file upload at this stage.

router.post("/", (req, res) => {
  const body = req.body as { text?: unknown; source?: unknown };

  if (typeof body.text !== "string" || body.text.trim() === "") {
    res.status(400).json({ error: "body.text must be a non-empty string" });
    return;
  }

  const source = typeof body.source === "string" ? body.source : "";
  const id = randomUUID();

  const result = parseBaselineText(body.text, id, source);

  if (!result.ok) {
    res.status(422).json({ error: result.error.reason });
    return;
  }

  setBaseline(result.baseline);

  res.status(200).json({ baseline: result.baseline });
});

// GET /api/baseline — useful for verifying stored state
router.get("/", (_req, res) => {
  const b = getBaseline();
  if (!b) {
    res.status(404).json({ error: "No baseline stored" });
    return;
  }
  res.status(200).json({ baseline: b });
});

export default router;
