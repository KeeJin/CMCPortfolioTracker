export type RawTransactionRow = {
  date: string
  reference: string
  description: string
  debit: number | null
  credit: number | null
}

export type Baseline = {
  id: string
  date: string
  holdings: Record<string, number>
  cash: number
  source?: string
}

export type UploadBaselineResponse = {
  baseline: Baseline
  reconciliation?: {
    status: 'MATCH' | 'MINOR_MISMATCH' | 'MAJOR_MISMATCH'
    notes?: string[]
  }
}

export type UploadTransactionsResponse = {
  added: number
  duplicates: number
  parseErrors: number
  errors?: Array<{
    row: unknown
    reason: string
  }>
}

export type PortfolioResponse = {
  anchorType: 'BASELINE' | 'TRANSACTIONS_ONLY'
  baselineDate: string
  baselinesStored: number
  transactionsStored: number
  transactionsApplied: number
  state: {
    date: string
    holdings: Record<string, number>
    cash: number
  }
  warnings?: Array<{
    type: string
    details: unknown
  }>
}

export type PortfolioValuePoint = {
  date: string
  totalValue: number
  holdingsValue: number
  cashValue: number
}

export type PortfolioTimeframe = '5d' | '1m' | '3m' | '6m' | 'ytd' | '1y' | '3y' | '5y' | 'all'

export type PortfolioValueResponse = {
  date: string
  holdingsValue: number
  totalValue: number
  startDate: string
  endDate: string
  totalReturn?: number
  twr?: number
  irr?: number
  /** CAGR: annualized TWR for the selected timeframe. */
  cagr?: number
  /** Annualized volatility (std-dev of daily returns × √252) for the timeframe. */
  volatility?: number
  pricingMethod: string
  timeframe: PortfolioTimeframe
  series: PortfolioValuePoint[]
  /** Cumulative TWR factor per series point. factor - 1 = return as decimal. */
  twrSeries?: number[]
  /** Cumulative factor series for the VOO benchmark, aligned to series dates. */
  benchmarkTwrSeries?: number[]
  /** VOO total return for the timeframe (factor - 1). */
  benchmarkReturn?: number
  /** VOO CAGR for the timeframe. */
  benchmarkCagr?: number
  /** VOO annualized volatility for the timeframe. */
  benchmarkVolatility?: number
  estimation?: {
    enabled: boolean
    inferredBaselineDate: string
    originalBaselineDate: string
    knownPreBaselineTransactions: number
  }
  /** Latest market value per held symbol (symbol → USD value). */
  positionValues?: Record<string, number>
  /** Per-symbol price-return contribution over the timeframe (symbol → USD gain/loss). */
  positionContributions?: Record<string, number>
  /** Per-symbol realized gains since baseline, using average cost basis with Yahoo USD prices. */
  realizedGains?: Record<string, number>
  usdSgdRate?: number | null
  missingPriceSymbols?: string[]
  livePriceFetch?: {
    fetchedSymbols: string[]
    failedSymbols: string[]
  } | null
}

export type UploadHistoryItem = {
  id: string
  type: 'BASELINE' | 'TRANSACTIONS'
  filename: string
  uploadedAt: string
  dateRange?: {
    start: string
    end: string
  }
  metadata?: {
    baselineDate?: string
    transactionCount?: number
    duplicatesIgnored?: number
    parseErrors?: number
    reconciliationStatus?: 'MATCH' | 'MINOR_MISMATCH' | 'MAJOR_MISMATCH'
  }
}

export type PortfolioHistoryResponse = {
  anchorType: 'BASELINE' | 'TRANSACTIONS_ONLY' | null
  currentAnchorDate: string | null
  baselines: Baseline[]
  uploads: UploadHistoryItem[]
  totals: {
    baselines: number
    transactions: number
    uploads: number
  }
}
