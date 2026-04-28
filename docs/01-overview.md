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

Transactions may be:

* incomplete
* overlapping across uploads
* partially redundant

---

### 3. State Reconstruction

The system reconstructs portfolio state by:

1. Starting from a baseline
2. Applying all transactions AFTER the baseline date

This produces:

* holdings over time
* cash balance over time

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

1. User uploads baseline
2. User uploads transaction files
3. System parses and normalizes data
4. System reconstructs portfolio state
5. System computes:

   * portfolio value
   * performance metrics
6. User may upload a new baseline
7. System performs reconciliation

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

---

## Assumptions

* User provides at least one valid baseline
* Transaction data may be incomplete
* Market price data will be sourced separately (not from broker reports)

---

## Guiding Principle

This system prioritizes:

> **correctness and transparency over automation**

If data is inconsistent:

* the system must surface it
* the user must be able to understand and resolve it
