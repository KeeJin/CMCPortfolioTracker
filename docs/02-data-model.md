# 02-data-model.md

## Purpose

This document defines the canonical data structures used throughout the system.

All ingestion, processing, and API layers MUST conform to these models.

---

## Design Principles

* Use **simple, explicit structures**
* Avoid deeply nested or overly abstract schemas
* Prefer flat, predictable objects
* All financial values are stored as **numbers in SGD**
* Dates are stored as **ISO strings (YYYY-MM-DD)**

---

## 1. Baseline

A baseline represents a snapshot of the portfolio at a specific date.

```ts
type Baseline = {
  id: string
  date: string // ISO format: YYYY-MM-DD

  holdings: Record<string, number> // symbol → share count

  cash: number // total cash balance (SGD)

  source?: string // optional (e.g. filename)
}
```

### Notes

* `holdings` must NOT contain zero or negative values
* Missing symbols imply zero holdings
* Baseline is treated as **ground truth**

---

## 2. Transaction

Represents a single financial event.

```ts
type TransactionType =
  | "BUY"
  | "SELL"
  | "DIVIDEND"
  | "DEPOSIT"
  | "WITHDRAWAL"

type Transaction = {
  id: string // unique transaction reference (from broker)

  date: string // ISO format: YYYY-MM-DD

  type: TransactionType

  symbol?: string // required for BUY/SELL/DIVIDEND

  quantity?: number // required for BUY/SELL

  price?: number // per-share price (SGD, if available)

  amount: number // total cash impact (SGD)

  rawDescription?: string // original text from statement
  source?: string // filename or upload batch
}
```

### Rules

* `id` MUST be unique → used for deduplication
* `amount` is always:

  * positive for inflows (SELL, DIVIDEND, DEPOSIT)
  * negative for outflows (BUY, WITHDRAWAL)
* `symbol` is:

  * required for BUY / SELL / DIVIDEND
  * null/undefined for DEPOSIT / WITHDRAWAL

---

## 3. Normalized Transaction

After parsing, all transactions MUST conform to a normalized format:

```ts
type NormalizedTransaction = {
  id: string
  date: string
  type: TransactionType

  symbol: string | null

  quantity: number | null
  price: number | null

  amount: number

  source: string
}
```

### Notes

* All optional fields are explicitly set to `null` if not applicable
* No undefined values allowed after normalization

---

## 4. Portfolio State

Represents the reconstructed portfolio at a point in time.

```ts
type PortfolioState = {
  date: string

  holdings: Record<string, number>

  cash: number
}
```

---

## 5. Time Series Point

Used for performance tracking and charting.

```ts
type PortfolioValuePoint = {
  date: string

  totalValue: number // holdings + cash

  holdingsValue: number
  cash: number
}
```

---

## 6. Reconciliation Result

Represents comparison between expected and actual baseline.

```ts
type ReconciliationDiff = {
  symbol: string
  expected: number
  actual: number
  difference: number
}

type ReconciliationResult = {
  baselineDate: string

  status: "MATCH" | "MINOR_MISMATCH" | "MAJOR_MISMATCH"

  holdingDiffs: ReconciliationDiff[]

  cashDiff: number

  notes?: string[]
}
```

---

## 7. Upload Metadata (Optional but Recommended)

Tracks uploaded files.

```ts
type Upload = {
  id: string
  type: "BASELINE" | "TRANSACTIONS"

  filename: string
  uploadedAt: string

  dateRange?: {
    start: string
    end: string
  }
}
```

---

## 8. Derived Rules

### Transaction Application

When applying a transaction:

* BUY:

  * increase holdings[symbol]
  * decrease cash

* SELL:

  * decrease holdings[symbol]
  * increase cash

* DIVIDEND:

  * increase cash

* DEPOSIT:

  * increase cash (NOT performance)

* WITHDRAWAL:

  * decrease cash (NOT performance)

---

### Deduplication

Transactions MUST be deduplicated using:

```ts
unique key = transaction.id
```

If duplicate:

* ignore the new transaction

---

### Ordering

Transactions MUST be processed in:

```ts
ascending order by date
```

If same date:

* preserve original order

---

## 9. Validation Rules

### Baseline Validation

* date must exist
* holdings must be non-negative
* cash must be >= 0

---

### Transaction Validation

* id must exist
* date must exist
* type must be valid
* amount must be a number

Additional:

* BUY/SELL:

  * symbol required
  * quantity > 0

* DIVIDEND:

  * symbol required

---

## 10. Important Constraints

* System MUST NOT assume complete transaction history
* System MUST support partial data
* System MUST tolerate overlapping uploads
* System MUST NOT double-count transactions
* System MUST NOT silently modify data

---

## Guiding Principle

All computations in the system must be based on:

> **Baseline + Ordered, Deduplicated Transactions**

No hidden state or implicit assumptions allowed.
