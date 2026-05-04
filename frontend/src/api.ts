import type {
  PortfolioHistoryResponse,
  PortfolioTimeframe,
  PortfolioResponse,
  PortfolioValueResponse,
  UploadBaselineResponse,
  UploadTransactionsResponse,
} from './types'

export type PricingMethod = 'transaction_forward_fill' | 'google_finance' | 'stooq_free_live' | 'yahoo_finance'

async function apiRequest<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: init?.headers,
  })

  const data = (await response.json().catch(() => null)) as
    | { error?: string }
    | T
    | null

  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Request failed with status ${response.status}`
    throw new Error(message)
  }

  return data as T
}

function createUploadBody(file: File): FormData {
  const body = new FormData()
  body.append('file', file)
  return body
}

export function uploadBaseline(file: File) {
  return apiRequest<UploadBaselineResponse>('/api/baseline', {
    method: 'POST',
    body: createUploadBody(file),
  })
}

export function uploadTransactions(file: File) {
  return apiRequest<UploadTransactionsResponse>('/api/transactions', {
    method: 'POST',
    body: createUploadBody(file),
  })
}

export function fetchPortfolio() {
  return apiRequest<PortfolioResponse>('/api/portfolio')
}

export function fetchPortfolioValue(timeframe: PortfolioTimeframe, pricingMethod: PricingMethod) {
  const params = new URLSearchParams({
    pricingMethod,
    timeframe,
  })
  return apiRequest<PortfolioValueResponse>(`/api/portfolio/value?${params.toString()}`)
}

export function fetchPortfolioHistory() {
  return apiRequest<PortfolioHistoryResponse>('/api/portfolio/history')
}
