# 03-ingestion.md

## Purpose

This document defines how raw input files (PDF/CSV) are parsed and converted into normalized system data.

The ingestion pipeline MUST:

* extract structured data from broker reports
* classify transactions correctly
* normalize all values into canonical formats
* handle overlapping and messy data safely

---

## Supported Inputs

### 1. Transaction Statement

* Source: CMC Invest trading account statement
* Format: PDF (tabular text)

Example: `samples/transaction_statement.pdf`

Refer to samples/Statement-785691-20251031-20260325.pdf for parsing format

---

### 2. Portfolio Report (Baseline)

* Source: CMC Invest portfolio report
* Format: PDF

Example: `samples/portfolio_report.pdf`

Refer to samples/PortfolioReport-785691-202604280541.pdf for baseline format

---

## General Ingestion Flow

```text id="flow1"
Raw File → Extract Text → Parse Rows → Classify → Normalize → Validate → Store
```

### Currency Semantics

**CMC Invest Transaction Statement (all in SGD)**:
- Debit / Credit columns: SGD (cash flow out of / into the account)
- Description prices (e.g. "@ 301.5441 SGD"): SGD as stated
- Deposits / Withdrawals: SGD amounts (in/out of linked SGD bank account)

**CMC Invest Portfolio Report**:
- Summary table: "Bank Balance" → SGD (cash balance)
- Equities table:
  - "Quantity": share count (unitless)
  - "Last Price": USD per share (e.g. "230.820USD")
  - "Average Cost SGD": SGD (historical, not used for pricing)
  - "Market Value SGD": SGD (calculated as Quantity × Last Price × FX)

**Internal System**:
- Portfolio holdings values computed in USD (quantity × price USD from Yahoo Finance or baseline)
- Cash flows (DEPOSIT/WITHDRAWAL) converted SGD → USD using USDSGD=X FX rate before TWR/IRR
- Display: user can toggle between USD and SGD (multiply by current rate)

---

## 1. Transaction Parsing

### Input Format Characteristics

Each row contains:

* Date
* Reference ID
* Description (free text)
* Debit
* Credit
* Balance

Example:

```text id="tx_example"
18/11/2025 33784 Bght 10 AMZN:US @ 301.5441 SGD 3,015.44
```

---

## Step 1 — Extract Fields

For each row:

```ts id="extract_fields"
{
  date: string
  reference: string
  description: string
  debit: number | null
  credit: number | null
}
```

---

## Step 2 — Classify Transaction Type

Use explicit string matching on `description`.

### Rules

```ts id="classification_rules"
if description.includes("Bght") → type = "BUY"
if description.includes("Sold") → type = "SELL"
if description.includes("Intl Div") → type = "DIVIDEND"
if description.includes("Dep CHASSGSG") → type = "DEPOSIT"
if description.includes("Wdl CHASSGSG") → type = "WITHDRAWAL"
if description.includes("SPLIT") → type = "SPLIT"
```

### Notes

* Matching must be case-sensitive and explicit
* Do NOT attempt fuzzy matching
* If no rule matches → mark as UNKNOWN and log error

---

## Step 3 — Extract Symbol

Symbols appear in format:

```text id="symbol_example"
AMZN:US
```

Extraction rule:

```ts id="symbol_rule"
Find token matching pattern: [A-Z]+:US
```

* Strip suffix `:US` → store as `AMZN`
* If no symbol found:

  * allowed for DEPOSIT/WITHDRAWAL
  * error for BUY/SELL/DIVIDEND/SPLIT

---

## Step 4 — Extract Quantity

For BUY/SELL:

```text id="qty_example"
Bght 10 AMZN:US
Sold 15 TXRH:US
```

Rule:

```ts id="qty_rule"
Extract number immediately after "Bght" or "Sold"
```

---

## Step 5 — Extract Price

For BUY/SELL:

```text id="price_example"
@ 301.5441 SGD
```

Rule:

```ts id="price_rule"
Extract number after "@"
```

* Store as-is (parsed from statement; CMC Invest quotes this in SGD)
* **Note**: This is the transaction's historical cost basis (SGD), not the current USD price
* For portfolio valuation: use Yahoo Finance prices in USD instead (via pricing.ts)

---

## Step 6 — Determine Amount

Use Debit/Credit columns:

```ts id="amount_rule"
if credit != null → amount = +credit  // inflow in SGD
if debit != null → amount = -debit    // outflow in SGD
```

**All amounts are in SGD** from the CMC statement

---

## Step 7 — Create Normalized Transaction

```ts id="normalized_tx"
{
  id: reference,
  date: parsed_date,
  type,
  symbol,
  quantity,
  price,           // in SGD (from statement)
  amount,          // in SGD (from debit/credit)
  source: filename
}
```

### Stock Split Parsing

Broker statements may contain stock split rows such as:

```text
STOCK SPLIT VGT:US 8:1
Stock Split 1 for 20 ABCD:US
```

Rules:

* classify as `SPLIT`
* extract symbol using the same `[A-Z]+:US` rule
* extract ratio from either:

  * `X:Y`
  * `X for Y`
  * `X to Y`
* normalize to `splitRatio = X / Y`
* set:

  * `quantity = null`
  * `price = null`
  * `amount = 0`

---

## Market-Sourced Split Enrichment

Broker files are not the only source of split events.

During reconstruction and valuation, the backend also fetches stock split history from Yahoo Finance using:

```ts
yahooFinance.historical(symbol, {
  period1,
  period2,
  events: "split"
})
```

Returned values look like:

```ts
{ date: Date, stockSplits: "8:1" }
```

These events are converted into normalized `SPLIT` transactions and merged into the post-baseline stream.

Rules:

