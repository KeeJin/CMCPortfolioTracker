# 07-ui-behavior.md

## Purpose

This document defines how the frontend behaves and interacts with the backend API.

It focuses on:

* user flows
* UI states
* data presentation rules

NOT on visual design or styling details.

---

## Core Principles

* UI reflects backend state (no hidden logic)
* Always show source of truth (baseline + transactions)
* Surface warnings explicitly (never hide inconsistencies)
* Prefer clarity over aesthetics

---

## 1. Main Views

The application consists of 3 primary views:

---

### 1. Upload View

Purpose:

* ingest new data into the system

---

#### Components

* Upload Baseline
* Upload Transactions
* Upload Status

---

#### Behavior

##### Upload Baseline

* User selects file
* Sends `POST /api/baseline`
* On success:

  * show baseline date
  * show reconciliation result

---

##### Upload Transactions

* User selects file
* Sends `POST /api/transactions`
* On success:

  * show:

    * number of transactions imported
    * number of duplicates ignored
    * parsing errors (if any)

---

#### Error Handling

If upload fails:

Display:

```text
Upload failed: <error message>
```

---

## 2. Portfolio View

Purpose:

* display current portfolio state

---

### Data Source

```http
GET /api/portfolio
```

---

### Display

* Baseline date
* Number of transactions applied
* Holdings (symbol + quantity)
* Cash balance

---

### Warnings

If response contains:

```json
warnings: [...]
```

Display prominently:

* negative holdings
* any other anomalies

---

### Behavior Rules

* Do NOT compute anything in frontend
* Display values exactly as returned
* Sort holdings alphabetically by symbol

---

## 3. Performance View

Purpose:

* visualize portfolio performance over time

---

### Data Source

```http
GET /api/portfolio/value
```

---

### Display

#### Summary Metrics

* Total Value
* Total Return
* TWR
* IRR

---

#### Time Series Chart

Plot:

* portfolio total value over time

---

### Pricing Method Disclosure

Always display:

```text
Pricing Method: transaction_price_history_forward_fill
```

---

#### Explanation Tooltip

```text
Prices are derived from your transaction history and forward-filled.
Portfolio value may appear flat between trades.
```

---

### Missing Price Data

If response contains:

```json
missingPriceSymbols: [...]
```

Display warning:

```text
Missing price data for: <symbols>
```

---

## 4. Reconciliation Feedback

If baseline upload returns reconciliation:

---

### MATCH

Display:

```text
Portfolio verified successfully.
```

---

### MINOR_MISMATCH

Display:

```text
Minor discrepancies detected (likely rounding or small gaps).
```

---

### MAJOR_MISMATCH

Display:

```text
Significant mismatch detected between expected and actual holdings.
```

---

#### Additional Details

* list symbol differences
* show expected vs actual values
* show cash difference

---

#### User Action (optional future)

* Accept new baseline
* Reject new baseline

---

## 5. Loading States

All API calls must show loading state:

```text
Loading...
```

---

## 6. Empty States

### No Baseline

```text
No baseline uploaded yet.
Please upload a portfolio report to begin.
```

---

### No Transactions

```text
No transactions uploaded.
Portfolio reflects baseline only.
```

---

## 7. Error States

All API errors should be displayed as:

```text
Error: <message>
```

---

## 8. Data Consistency Rules

Frontend must NOT:

* recompute portfolio values
* modify transaction data
* infer missing values

Frontend must:

* trust backend responses fully
* display raw values as-is

---

## 9. Navigation (Simple)

Tabs or sections:

* Upload
* Portfolio
* Performance

---

## 10. Future Extensions (Not Required Now)

* Benchmark comparison (e.g. S&P 500)
* Price provider switch (real market data vs transaction-based)
* Transaction history table
* Manual data correction UI

---

## Guiding Principle

The UI should make it easy to answer:

> “What do I own, what is it worth, and can I trust these numbers?”
