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
* Uploads are actions, not a required sequence
* The dashboard should feel polished, calm, and modern without hiding state

---

## 1. Main Views

The application is a single dashboard with 4 persistent areas:

---

### 1. Action Panel

Purpose:

* ingest new data into the system at any time

---

#### Components

* Add Baseline action card
* Add Transactions action card
* Inline action result / error states

---

#### Behavior

##### Add Baseline

* User selects file
* Sends `POST /api/baseline`
* File is uploaded as multipart form-data
* On success:

  * show baseline date
  * show reconciliation result

---

##### Add Transactions

* User selects file
* Sends `POST /api/transactions`
* File is uploaded as multipart form-data
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

### Sequence Rule

The UI must NOT imply:

* baseline first, transactions second
* transactions are invalid before a baseline exists
* only one baseline matters

The UI must instead present uploads as independent actions that modify the overall portfolio history.

---

## 2. Current State Panel

Purpose:

* display current portfolio state

---

### Data Source

```http
GET /api/portfolio
```

---

### Display

* Anchor mode (`BASELINE` or `TRANSACTIONS_ONLY`)
* Baseline date
* Number of transactions applied
* Total baselines stored
* Total transactions stored
* Holdings table with:

  * symbol
  * quantity
  * latest position value
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
* Quantity must come from `GET /api/portfolio` reconstructed holdings state
* Position value must come from `GET /api/portfolio/value` `positionValues[symbol]`
* If a market split changed holdings, the updated quantity must be shown without frontend adjustment logic
* User can sort the holdings table by symbol, quantity, or position value
* Re-clicking the active column toggles ascending/descending order

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

Behavior:

* Holdings Value card is selectable and switches the chart to holdings mode
* TWR card is selectable and switches the chart to TWR mode
* Total Return and IRR are summary-only cards

---

#### Time Series Chart

Plot one of:

* holdings value over time
* cumulative TWR over time

Chart mode depends on the selected metric card.

---

### Pricing Method Disclosure

Always display:

```text
Pricing Method: <active pricing source>
```

---

#### Explanation Tooltip

```text
Prices are derived from the selected pricing source.
Yahoo Finance mode also enriches the portfolio with stock split history before calculating holdings and value.
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

If `positionValues[symbol]` is missing for a holding, display `—` in the value column.

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

## 5. History / Lineage View

Purpose:

* show how portfolio state has been built over time
* make uploads feel like a timeline of actions rather than a wizard

### Data Source

```http
GET /api/portfolio/history
```

### Display

* action timeline in reverse chronological order
* chronological list of baselines
* active anchor type and date
* upload metadata:

  * filename / source
  * upload timestamp
  * coverage range when available
  * reconciliation status for baseline actions
  * imported / duplicate / parse error counts for transaction actions

### UX Goal

The history panel should feel closer to a lightweight git graph than a checklist.
It should help the user understand:

* what happened
* when it happened
* which baseline currently anchors reconstruction

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
