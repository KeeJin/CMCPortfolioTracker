# 04-reconciliation.md

## Purpose

This document defines how the system validates consistency between:

* reconstructed portfolio state (from transactions), and
* newly uploaded baseline snapshots

Reconciliation ensures that the system remains **accurate and trustworthy**, even when data is incomplete or overlapping.

---

## Core Concept

At any point in time:

```text id="core_equation"
expected_state = previous_baseline + all_transactions_after_baseline
```

When a new baseline is uploaded:

```text id="comparison"
expected_state (reconstructed) vs actual_state (new baseline)
```

---

## When Reconciliation Happens

Reconciliation MUST be triggered when:

* a new baseline is uploaded
* AND there exists:

  * a previous baseline
  * AND transactions between the two baselines

---

## Step-by-Step Process

### Step 1 — Identify Relevant Time Window

Given:

* Baseline A (older)
* Baseline B (new)

```text id="time_window"
Use transactions where:
baseline_A.date < transaction.date ≤ baseline_B.date
```

---

### Step 2 — Reconstruct Expected State

Start from Baseline A:

```ts id="initial_state"
state = {
  holdings: copy(baseline_A.holdings),
  cash: baseline_A.cash
}
```

Apply transactions in **ascending date order**:

```ts id="apply_loop"
for (tx of transactions_sorted_by_date) {
  applyTransaction(state, tx)
}
```

This produces:

```ts id="expected_state"
expected_state = state
```

---

### Step 3 — Compare Holdings

For each symbol in either:

* expected_state.holdings
* baseline_B.holdings

Compute:

```ts id="holding_diff"
expected = expected_state.holdings[symbol] || 0
actual   = baseline_B.holdings[symbol] || 0

difference = actual - expected
```

Store only non-zero differences.

---

### Step 4 — Compare Cash

```ts id="cash_diff"
cash_difference = baseline_B.cash - expected_state.cash
```

---

### Step 5 — Determine Status

Define thresholds:

```ts id="thresholds"
MINOR_SHARE_DIFF = 1
MINOR_CASH_DIFF = 1.00 // SGD
```

---

### Status Logic

#### MATCH

```ts id="match_rule"
All holding differences == 0
AND abs(cash_difference) == 0
```

---

#### MINOR_MISMATCH

```ts id="minor_rule"
All holding differences ≤ MINOR_SHARE_DIFF
AND abs(cash_difference) ≤ MINOR_CASH_DIFF
```

---

#### MAJOR_MISMATCH

```ts id="major_rule"
Anything exceeding minor thresholds
```

---

## Output Structure

```ts id="recon_result"
{
  baselineDate: string,

  status: "MATCH" | "MINOR_MISMATCH" | "MAJOR_MISMATCH",

  holdingDiffs: [
    {
      symbol: string,
      expected: number,
      actual: number,
      difference: number
    }
  ],

  cashDiff: number,

  notes: string[]
}
```

---

## Handling Outcomes

### Case 1 — MATCH

* Accept new baseline
* Mark as verified checkpoint
* No user action required

---

### Case 2 — MINOR_MISMATCH

* Accept new baseline
* Show warning to user
* Add note:

```text id="minor_note"
"Minor discrepancy detected. Likely due to rounding or missing small transactions."
```

---

### Case 3 — MAJOR_MISMATCH

System MUST NOT silently accept or reject.

User must choose:

---

#### Option A — Accept New Baseline (Recommended Default)

* Treat new baseline as authoritative
* Reset internal state from this baseline
* Keep historical transactions for reference

---

#### Option B — Reject New Baseline

* Ignore new baseline
* Continue using previous state

---

#### Option C — Manual Investigation (Optional)

* Show detailed diffs
* Allow user to identify missing transactions

---

## Important Rules

### 1. Baseline is Source of Truth

If conflict exists:

> baseline data overrides reconstructed data

---

### 2. No Silent Corrections

* Do NOT auto-adjust holdings or cash
* Always surface discrepancies

---

### 3. Deterministic Behavior

Given the same:

* baseline A
* transaction set

The reconstructed state MUST always be identical

---

### 4. Transaction Deduplication Must Be Applied First

Before reconciliation:

```ts id="dedup_required"
transactions = deduplicated_transactions
```

---

## Edge Cases

### Missing Transactions

Cause:

* user did not upload full history

Effect:

* expected_state ≠ baseline_B

Handling:

* flagged as mismatch
* resolved via user decision

---

### Corporate Actions (e.g. stock splits)

Effect:

* large share differences

Handling:

* treated as MAJOR_MISMATCH
* user must accept new baseline

---

### Overlapping Transaction Uploads

Effect:

* potential double counting

Prevention:

* deduplication by transaction.id

---

### Same-Day Transactions and Baseline

Rule:

```text id="same_day_rule"
Transactions on baseline_B.date MUST be included
```

---

## Debugging Support

System SHOULD provide:

* list of transactions used in reconstruction
* per-symbol breakdown of differences
* ability to trace:
  transaction → state change → final result

---

## Logging

On every reconciliation:

Log:

```ts id="log_format"
{
  baselineA: date,
  baselineB: date,
  transactionCount: number,
  status: string
}
```

---

## Guiding Principle

Reconciliation is not just validation.

It is a mechanism to ensure:

> **the system never silently drifts away from reality**
