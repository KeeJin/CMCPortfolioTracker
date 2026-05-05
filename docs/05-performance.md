# 05-performance.md

## Purpose

This document defines how portfolio performance is calculated.

The system must support:

* Portfolio value over time
* Time-weighted return (TWR)
* Money-weighted return (IRR)
* Basic benchmarking (optional)

---

## Core Principle

Performance is derived from:

```text
Portfolio State + Market Prices + Cash Flows
```

---

## 1. Portfolio Value

At any time `t`:

```ts
portfolio_value(t) =
  sum_over_assets(shares_i(t) * price_i(t)) + cash(t)
```

Where:

* `shares_i(t)` = shares held at time `t`
* `price_i(t)` = market price at time `t`
* `cash(t)` = cash balance at time `t`

`shares_i(t)` must already reflect any stock split events that occurred on or before `t`.

---

## 2. Market Data Requirement

The system MUST obtain historical prices for each symbol.

Requirements:

* Daily closing prices are sufficient
* Prices must align with transaction dates
* Missing prices should be handled gracefully
* Corporate actions that change quantity must be applied separately from price history

---

## Handling Missing Prices

If price for a date is missing:

* Use last available price (forward fill)

```ts
price(t) = last_known_price_before(t)
```

---

## 3. Portfolio Time Series

To compute performance, generate a time series:

```ts
type PortfolioValuePoint = {
  date: string
  totalValue: number
  holdingsValue: number
  cash: number
}
```

---

### Time Series Construction

For each date in range:

1. Apply transactions up to that date
2. Compute holdings
3. Fetch prices
4. Compute value

This transaction stream includes split events, so holdings quantities and position values remain correct after a stock split.

---

## 4. Cash Flow Classification

Cash flows must be separated into:

### External Cash Flows (user-controlled)

* DEPOSIT
* WITHDRAWAL

### Internal Portfolio Flows

* BUY
* SELL
* DIVIDEND
* SPLIT

---

### Rules

| Type       | Affects Value | Affects Performance |
| ---------- | ------------- | ------------------- |
| BUY        | Yes           | No                  |
| SELL       | Yes           | No                  |
| DIVIDEND   | Yes           | Yes                 |
| DEPOSIT    | Yes           | No                  |
| WITHDRAWAL | Yes           | No                  |
| SPLIT      | Yes           | No                  |

---

## 5. Time-Weighted Return (TWR)

### Purpose

Measures portfolio performance **independent of deposits/withdrawals**.

---

### Method

Break timeline into sub-periods at each external cash flow:

```text
Period 1: t0 → deposit
Period 2: deposit → next deposit/withdrawal
...
```

---

### Formula

For each period:

```ts
period_return =
  (ending_value - starting_value - external_cash_flow) / starting_value
```

Total TWR:

```ts
TWR = (1 + r1) * (1 + r2) * ... * (1 + rn) - 1
```

---

### Important Rules

* Ignore DEPOSIT/WITHDRAWAL as performance
* Include DIVIDENDS as performance
* Use portfolio value before and after each cash flow
* Do NOT treat SPLIT as an external cash flow

### Timeframe-Specific TWR and IRR

When the API returns a timeframe-specific chart:

* first build performance on the full underlying history
* then sample the value series for the requested timeframe
* then filter deposit/withdrawal cash flows to that sampled date range
* finally compute TWR and IRR for that timeframe only

This avoids two known errors:

* metrics becoming identical to naive total return because deposit/withdrawal dates were lost during sampling
* metrics staying constant across all timeframes because cash flows were not filtered to the selected range

---

## 6. Money-Weighted Return (IRR)

### Purpose

Measures return considering timing of cash flows.

---

### Cash Flow Construction

Build series:

```ts
cashflows = [
  { date: t0, amount: -initial_value },
  { date: t1, amount: deposit },
  { date: t2, amount: withdrawal },
  ...
  { date: tn, amount: +final_value }
]
```

---

### Calculation

Compute IRR:

```ts
NPV = 0 = Σ (cashflow_i / (1 + r)^(time_i))
```

Solve for `r`.

---

### Notes

* Use XIRR (date-aware IRR)
* Include ALL external cash flows
* Final portfolio value is treated as positive cash flow
* Do NOT include SPLIT as a cash flow

---

## 7. Dividend Handling

Dividends:

* increase cash
* contribute to return

They are treated as:

```ts
internal_gain
```

NOT external cash flow.

---

## 8. Benchmarking (Optional)

### Purpose

Compare portfolio performance against an index (e.g. S&P 500).

---

### Method

1. Select benchmark symbol (e.g. SPY)
2. Fetch price series
3. Normalize:

```ts
benchmark_index(t) = price(t) / price(t0)
```

---

### Portfolio Normalization

```ts
portfolio_index(t) = value(t) / value(t0)
```

---

### Comparison

Plot both:

* portfolio_index
* benchmark_index

---

## 9. Edge Cases

### Zero Starting Value

If starting value = 0:

* cannot compute return
* return = undefined

---

### Large Cash Flows

Frequent deposits/withdrawals:

* TWR remains valid
* IRR becomes more meaningful

---

### Missing Market Data

* forward-fill prices
* if no historical data exists → exclude symbol

---

### Negative Holdings (invalid)

* should never happen
* indicates data error

---

## 10. Performance Output

Example:

```ts
{
  startDate: string,
  endDate: string,

  totalReturn: number,      // simple return
  twr: number,              // time-weighted return
  irr: number,              // money-weighted return

  series: PortfolioValuePoint[]
}
```

---

## 11. Implementation Notes

* Use daily granularity (not intraday)
* Avoid floating-point accumulation errors where possible
* Keep calculations deterministic

---

## Guiding Principle

Performance must reflect:

> **how well the portfolio performed, not how much money was added**

This is why:

* TWR ignores deposits
* IRR includes them

Both metrics are required for a complete view.
