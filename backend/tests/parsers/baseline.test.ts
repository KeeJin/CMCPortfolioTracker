import {
  extractBaselineDate,
  extractCash,
  extractHoldings,
  parseBaselineText,
} from "../../src/parsers/baseline";

// ─── Sample text extracted from samples/PortfolioReport-785691-202604280541.pdf
// using `pdftotext -layout`. Trimmed to the sections relevant for parsing.

const SAMPLE_HEADER = `
0906                         At Close of Trading Day: 01/01/2026
SINGAPORE                         Trading Account Number: 785691
`;

const SAMPLE_SUMMARY = `
 Description                        Market Value (SGD)
 Shares                                       193,304.20
 Total Market Value of Shares                 193,304.20
 Bank Balance                                   5,890.15
 Total                                        199,194.35
`;

// Holdings rows in layout format (symbol + quantity + USD price on one line)
const SAMPLE_HOLDINGS_ROWS = `
 AMZN:US         Communications AMAZON.COM INC                           128       230.820USD
 ASML:US         Technology             ASML HOLDING                        4 1,069.860USD
                                        NVNY REG SHS
 COST:US         Consumer,              COSTCO                              1      862.340USD
 NVDA:US         Technology             NVIDIA CORP                       222       186.500USD
 HOOD:US         Communications ROBINHOOD                                  22      113.100USD
`;

const SAMPLE_TEXT = SAMPLE_HEADER + SAMPLE_SUMMARY + SAMPLE_HOLDINGS_ROWS;

// ─── extractBaselineDate ──────────────────────────────────────────────────────

describe("extractBaselineDate", () => {
  it("extracts and converts date from header line", () => {
    expect(extractBaselineDate(SAMPLE_HEADER)).toBe("2026-01-01");
  });

  it("returns null when date line is absent", () => {
    expect(extractBaselineDate("No date here")).toBeNull();
  });

  it("handles different dates correctly", () => {
    expect(extractBaselineDate("At Close of Trading Day: 28/04/2026")).toBe("2026-04-28");
  });
});

// ─── extractCash ─────────────────────────────────────────────────────────────

describe("extractCash", () => {
  it("extracts bank balance from summary section", () => {
    expect(extractCash(SAMPLE_SUMMARY)).toBe(5890.15);
  });

  it("returns null when Bank Balance line is absent", () => {
    expect(extractCash("No bank balance here")).toBeNull();
  });

  it("handles balances with no comma separator", () => {
    expect(extractCash("Bank Balance 100.00")).toBe(100.0);
  });

  it("handles large balances with commas", () => {
    expect(extractCash("Bank Balance 1,234,567.89")).toBe(1234567.89);
  });
});

// ─── extractHoldings ─────────────────────────────────────────────────────────

describe("extractHoldings", () => {
  it("extracts all holdings from layout-format text", () => {
    const holdings = extractHoldings(SAMPLE_HOLDINGS_ROWS);
    expect(holdings).toEqual({
      AMZN: 128,
      ASML: 4,
      COST: 1,
      NVDA: 222,
      HOOD: 22,
    });
  });

  it("strips :US suffix from all symbols", () => {
    const holdings = extractHoldings(SAMPLE_HOLDINGS_ROWS);
    for (const symbol of Object.keys(holdings)) {
      expect(symbol).not.toContain(":US");
    }
  });

  it("ignores continuation lines (company name wrap)", () => {
    // The "NVNY REG SHS" continuation line for ASML must not produce an entry
    const holdings = extractHoldings(SAMPLE_HOLDINGS_ROWS);
    expect(Object.keys(holdings)).not.toContain("NVNY");
  });

  it("ignores zero-quantity rows", () => {
    const text = ` ZERO:US  Technology  ZERO CO   0  50.000USD\n`;
    const holdings = extractHoldings(text);
    expect(holdings["ZERO"]).toBeUndefined();
  });

  it("returns empty object when no holdings rows are present", () => {
    expect(extractHoldings("No holdings here")).toEqual({});
  });
});

// ─── parseBaselineText (main entry point) ────────────────────────────────────

describe("parseBaselineText — success", () => {
  it("returns a valid Baseline from real sample text", () => {
    const result = parseBaselineText(SAMPLE_TEXT, "baseline-001", "portfolio.pdf");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.baseline.id).toBe("baseline-001");
    expect(result.baseline.date).toBe("2026-01-01");
    expect(result.baseline.cash).toBe(5890.15);
    expect(result.baseline.source).toBe("portfolio.pdf");
  });

  it("returns correct holdings counts", () => {
    const result = parseBaselineText(SAMPLE_TEXT, "baseline-001");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.baseline.holdings["AMZN"]).toBe(128);
    expect(result.baseline.holdings["NVDA"]).toBe(222);
    expect(result.baseline.holdings["ASML"]).toBe(4);
    expect(result.baseline.holdings["HOOD"]).toBe(22);
  });

  it("omits source field when not provided", () => {
    const result = parseBaselineText(SAMPLE_TEXT, "baseline-001");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baseline.source).toBeUndefined();
  });
});

describe("parseBaselineText — error cases", () => {
  it("returns error when date is missing", () => {
    const noDate = SAMPLE_SUMMARY + SAMPLE_HOLDINGS_ROWS;
    const result = parseBaselineText(noDate, "x");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain("MISSING DATE");
  });

  it("returns error when Bank Balance is missing", () => {
    const noCash = SAMPLE_HEADER + SAMPLE_HOLDINGS_ROWS;
    const result = parseBaselineText(noCash, "x");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain("MISSING CASH");
  });

  it("returns error when no holdings are found", () => {
    const noHoldings = SAMPLE_HEADER + SAMPLE_SUMMARY;
    const result = parseBaselineText(noHoldings, "x");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain("NO HOLDINGS FOUND");
  });
});
