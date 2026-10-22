import type {
  ManualTradeRequest,
  ManualTradeResponse,
  PortfolioHistoryResponse,
  PortfolioTimeframe,
  PortfolioResponse,
  PortfolioValueResponse,
  UploadBaselineResponse,
  UploadTransactionsResponse,
} from './types'

export type PricingMethod = 'transaction_forward_fill' | 'google_finance' | 'stooq_free_live' | 'yahoo_finance'

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

async function apiRequest<T>(input: string, init?: RequestInit): Promise<T> {
  const isAbsoluteUrl = /^https?:\/\//i.test(input)
  const url = isAbsoluteUrl ? input : `${API_BASE_URL}${input.startsWith('/') ? input : `/${input}`}`

  const response = await fetch(url, {
    ...init,
    credentials: 'include',
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

export function createManualTrade(payload: ManualTradeRequest) {
  return apiRequest<ManualTradeResponse>('/api/transactions/manual', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
}

export function fetchPortfolio() {
  return apiRequest<PortfolioResponse>('/api/portfolio')
}

export function fetchPortfolioValue(
  timeframe: PortfolioTimeframe,
  pricingMethod: PricingMethod,
  options?: { debug?: boolean; twrMode?: 'invested_capital' | 'account_total' },
) {
  const params = new URLSearchParams({
    pricingMethod,
    timeframe,
  })
  if (options?.twrMode) {
    params.set('twrMode', options.twrMode)
  }
  if (options?.debug) {
    params.set('debug', '1')
  }
  return apiRequest<PortfolioValueResponse>(`/api/portfolio/value?${params.toString()}`)
}

export function fetchPortfolioHistory() {
  return apiRequest<PortfolioHistoryResponse>('/api/portfolio/history')
}

export function fetchSession() {
  return apiRequest<{ authenticated: boolean; user: { email: string } | null }>('/api/auth/session')
}

export function signInWithGoogle(credential: string) {
  return apiRequest<{ success: boolean; user: { email: string } }>('/api/auth/google', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ credential }),
  })
}

export function signOut() {
  return apiRequest<{ success: boolean }>('/api/auth/logout', {
    method: 'POST',
  })
}
