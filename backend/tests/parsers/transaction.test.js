"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const transaction_1 = require("../../src/parsers/transaction");
// ─── Real rows extracted from samples/Statement-785691-20251031-20260325.pdf ──
const RAW_BUY_AMZN = "18/11/2025 33784 Bght 10 AMZN:US @ 301.5441 SGD 3,015.44 120,254.56";
const RAW_SELL_TXRH = "18/11/2025 33797 Sold 15 TXRH:US @ 220.9747 SGD 3,314.62 123,569.18";
const RAW_DIVIDEND_ASML = "10/11/2025 3959750 JNL3959750 ASML:US Intl Div Ex:29/10/25 8.26 99,998.61";
const RAW_DEPOSIT = "10/11/2025 21788176 Dep CHASSGSG 100000003011513 100000.00 99,990.35";
const RAW_WITHDRAWAL = "18/11/2025 30607526 Wdl CHASSGSG 100000003011513 33784(FX) 5000.00 118,569.18";
const RAW_BUY_HOOD = "18/11/2025 33799 Bght 22 HOOD:US @ 154.2137 SGD 3,392.70 116,861.86";
const RAW_BUY_META = "24/11/2025 34151 Bght 6 META:US @ 786.2644 SGD 4,717.59 112,144.27";
// ─── classifyTransactionType ──────────────────────────────────────────────────
describe("classifyTransactionType", () => {
    it("classifies BUY", () => {
        expect((0, transaction_1.classifyTransactionType)("Bght 10 AMZN:US @ 301.5441")).toBe("BUY");
    });
    it("classifies SELL", () => {
        expect((0, transaction_1.classifyTransactionType)("Sold 15 TXRH:US @ 220.9747")).toBe("SELL");
    });
    it("classifies DIVIDEND", () => {
        expect((0, transaction_1.classifyTransactionType)("JNL3959750 ASML:US Intl Div Ex:29/10/25")).toBe("DIVIDEND");
    });
    it("classifies DEPOSIT", () => {
        expect((0, transaction_1.classifyTransactionType)("Dep CHASSGSG 100000003011513")).toBe("DEPOSIT");
    });
    it("classifies WITHDRAWAL", () => {
        expect((0, transaction_1.classifyTransactionType)("Wdl CHASSGSG 100000003011513")).toBe("WITHDRAWAL");
    });
    it("returns UNKNOWN for unrecognised text", () => {
        expect((0, transaction_1.classifyTransactionType)("Some random text")).toBe("UNKNOWN");
    });
});
// ─── extractSymbol ────────────────────────────────────────────────────────────
describe("extractSymbol", () => {
    it("extracts AMZN from buy description", () => {
        expect((0, transaction_1.extractSymbol)("Bght 10 AMZN:US @ 301.5441")).toBe("AMZN");
    });
    it("extracts TXRH from sell description", () => {
        expect((0, transaction_1.extractSymbol)("Sold 15 TXRH:US @ 220.9747")).toBe("TXRH");
    });
    it("extracts ASML from dividend description", () => {
        expect((0, transaction_1.extractSymbol)("JNL3959750 ASML:US Intl Div Ex:29/10/25")).toBe("ASML");
    });
    it("returns null for deposit (no :US symbol)", () => {
        expect((0, transaction_1.extractSymbol)("Dep CHASSGSG 100000003011513")).toBeNull();
    });
    it("returns null for withdrawal", () => {
        expect((0, transaction_1.extractSymbol)("Wdl CHASSGSG 100000003011513")).toBeNull();
    });
});
// ─── extractQuantity ──────────────────────────────────────────────────────────
describe("extractQuantity", () => {
    it("extracts quantity 10 from AMZN buy", () => {
        expect((0, transaction_1.extractQuantity)("Bght 10 AMZN:US @ 301.5441")).toBe(10);
    });
    it("extracts quantity 22 from HOOD buy", () => {
        expect((0, transaction_1.extractQuantity)("Bght 22 HOOD:US @ 154.2137")).toBe(22);
    });
    it("extracts quantity 15 from TXRH sell", () => {
        expect((0, transaction_1.extractQuantity)("Sold 15 TXRH:US @ 220.9747")).toBe(15);
    });
    it("returns null for dividend (no Bght/Sold)", () => {
        expect((0, transaction_1.extractQuantity)("JNL3959750 ASML:US Intl Div Ex:29/10/25")).toBeNull();
    });
});
// ─── extractPrice ─────────────────────────────────────────────────────────────
describe("extractPrice", () => {
    it("extracts price 301.5441 from AMZN buy", () => {
        expect((0, transaction_1.extractPrice)("Bght 10 AMZN:US @ 301.5441")).toBe(301.5441);
    });
    it("extracts price 220.9747 from TXRH sell", () => {
        expect((0, transaction_1.extractPrice)("Sold 15 TXRH:US @ 220.9747")).toBe(220.9747);
    });
    it("extracts price 786.2644 from META buy", () => {
        expect((0, transaction_1.extractPrice)("Bght 6 META:US @ 786.2644")).toBe(786.2644);
    });
    it("returns null when no @ price present", () => {
        expect((0, transaction_1.extractPrice)("Dep CHASSGSG 100000003011513")).toBeNull();
    });
});
// ─── calculateAmount ──────────────────────────────────────────────────────────
describe("calculateAmount", () => {
    it("returns negative value for debit-only (outflow)", () => {
        expect((0, transaction_1.calculateAmount)(3015.44, null)).toBe(-3015.44);
    });
    it("returns positive value for credit-only (inflow)", () => {
        expect((0, transaction_1.calculateAmount)(null, 8.26)).toBe(8.26);
    });
    it("credit takes precedence over debit", () => {
        expect((0, transaction_1.calculateAmount)(100, 200)).toBe(200);
    });
    it("returns null when both are null", () => {
        expect((0, transaction_1.calculateAmount)(null, null)).toBeNull();
    });
});
// ─── parseRawRow ──────────────────────────────────────────────────────────────
describe("parseRawRow", () => {
    it("parses a BUY row correctly", () => {
        const result = (0, transaction_1.parseRawRow)(RAW_BUY_AMZN);
        expect(result).not.toBeNull();
        expect(result.date).toBe("18/11/2025");
        expect(result.reference).toBe("33784");
        expect(result.description).toContain("Bght 10 AMZN:US");
        expect(result.debit).toBe(3015.44);
    });
    it("parses a SELL row correctly", () => {
        const result = (0, transaction_1.parseRawRow)(RAW_SELL_TXRH);
        expect(result).not.toBeNull();
        expect(result.date).toBe("18/11/2025");
        expect(result.reference).toBe("33797");
        expect(result.description).toContain("Sold 15 TXRH:US");
    });
    it("parses a DIVIDEND row correctly", () => {
        const result = (0, transaction_1.parseRawRow)(RAW_DIVIDEND_ASML);
        expect(result).not.toBeNull();
        expect(result.date).toBe("10/11/2025");
        expect(result.reference).toBe("3959750");
    });
    it("returns null for empty string", () => {
        expect((0, transaction_1.parseRawRow)("")).toBeNull();
    });
    it("returns null for text with no date prefix", () => {
        expect((0, transaction_1.parseRawRow)("no date here")).toBeNull();
    });
});
// ─── parseTransactionRow (main entry point) ───────────────────────────────────
describe("parseTransactionRow — BUY", () => {
    it("parses AMZN buy from raw text", () => {
        const result = (0, transaction_1.parseTransactionRow)(RAW_BUY_AMZN, "statement.pdf");
        expect(result.ok).toBe(true);
        if (!result.ok)
            return;
        expect(result.transaction.type).toBe("BUY");
        expect(result.transaction.symbol).toBe("AMZN");
        expect(result.transaction.quantity).toBe(10);
        expect(result.transaction.price).toBe(301.5441);
        expect(result.transaction.date).toBe("2025-11-18");
        expect(result.transaction.id).toBe("33784");
        expect(result.transaction.source).toBe("statement.pdf");
    });
    it("parses HOOD buy from raw text", () => {
        const result = (0, transaction_1.parseTransactionRow)(RAW_BUY_HOOD, "statement.pdf");
        expect(result.ok).toBe(true);
        if (!result.ok)
            return;
        expect(result.transaction.type).toBe("BUY");
        expect(result.transaction.symbol).toBe("HOOD");
        expect(result.transaction.quantity).toBe(22);
        expect(result.transaction.price).toBe(154.2137);
    });
    it("parses META buy from raw text", () => {
        const result = (0, transaction_1.parseTransactionRow)(RAW_BUY_META, "statement.pdf");
        expect(result.ok).toBe(true);
        if (!result.ok)
            return;
        expect(result.transaction.type).toBe("BUY");
        expect(result.transaction.symbol).toBe("META");
        expect(result.transaction.quantity).toBe(6);
        expect(result.transaction.price).toBe(786.2644);
        expect(result.transaction.date).toBe("2025-11-24");
    });
});
describe("parseTransactionRow — SELL", () => {
    it("parses TXRH sell from raw text", () => {
        const result = (0, transaction_1.parseTransactionRow)(RAW_SELL_TXRH, "statement.pdf");
        expect(result.ok).toBe(true);
        if (!result.ok)
            return;
        expect(result.transaction.type).toBe("SELL");
        expect(result.transaction.symbol).toBe("TXRH");
        expect(result.transaction.quantity).toBe(15);
        expect(result.transaction.price).toBe(220.9747);
        expect(result.transaction.date).toBe("2025-11-18");
        expect(result.transaction.id).toBe("33797");
    });
});
describe("parseTransactionRow — DIVIDEND", () => {
    it("parses ASML dividend from raw text", () => {
        const result = (0, transaction_1.parseTransactionRow)(RAW_DIVIDEND_ASML, "statement.pdf");
        expect(result.ok).toBe(true);
        if (!result.ok)
            return;
        expect(result.transaction.type).toBe("DIVIDEND");
        expect(result.transaction.symbol).toBe("ASML");
        expect(result.transaction.quantity).toBeNull();
        expect(result.transaction.price).toBeNull();
        expect(result.transaction.date).toBe("2025-11-10");
    });
});
describe("parseTransactionRow — DEPOSIT", () => {
    it("parses deposit from raw text", () => {
        const result = (0, transaction_1.parseTransactionRow)(RAW_DEPOSIT, "statement.pdf");
        expect(result.ok).toBe(true);
        if (!result.ok)
            return;
        expect(result.transaction.type).toBe("DEPOSIT");
        expect(result.transaction.symbol).toBeNull();
        expect(result.transaction.quantity).toBeNull();
        expect(result.transaction.date).toBe("2025-11-10");
    });
});
describe("parseTransactionRow — WITHDRAWAL", () => {
    it("parses withdrawal from raw text", () => {
        const result = (0, transaction_1.parseTransactionRow)(RAW_WITHDRAWAL, "statement.pdf");
        expect(result.ok).toBe(true);
        if (!result.ok)
            return;
        expect(result.transaction.type).toBe("WITHDRAWAL");
        expect(result.transaction.symbol).toBeNull();
        expect(result.transaction.date).toBe("2025-11-18");
    });
});
describe("parseTransactionRow — error cases", () => {
    it("returns error for completely unparseable text", () => {
        const result = (0, transaction_1.parseTransactionRow)("not a valid row");
        expect(result.ok).toBe(false);
        if (result.ok)
            return;
        expect(result.error.reason).toContain("Could not parse row structure");
    });
    it("returns error for UNKNOWN transaction type", () => {
        const row = {
            date: "18/11/2025",
            reference: "99999",
            description: "Some unknown transaction",
            debit: 100,
            credit: null,
        };
        const result = (0, transaction_1.parseTransactionRow)(row);
        expect(result.ok).toBe(false);
        if (result.ok)
            return;
        expect(result.error.reason).toBe("UNKNOWN TRANSACTION TYPE");
    });
    it("returns error when BUY row is missing a symbol", () => {
        const row = {
            date: "18/11/2025",
            reference: "12345",
            description: "Bght 10 @ 100.00",
            debit: 1000,
            credit: null,
        };
        const result = (0, transaction_1.parseTransactionRow)(row);
        expect(result.ok).toBe(false);
        if (result.ok)
            return;
        expect(result.error.reason).toContain("MISSING SYMBOL FOR BUY");
    });
    it("returns error when both debit and credit are null", () => {
        const row = {
            date: "18/11/2025",
            reference: "12345",
            description: "Dep CHASSGSG ABC123",
            debit: null,
            credit: null,
        };
        const result = (0, transaction_1.parseTransactionRow)(row);
        expect(result.ok).toBe(false);
        if (result.ok)
            return;
        expect(result.error.reason).toContain("Could not determine amount");
    });
});
//# sourceMappingURL=transaction.test.js.map