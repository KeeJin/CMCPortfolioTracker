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

  * file (PDF or CSV)

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
[
  {
    "id": "string",
    "date": "2026-01-01",
    "cash": 5890.15
  }
]
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

  * file (PDF or CSV)

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
  "imported": 42,
  "duplicatesIgnored": 10,
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

* Use latest baseline
* Apply all transactions after baseline
* Return current state

---

#### Response

```json id="portfolio_response"
{
  "date": "2026-03-25",
  "holdings": {
    "AMZN": 138,
    "NVDA": 222
  },
  "cash": 5200.50
}
```

---

### Get Portfolio Value Over Time

```http id="portfolio_series"
GET /api/portfolio/value
```

#### Query Parameters

* `startDate`
* `endDate`

---

#### Response

```json id="portfolio_series_resp"
{
  "series": [
    {
      "date": "2026-01-01",
      "totalValue": 200000,
      "cash": 5890
    }
  ]
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
