# AGENTS.md

## Purpose

This file defines strict rules and constraints for AI agents (e.g. GitHub Copilot Agent Mode) when working in this repository.

Agents MUST follow these rules.
Agents MUST NOT introduce new technologies, frameworks, or assumptions outside this specification unless explicitly instructed.

---

## Tech Stack (STRICT)

### Frontend

* React (functional components + hooks only)
* Vite (build tool)
* Tailwind CSS (styling)

### Backend

* Node.js
* Express (lightweight REST API)

### Language

* TypeScript (preferred)
* If TypeScript is used, use it consistently across frontend and backend

---

## Project Structure

Maintain this structure:

/frontend → React app (Vite)
/backend → Express server
/docs → system design documents
/samples → sample input files (PDF/CSV)

Keep frontend and backend clearly separated.

---

## Architecture Principles

* Keep the system simple and local-first
* Further improvements might involve uploading the database to some endpoint like gdrive or s3, so that I can sync up across different devices
* Use REST APIs (no RPC / GraphQL)
* Avoid over-engineering
* Prefer explicit logic over abstraction
* Keep functions small and readable
* Follow the best practices to write modern code

---

## Core Domain Rules

### Data Concepts

* Baseline = snapshot of holdings at a specific date
* Transactions = events (buy, sell, dividend, deposit, withdrawal)
* State = derived portfolio over time

---

### Transaction Rules

Transactions MUST be classified into:

* BUY
* SELL
* DIVIDEND
* DEPOSIT
* WITHDRAWAL

Rules:

* Deduplicate transactions using unique transaction ID
* Do NOT double-count overlapping uploads
* Deposits/withdrawals are NOT performance
* Dividends ARE performance

---

### Baseline Rules

* Baselines are authoritative snapshots
* Transactions are ONLY applied AFTER baseline date
* A new baseline triggers reconciliation

---

### Reconciliation Rules

When a new baseline is added:

1. Reconstruct expected holdings from:
   previous baseline + transactions

2. Compare with new baseline

3. Handle cases:

* Exact match → accept
* Small mismatch → warn
* Large mismatch → allow user to:

  * accept new baseline as truth
  * reject new baseline

Never silently override discrepancies.

---

## Data Handling Rules

* Do NOT assume clean or complete data
* Always validate parsed inputs
* Handle missing fields gracefully
* Never silently discard data
* Log or surface inconsistencies

---

## Code Style Guidelines

* Use clear, descriptive variable names
* Prefer pure functions for calculations
* Avoid deeply nested logic
* Add comments for:

  * financial calculations
  * parsing logic
  * reconciliation logic

---

## UI Guidelines

* Use Tailwind CSS only (no other styling systems)
* Keep UI minimal and functional
* Focus on:

  * Upload baseline
  * Upload transactions
  * Portfolio view
  * Reconciliation report

Do NOT over-design UI.

---

## API Design

Use simple REST endpoints such as:

* POST /baseline
* POST /transactions
* GET /portfolio
* GET /performance
* GET /reconciliation

Keep API simple and predictable.

---

## Development Order (IMPORTANT)

Agents should implement features in this order:

1. Data models
2. File parsing (transactions + baseline)
3. Transaction normalization
4. Portfolio state reconstruction
5. Reconciliation logic
6. API endpoints
7. Frontend UI

Do NOT skip steps.

---

## Testing

* Add basic tests for:

  * transaction parsing
  * reconciliation logic

* Use simple tools (e.g. Jest or Vitest)

* Do not introduce heavy testing frameworks

---

## Allowed Libraries (Preferred)

Agents may use:

* date-fns → date handling
* papaparse → CSV parsing
* zod → schema validation (optional)

Avoid adding unnecessary dependencies.

---

## Agent Behavior Rules

* ALWAYS read /docs before implementing logic
* DO NOT invent fields or assumptions not defined in docs
* DO NOT hallucinate APIs or external services
* ASK for clarification if requirements are unclear
* Implement incrementally (small, testable steps)

---

## Priority of Instructions

If there is a conflict:

1. Follow AGENTS.md
2. Then follow /docs
3. Then follow user instructions

Do NOT improvise beyond these rules.

---

## Final Principle

This is a personal portfolio tracking app.

Prioritize:

* correctness
* transparency
* simplicity

Avoid:

* unnecessary complexity
* hidden logic
* magic behavior