* market split enrichment happens before reconstruction
* split events from Yahoo Finance and broker statements must not be double-counted
* fetched split events are best-effort; failure to fetch must not break the request

---

## Step 8 — Deduplication

Before storing:

```ts id="dedup_rule"
if transaction.id already exists → ignore new transaction
```

---

## Important Rules

### Deposits / Withdrawals

Lines like:

```text id="deposit_example"
Dep CHASSGSG         (Deposit to linked SGD account)
Wdl CHASSGSG         (Withdrawal from linked SGD account)
```

* Represent cash movement **in SGD** only
* MUST NOT be counted as performance (no price impact)
* MUST still update cash balance
* **Amount is in SGD** (from debit/credit columns)
* Later: convert SGD → USD using FX rates before TWR/IRR calculations

---

### Dividends

Lines like:

```text id="div_example"
ASML:US Intl Div      (International dividend paid in SGD)
```

* MUST be classified as DIVIDEND
* MUST increase cash **in SGD**
* MUST be included in performance
* **Amount is in SGD** (from credit column)

---

### FX / Settlement Lines

Lines like:

```text id="fx_example"
Wdl CHASSGSG ... (FX)   (withdrawal with FX settlement)
```

* Represent internal settlement of trading-related cash
* Treat as WITHDRAWAL
* Do NOT attempt FX conversion logic (already settled by CMC)

---

## 2. Portfolio Report Parsing (Baseline)

### Input Format

**CMC Invest Portfolio Report** has two sections:

#### Summary Table (all SGD)
```
Description                        Market Value (SGD)
Shares                                       193,304.20
Bank Balance                                   5,890.15
Total                                        199,194.35
```

#### Equities Report Table (mixed currencies)
```
Security   Quantity   Last Price      Cost       Market Value  ...
code                                 SGD        Value SGD
AMZN:US    128        230.820USD                 37,813.063
ASML:US    4          1,069.860USD               5,477.033
```

**Column currencies**:
- "Quantity": unitless (share count)
- "Last Price": USD (e.g. "230.820USD")
- "Cost SGD": SGD (historical cost, not used for current valuation)
- "Market Value SGD": SGD (calculated by CMC: Quantity × Last Price USD × USDSGD FX)

---

## Step 1 — Extract Holdings

For each row in Equities Report:

```ts id="baseline_holdings"
holdings[symbol] = quantity
```

Rules:

* Strip `:US`
* Ignore rows with zero quantity

---

## Step 2 — Extract Cash

From Summary section:

```text id="cash_example"
Bank Balance 5,890.15
```

```ts id="cash_rule"
cash = parsed value (SGD)
```

**Note**: Cash is in SGD (Singapore Dollar, the account currency)

---

## Step 3 — Extract Holding Prices

From Equities Report, extract "Last Price" (USD):

```text id="price_example"
AMZN:US ... 230.820USD
ASML:US ... 1,069.860USD
```

```ts id="price_rule"
prices[symbol] = parsed USD value (strip "USD" suffix)
```

**Note**: These are USD prices from Yahoo Finance via CMC's feed. Used only for baseline snapshot; prefer live Yahoo Finance prices for post-baseline valuation.

---

## Step 4 — Extract Date

From header:

```text id="date_example"
At Close of Trading Day: 01/01/2026
```

Convert to ISO format.

---

## Step 5 — Create Baseline Object

```ts id="baseline_obj"
{
  id: generated_id,
  date,           // ISO: YYYY-MM-DD
  holdings,       // symbol → share count (unitless)
  holdingPrices,  // symbol → USD price
  cash,           // SGD (from Bank Balance)
  source: filename
}
```

---

## 3. Validation

After parsing:

### Transaction Validation

* id must exist
* date must be valid
* type must be known
* amount must be number (SGD)

### Baseline Validation

* date must exist
* holdings must be non-negative
* cash must be >= 0 (SGD)
* holdingPrices (if present) must be positive numbers (USD)

---

## 4. Error Handling

If parsing fails:

* Do NOT silently ignore
* Log error with:

  * row content
  * reason
  * currency context (where applicable)

Examples:

```text id="error1"
UNKNOWN TRANSACTION TYPE
MISSING SYMBOL FOR BUY
INVALID DATE FORMAT
MISSING CASH VALUE (defaults to 0)
```

---

## 5. Assumptions

* **Transaction amounts are in SGD** (from CMC statement debit/credit)
* **Baseline cash is in SGD** (from CMC summary "Bank Balance")
* **Baseline prices are in USD** (from CMC equities "Last Price" column)
* Baseline "Market Value SGD" is CMC's calculation; we recompute in USD post-baseline
* No OCR (assume text-extractable PDFs)
* Statements may overlap in time
* Transaction IDs are unique per statement
* FX conversion (SGD ↔ USD) happens **after** parsing, during calculation

---

## 6. FX Conversion (Post-Parsing)

After transactions and baselines are parsed:

* DEPOSIT/WITHDRAWAL `amount` (SGD) → USD using `USDSGD=X` historical rates
  * Formula: `amount_usd = amount_sgd / usd_sgd_rate`
  * Applied before TWR/IRR calculations
  * Ensures performance metrics are in a single currency
* Display layer: user toggles USD ↔ SGD by multiplying holdings_value_usd × current_fx_rate

---

## 7. Non-Goals

* No support for multiple brokers (CMC Invest Singapore only)
* No automatic correction of malformed data
* No currency detection (currency is fixed per field in CMC reports)

---

## Guiding Principle

Parsing must be:

> **deterministic, explicit, and debuggable**
> with **clear currency labeling at every step**

Every parsed value should be traceable back to:

* original PDF row and column
* currency (SGD or USD)
* classification rule used
