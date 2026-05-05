import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractTextFromUploadedFile } from "../src/parsers/upload.js";
import { parseBaselineText } from "../src/parsers/baseline.js";
import { parseTransactionRow, parseTransactionStatementText } from "../src/parsers/transaction.js";

const backendRoot = process.cwd();
const workspaceRoot = join(backendRoot, "..");
const samplesDir = join(workspaceRoot, "samples");
const artifactDir = join(backendRoot, "test-artifacts");

async function readPdfAsUpload(filename: string) {
  const filePath = join(samplesDir, filename);
  const buffer = await readFile(filePath);
  return {
    originalname: filename,
    mimetype: "application/pdf",
    buffer,
  };
}

async function main() {
  await mkdir(artifactDir, { recursive: true });

  const baselineFilename = "PortfolioReport-785691-202604280541.pdf";
  const baselineText = await extractTextFromUploadedFile(await readPdfAsUpload(baselineFilename));
  const baselineResult = parseBaselineText(baselineText, "sample-baseline", baselineFilename);

  const transactionsFilename = "Statement-785691-20251031-20260325.pdf";
  const transactionsText = await extractTextFromUploadedFile(await readPdfAsUpload(transactionsFilename));
  const rows = parseTransactionStatementText(transactionsText);
  const parsedResults = rows.map((row) => parseTransactionRow(row, transactionsFilename));
  const accepted = parsedResults.filter((result) => result.ok).map((result) => result.transaction);
  const rejected = parsedResults.filter((result) => !result.ok).map((result) => result.error);

  await writeFile(join(artifactDir, "baseline.extracted.txt"), baselineText, "utf8");
  await writeFile(
    join(artifactDir, "baseline.parsed.json"),
    JSON.stringify(baselineResult, null, 2) + "\n",
    "utf8"
  );
  await writeFile(join(artifactDir, "transactions.extracted.txt"), transactionsText, "utf8");
  await writeFile(
    join(artifactDir, "transactions.parsed.json"),
    JSON.stringify(
      {
        rowCount: rows.length,
        acceptedCount: accepted.length,
        rejectedCount: rejected.length,
        accepted,
        rejected,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(`Baseline parsed: ${baselineResult.ok ? "ok" : baselineResult.error.reason}`);
  console.log(`Transactions parsed: ${accepted.length} accepted, ${rejected.length} rejected`);
  console.log(`Artifacts written to ${artifactDir}`);
}

main().catch((error) => {
  console.error("Failed to validate sample PDFs:", error);
  process.exitCode = 1;
});
