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
  * error for BUY/SELL/DIVIDEND

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

* Store as SGD price (already converted in statement)

---

## Step 6 — Determine Amount

Use Debit/Credit columns:

```ts id="amount_rule"
if credit != null → amount = +credit
if debit != null → amount = -debit
```

---

## Step 7 — Create Normalized Transaction

```ts id="normalized_tx"
{
  id: reference,
  date: parsed_date,
  type,
  symbol,
  quantity,
  price,
  amount,
  source: filename
}
```

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
Dep CHASSGSG
Wdl CHASSGSG
```

* Represent cash movement ONLY
* MUST NOT be counted as performance
* MUST still update cash balance

---

### Dividends

Lines like:

```text id="div_example"
ASML:US Intl Div
```

* MUST be classified as DIVIDEND
* MUST increase cash
* MUST be included in performance

---

### FX / Settlement Lines

Lines like:

```text id="fx_example"
Wdl CHASSGSG ... (FX)
```

* Represent internal settlement
* Treat as WITHDRAWAL
* Do NOT attempt FX conversion logic

---

## 2. Portfolio Report Parsing (Baseline)

### Input Format

Table with:

* Symbol
* Quantity
* Market Value
* Other metadata

Example:

```text id="baseline_example"
AMZN:US ... Quantity: 128
NVDA:US ... Quantity: 222
```

---

## Step 1 — Extract Holdings

For each row:

```ts id="baseline_holdings"
holdings[symbol] = quantity
```

Rules:

* Strip `:US`
* Ignore rows with zero quantity

---

## Step 2 — Extract Cash

From summary section:

```text id="cash_example"
Bank Balance 5,890.15
```

```ts id="cash_rule"
cash = parsed value
```

---

## Step 3 — Extract Date

From header:

```text id="date_example"
At Close of Trading Day: 01/01/2026
```

Convert to ISO format.

---

## Step 4 — Create Baseline Object

```ts id="baseline_obj"
{
  id: generated_id,
  date,
  holdings,
  cash,
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
* amount must be number

### Baseline Validation

* date must exist
* holdings must be non-negative
* cash must be >= 0

---

## 4. Error Handling

If parsing fails:

* Do NOT silently ignore
* Log error with:

  * row content
  * reason

Examples:

```text id="error1"
UNKNOWN TRANSACTION TYPE
MISSING SYMBOL FOR BUY
INVALID DATE FORMAT
```

---

## 5. Assumptions

* All values are already in SGD
* No need for FX conversion
* Statements may overlap in time
* Transaction IDs are unique

---

## 6. Non-Goals

* No OCR (assume text-extractable PDFs)
* No support for multiple brokers
* No automatic correction of malformed data

---

## Guiding Principle

Parsing must be:

> **deterministic, explicit, and debuggable**

Every parsed transaction should be traceable back to:

* original row
* classification rule used
