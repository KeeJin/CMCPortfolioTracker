# 01-overview.md

## Purpose

This application is a personal portfolio tracking tool.

It allows a user to:

* Upload a **baseline portfolio snapshot** (from broker report)
* Upload **transaction statements** (possibly overlapping)
* Reconstruct portfolio state over time
* Track performance (returns, value, etc.)
* Reconcile inconsistencies between data sources

The system is designed to work **without full historical data**, using a combination of:

* snapshots (baselines)
* incremental transaction data

---

## Core Concepts

### 1. Baseline

A **baseline** is a snapshot of the portfolio at a specific date.

It includes:

* holdings (ticker → share count)
* cash balance

A baseline is treated as:

> **authoritative ground truth at that point in time**

---

### 2. Transactions

Transactions are events that modify the portfolio.

Types:

* BUY → increases shares, decreases cash
* SELL → decreases shares, increases cash
* DIVIDEND → increases cash (counts as return)
* DEPOSIT → increases cash (NOT performance)
* WITHDRAWAL → decreases cash (NOT performance)
* SPLIT → changes share count without changing cash

Transactions may be:

* incomplete
* overlapping across uploads
* partially redundant

---

### 3. State Reconstruction

The system reconstructs portfolio state by:

1. Starting from the latest authoritative baseline, if one exists
2. Enriching the post-baseline transaction stream with known market stock splits
3. Applying all transactions AFTER that baseline date

If no baseline exists yet, the system must still reconstruct state using:

1. a synthetic zero-state anchor
2. all uploaded transactions in chronological order

This produces:

* holdings over time
* cash balance over time

Stock splits may come from two sources:

* parsed broker statement rows
* Yahoo Finance corporate action history

If the same split exists in both sources, it must only be applied once.

---

### 4. Overlapping Data Handling

Transaction files may overlap in time.

Rules:

* Transactions must be **deduplicated using unique IDs**
* Duplicate transactions must NOT be applied twice

---

### 5. Reconciliation

When a new baseline is uploaded:

1. The system reconstructs expected holdings using:
   previous baseline + transactions

2. It compares this with the new baseline

3. If there is a mismatch:

   * small → warn user
   * large → require user decision

The system must NEVER silently ignore mismatches.

---

## System Model

The system operates using three layers:

### 1. Snapshot Layer

* Stores baselines (portfolio snapshots)

### 2. Event Layer

* Stores normalized transactions

### 3. Derived State Layer

* Computes holdings and cash over time

---

## Data Flow

Uploads are **actions**, not steps in a required sequence.

The user may:

* upload transactions before any baseline
* upload multiple baselines over time
* upload baselines and transactions in any order

After each action, the system:

1. parses and normalizes data
2. records the action in history
3. reconstructs current portfolio state
4. computes:

   * portfolio value
   * performance metrics
5. performs reconciliation when a new baseline has an earlier baseline to compare against

---

## Key Design Principles

* Baselines are **source of truth**
* Transactions are **incremental updates**
* The system must be:

  * deterministic
  * transparent
  * debuggable

---

## Non-Goals

This application does NOT aim to:

* provide real-time trading data
* integrate directly with broker APIs
* handle tax reporting in detail
* support multiple users or authentication

---

## Expected Outputs

The system should support:

* Current portfolio holdings
* Historical portfolio value (daily or periodic)
* Performance metrics:

  * time-weighted return (TWR)
  * money-weighted return (IRR)
* Reconciliation reports:

  * differences between expected and actual holdings
* Position-level market values for the current portfolio table

---

## Assumptions

* Transaction data may be incomplete
* Market price data will be sourced separately (not from broker reports)

The system should behave correctly whether the user uploads:

* transactions only
* baselines only
* baselines and transactions interleaved over time

---

## Guiding Principle

This system prioritizes:

> **correctness and transparency over automation**

If data is inconsistent:

* the system must surface it
* the user must be able to understand and resolve it

---

## Data Persistence

All user data (baselines, transactions, upload history) is persisted to disk in the `backend/data/` directory as JSON files:

* `baselines.json` → all stored baselines
* `transactions.json` → all deduplicated transactions
* `uploads.json` → upload action history

The store is loaded at server startup via `initStore()` and written to disk automatically after every mutation. Restarting the server does **not** wipe any user data.

---

## Price Cache

Historical and live price data fetched from external APIs (Yahoo Finance) is cached in `backend/data/price-cache.json`.

* **Historical prices** (past dates) are cached indefinitely — they do not change.
* **Live (today's) prices** are cached with a 15-minute TTL.

On a cache hit the route skips the external API call entirely. On a miss the data is fetched, stored in the cache, and flushed to disk.

---

## Eager Loading

On server startup, after user data is loaded, the backend kicks off a background prefetch:

1. Reconstructs current holdings from the latest baseline + transactions.
2. Fetches 5 years of daily price history for all active holdings from Yahoo Finance.
3. Stores the result in the price cache.

This means that by the time a user visits the dashboard, price data for **all** available timeframes (5d → 5y) is already in the cache and served instantly without waiting for external API calls.
