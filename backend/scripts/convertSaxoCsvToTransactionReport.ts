import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

type SaxoRow = {
  accountId: string;
  tradeId: string;
  event: string;
  adjustedTradeDate: string;
  tradeExecutionDate: string;
  tradeEventType: string;
  tradedQuantity: string;
  price: string;
  tradedValue: string;
  instrumentSymbol: string;
};

type SplitAccumulator = {
  boughtQty: number;
  soldQty: number;
  firstTradeId: string;
  date: string;
  symbol: string;
};

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  values.push(current);
  return values.map((v) => v.trim());
}

function normalizeDate(input: string): string {
  // Saxo format: 10-Jun-2024
  const [dayRaw, monRaw, yearRaw] = input.trim().split("-");
  const monthMap: Record<string, string> = {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12",
  };

  const day = (dayRaw ?? "").padStart(2, "0");
  const month = monthMap[(monRaw ?? "").toLowerCase()] ?? "01";
  const year = yearRaw ?? "1970";

  return `${day}/${month}/${year}`;
}

function normalizeSymbol(instrumentSymbol: string): string {
  const left = instrumentSymbol.split(":")[0] ?? "";
  return `${left.toUpperCase()}:US`;
}

function toNumber(input: string): number {
  const n = Number(input.replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

function toSaxoRow(values: string[]): SaxoRow | null {
  if (values.length < 24) return null;

  return {
    accountId: values[0] ?? "",
    tradeId: values[1] ?? "",
    event: values[5] ?? "",
    adjustedTradeDate: values[7] ?? "",
    tradeExecutionDate: values[8] ?? "",
    tradeEventType: values[9] ?? "",
    tradedQuantity: values[12] ?? "",
    price: values[13] ?? "",
    tradedValue: values[14] ?? "",
    instrumentSymbol: values[19] ?? "",
  };
}

function formatAmount(amount: number): string {
  return Math.abs(amount).toFixed(2);
}

function makeLine(date: string, tradeId: string, description: string, amountAbs: string): string {
  // Expected parser format:
  // DD/MM/YYYY  <reference>  <description>  <amount>
  return `${date}  ${tradeId}  ${description}  ${amountAbs}`;
}

function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];

  if (!inputPath || !outputPath) {
    console.error("Usage: node --loader ts-node/esm scripts/convertSaxoCsvToTransactionReport.ts <input.csv> <output.txt>");
    process.exit(1);
  }

  const csv = readFileSync(resolve(inputPath), "utf8");
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length <= 1) {
    console.error("CSV appears empty or only has headers");
    process.exit(1);
  }

  const outputLines: string[] = [];
  const splitMap = new Map<string, SplitAccumulator>();

  // Skip header row
  for (let i = 1; i < lines.length; i += 1) {
    const rowValues = parseCsvLine(lines[i]!);
    const row = toSaxoRow(rowValues);
    if (!row) continue;

    const date = normalizeDate(row.adjustedTradeDate);
    const symbol = normalizeSymbol(row.instrumentSymbol);
    const event = row.event.toLowerCase();
    const tradeType = row.tradeEventType.toLowerCase();
    const qty = toNumber(row.tradedQuantity);
    const price = toNumber(row.price);
    const tradedValue = toNumber(row.tradedValue);

    if (event.includes("stock split")) {
      const key = `${date}|${symbol}`;
      const existing = splitMap.get(key) ?? {
        boughtQty: 0,
        soldQty: 0,
        firstTradeId: row.tradeId,
        date,
        symbol,
      };

      if (tradeType === "bought") {
        existing.boughtQty += Math.abs(qty);
      } else if (tradeType === "sold") {
        existing.soldQty += Math.abs(qty);
      }

      splitMap.set(key, existing);
      continue;
    }

    if (tradeType === "bought") {
      const description = `Bght ${Math.abs(qty)} ${symbol} @ ${price.toFixed(2)} USD`;
      outputLines.push(makeLine(date, row.tradeId, description, formatAmount(tradedValue)));
      continue;
    }

    if (tradeType === "sold") {
      const description = `Sold ${Math.abs(qty)} ${symbol} @ ${price.toFixed(2)} USD`;
      outputLines.push(makeLine(date, row.tradeId, description, formatAmount(tradedValue)));
    }
  }

  // Emit one SPLIT line per grouped split event.
  for (const split of splitMap.values()) {
    if (split.soldQty <= 0 || split.boughtQty <= 0) {
      continue;
    }

    const ratio = split.boughtQty / split.soldQty;
    const ratioText = Number.isInteger(ratio) ? `${ratio}:1` : `${ratio.toFixed(4)}:1`;
    const description = `SPLIT ${split.symbol} ${ratioText}`;
    outputLines.push(makeLine(split.date, split.firstTradeId, description, "0.00"));
  }

  outputLines.sort((a, b) => {
    const [dateA, refA] = a.split(/\s{2,}/);
    const [dateB, refB] = b.split(/\s{2,}/);

    const [da, ma, ya] = dateA.split("/");
    const [db, mb, yb] = dateB.split("/");
    const isoA = `${ya}-${ma}-${da}`;
    const isoB = `${yb}-${mb}-${db}`;

    if (isoA < isoB) return -1;
    if (isoA > isoB) return 1;
    return refA.localeCompare(refB);
  });

  const banner = [
    "# Converted from Saxo CSV",
    `# Source: ${basename(inputPath)}`,
    "# Format: DD/MM/YYYY  reference  description  amount",
    "# Upload this as Transactions file in the app",
    "",
  ].join("\n");

  writeFileSync(resolve(outputPath), `${banner}${outputLines.join("\n")}\n`, "utf8");
  console.log(`Wrote ${outputLines.length} converted transactions to ${resolve(outputPath)}`);
}

main();
