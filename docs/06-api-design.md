# 06-api-design.md

## Purpose

This document defines the backend API used by the application.

The API provides endpoints to:

* upload and manage data (baselines, transactions)
* retrieve portfolio state and performance
* perform reconciliation checks

The API is designed to be:

* simple
* RESTful
* predictable

---

## General Principles

* Use JSON for all requests and responses
* Keep endpoints minimal and explicit
* Do NOT over-engineer (no GraphQL, no complex query layers)
* All calculations should be deterministic

---

## Base URL

```text id="base_url"
/api
```

---

## 1. Baseline Endpoints

### Upload Baseline

```http id="upload_baseline"
POST /api/baseline
```

#### Request

* Content-Type: `multipart/form-data`
* Body:

  * `file` → portfolio report PDF

#### Behavior

* Parse file into Baseline object
* Validate data
* Store baseline
* Trigger reconciliation if previous baseline exists

---

#### Response

```json id="baseline_response"
{
  "baseline": {
    "id": "string",
    "date": "2026-01-01",
    "holdings": {
      "AMZN": 128
    },
    "cash": 5890.15
  },
  "reconciliation": {
    "status": "MATCH"
  }
}
```

---

### Get All Baselines

```http id="get_baselines"
GET /api/baseline
```

#### Response

```json id="baseline_list"
{
  "baselines": [
    {
      "id": "string",
      "date": "2026-01-01",
      "cash": 5890.15
    }
  ]
}
```

---

## 2. Transaction Endpoints

### Upload Transactions

```http id="upload_tx"
POST /api/transactions
```

#### Request

* Content-Type: `multipart/form-data`
* Body:

  * `file` → transaction statement PDF

---

#### Behavior

* Parse transactions
* Normalize into canonical format
* Deduplicate using transaction IDs
* Store new transactions

---

#### Response

```json id="tx_response"
{
  "added": 42,
  "duplicates": 10,
  "parseErrors": 0,
  "errors": []
}
```

---

### Get Transactions

```http id="get_tx"
GET /api/transactions
```

#### Query Parameters (optional)

* `startDate`
* `endDate`

---

#### Response

```json id="tx_list"
[
  {
    "id": "33784",
    "date": "2026-01-02",
    "type": "BUY",
    "symbol": "AMZN",
    "quantity": 10,
    "amount": -3015.44
  }
]
```

---

## 3. Portfolio Endpoints

### Get Current Portfolio

```http id="current_portfolio"
GET /api/portfolio
```

#### Behavior

* Use the latest authoritative baseline if one exists
* Otherwise use a synthetic transactions-only anchor
* Enrich the post-baseline transaction stream with fetched market stock splits
* Apply all transactions after the active anchor
* Return current state

---

#### Response

```json id="portfolio_response"
{
  "anchorType": "BASELINE",
  "baselineDate": "2026-03-01",
  "baselinesStored": 2,
  "transactionsStored": 48,
  "transactionsApplied": 9,
  "state": {
    "date": "2026-04-21",
    "holdings": {
      "AMZN": 138,
      "NVDA": 222,
      "VGT": 80
    },
    "cash": 5200.50
  },
  "warnings": []
}
```

---

### Get Portfolio Value Over Time

```http id="portfolio_series"
GET /api/portfolio/value
```

#### Query Parameters

* `timeframe` (optional)
* `pricingMethod` (optional)

Allowed values:

* `transaction_forward_fill`
* `google_finance` (fetches latest quote pages from Google Finance and blends into current-day valuation)
* `stooq_free_live` (fetches latest free quotes from Stooq and blends into current-day valuation)
* `yahoo_finance` (fetches historical prices, live prices, and stock split history from Yahoo Finance)

Allowed timeframes:

* `5d`
* `1m`
* `3m`
* `6m`
* `ytd`
* `1y`
* `3y`
* `5y`
* `all`

---

#### Response

```json id="portfolio_series_resp"
{
  "date": "2026-05-05",
  "holdingsValue": 173983.96,
  "totalValue": 173983.96,
  "startDate": "2025-01-31",
  "endDate": "2026-05-05",
  "totalReturn": 1.5182,
  "twr": 1.5193,
  "irr": 2.1540,
  "pricingMethod": "yahoo_finance",
  "timeframe": "all",
  "livePriceFetch": {
    "fetchedSymbols": ["AMZN", "MSFT"],
    "failedSymbols": ["GRNY"]
  },
  "positionValues": {
    "AMZN": 14873.22,
    "VGT": 8521.60
  },
  "twrSeries": [1.0, 1.02, 1.05],
  "missingPriceSymbols": [],
  "series": [
    {
      "date": "2026-01-01",
      "totalValue": 200000,
      "holdingsValue": 194110
    }
  ]
}
```

Notes:

* `/api/portfolio` is the source of truth for holdings quantities shown in the UI table
* `/api/portfolio/value` returns position-level market values used in that same table
* both endpoints must use the same split-aware reconstructed holdings

### Get Portfolio History

```http
GET /api/portfolio/history
```

#### Behavior

* Return recorded upload actions in reverse chronological order
* Return all stored baselines in chronological order
* Return totals for uploads, baselines, and transactions
* Return current active anchor type/date

#### Response

```json
{
  "anchorType": "BASELINE",
  "currentAnchorDate": "2026-03-01",
  "baselines": [],
  "uploads": [],
  "totals": {
    "baselines": 2,
    "transactions": 48,
    "uploads": 5
  }
}
```

---

## 4. Performance Endpoints

### Get Performance Metrics

```http id="performance"
GET /api/performance
```

#### Query Parameters

* `startDate`
* `endDate`

---

#### Response

```json id="performance_resp"
{
  "totalReturn": 0.12,
  "twr": 0.10,
  "irr": 0.11
}
```

---

## 5. Reconciliation Endpoints

### Get Latest Reconciliation

```http id="recon_latest"
GET /api/reconciliation/latest
```

---

#### Response

```json id="recon_resp"
{
  "baselineDate": "2026-03-01",
  "status": "MINOR_MISMATCH",
  "holdingDiffs": [
    {
      "symbol": "NVDA",
      "expected": 222,
      "actual": 220,
      "difference": -2
    }
  ],
  "cashDiff": -10.5
}
```

---

## 6. Utility Endpoints

### Health Check

```http id="health"
GET /api/health
```

#### Response

```json id="health_resp"
{
  "status": "ok"
}
```

---

## Error Handling

All errors must return:

```json id="error_format"
{
  "error": "string",
  "details": "optional"
}
```

---

### Common Errors

* Invalid file format
* Missing required fields
* Unknown transaction type
* Parsing failure

---

## Validation Rules

* Reject invalid uploads
* Do NOT partially ingest corrupted data
* Return clear error messages

---

## State Management

* Backend is source of truth
* All derived values are computed on request
* Avoid storing redundant computed data

---

## Non-Goals

* No authentication (single user)
* No multi-user support
* No real-time streaming
* No external broker integrations

---

## Guiding Principle

The API should be:

> **simple, transparent, and easy to debug**

Every endpoint should clearly reflect:

* input → processing → output
