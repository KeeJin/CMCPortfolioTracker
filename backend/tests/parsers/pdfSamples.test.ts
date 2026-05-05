import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractTextFromUploadedFile } from "../../src/parsers/upload";
import { parseBaselineText } from "../../src/parsers/baseline";
import { parseTransactionRow, parseTransactionStatementText } from "../../src/parsers/transaction";

const workspaceRoot = join(process.cwd(), "..");
const samplesDir = join(workspaceRoot, "samples");

async function readPdfAsUpload(filename: string) {
  const filePath = join(samplesDir, filename);
  const buffer = await readFile(filePath);
  return {
    originalname: filename,
    mimetype: "application/pdf",
    buffer,
  };
}

describe("sample PDF parser validation", () => {
  test("parses the sample baseline PDF end-to-end", async () => {
    const filename = "PortfolioReport-785691-202604280541.pdf";
    const text = await extractTextFromUploadedFile(await readPdfAsUpload(filename));
    const result = parseBaselineText(text, "sample-baseline", filename);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.baseline.date).toBe("2026-01-01");
    expect(result.baseline.cash).toBeCloseTo(5890.15, 2);
    expect(result.baseline.holdings["VGT"]).toBe(10);
    expect(result.baseline.holdings["NVDA"]).toBe(222);
    expect(Object.keys(result.baseline.holdings).length).toBe(17);
  });

  test("parses the sample transactions PDF end-to-end", async () => {
    const filename = "Statement-785691-20251031-20260325.pdf";
    const text = await extractTextFromUploadedFile(await readPdfAsUpload(filename));
    const rows = parseTransactionStatementText(text);

    expect(rows.length).toBe(43);

    const parsedResults = rows.map((row) => parseTransactionRow(row, filename));
    const accepted = parsedResults.filter((result) => result.ok);
    const rejected = parsedResults.filter((result) => !result.ok);

    expect(accepted.length).toBe(43);
    expect(rejected).toHaveLength(0);

    const transactions = accepted.map((result) => result.transaction);
    expect(transactions.some((transaction) => transaction.type === "BUY" && transaction.symbol === "AMZN" && transaction.quantity === 10)).toBe(true);
    expect(transactions.some((transaction) => transaction.type === "DIVIDEND" && transaction.symbol === "VGT")).toBe(true);
    expect(transactions.some((transaction) => transaction.type === "SELL" && transaction.symbol === "TXRH" && transaction.quantity === 15)).toBe(true);
  });
});
