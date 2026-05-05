# 08-edge-cases.md

## Purpose

This document captures behaviors that must remain correct when data is incomplete, overlapping, or inconsistent.

---

## 1. Overlapping Transaction Uploads

If the same statement is uploaded multiple times, transactions must be deduplicated by transaction id.

Rules:

* first-seen transaction wins
* later duplicates are ignored
* duplicate uploads must not change holdings, cash, TWR, or IRR

---

## 2. Stock Split Present In Multiple Sources

A split can appear in both:

* a broker statement
* Yahoo Finance split history

Rules:

* treat both as describing the same corporate action
* merge them into a single effective split event
* never apply both copies

---

## 3. Stock Split Missing From Broker Statement

If a broker file does not contain a split row but Yahoo Finance does:

* fetch the split event from Yahoo Finance
* enrich the post-baseline transaction stream before reconstruction
* ensure `/api/portfolio` and `/api/portfolio/value` both use the same enriched holdings state

This is required so the holdings quantity shown in the UI remains correct.

---

## 4. Failed Split Fetch

Yahoo Finance split enrichment is best-effort.

Rules:

* a failed split fetch must not crash the request
* continue with statement-only data if the external fetch fails
* log the failure for debugging

---

## 5. Timeframe Metrics On Sampled Series

Sampling can hide deposit and withdrawal dates.

If TWR or IRR is calculated on an already-sampled series without the corresponding timeframe-filtered cash flows, two errors can occur:

* TWR collapses toward naive total return
* TWR and IRR remain nearly constant across timeframes

Rules:

* build the full underlying value series first
* sample only for presentation
* filter external cash flows to the sampled date range before computing timeframe metrics

---

## 6. Missing Latest Price For A Held Symbol

If a holding exists but no latest price is available:

* keep the quantity in the holdings table
* report the symbol in `missingPriceSymbols`
* render `—` for that position's market value

---

## 7. Split-Adjusted Price vs Split-Adjusted Quantity

Price history and quantity history solve different problems.

Rules:

* split-adjusted price series do not remove the need to update holdings quantity
* stock split events must still be applied to the transaction stream
* accurate UI quantities require split-aware reconstruction, not only better prices
