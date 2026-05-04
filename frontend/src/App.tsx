import { useEffect, useState } from 'react'
import {
  fetchPortfolio,
  fetchPortfolioHistory,
  fetchPortfolioValue,
  type PricingMethod,
  uploadBaseline,
  uploadTransactions,
} from './api'
import type {
  PortfolioHistoryResponse,
  PortfolioTimeframe,
  PortfolioResponse,
  PortfolioValuePoint,
  PortfolioValueResponse,
  UploadBaselineResponse,
  UploadTransactionsResponse,
} from './types'

type UploadState<T> = {
  loading: boolean
  error: string | null
  result: T | null
  fileName: string
}

const EMPTY_UPLOAD_STATE = {
  loading: false,
  error: null,
  result: null,
  fileName: '',
}

const RECONCILIATION_MESSAGES = {
  MATCH: 'Portfolio verified successfully.',
  MINOR_MISMATCH: 'Minor discrepancies detected (likely rounding or small gaps).',
  MAJOR_MISMATCH: 'Significant mismatch detected between expected and actual holdings.',
} as const

type DashboardSnapshot = {
  history: PortfolioHistoryResponse
  portfolio: PortfolioResponse | null
  portfolioValue: PortfolioValueResponse | null
}

const TIMEFRAME_OPTIONS: Array<{ value: PortfolioTimeframe; label: string }> = [
  { value: '5d', label: '5D' },
  { value: '1m', label: '1M' },
  { value: '3m', label: '3M' },
  { value: '6m', label: '6M' },
  { value: 'ytd', label: 'YTD' },
  { value: '1y', label: '1Y' },
  { value: '3y', label: '3Y' },
  { value: '5y', label: '5Y' },
]

function formatCurrency(value: number | undefined): string {
  if (value === undefined) return '—'

  return new Intl.NumberFormat('en-SG', {
    style: 'currency',
    currency: 'SGD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function formatPercent(value: number | undefined): string {
  if (value === undefined) return '—'
  return `${(value * 100).toFixed(2)}%`
}

function formatSignedCurrency(value: number | undefined): string {
  if (value === undefined) return '—'
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}${formatCurrency(Math.abs(value))}`
}

function formatSignedPercent(value: number | undefined): string {
  if (value === undefined) return '—'
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}${Math.abs(value * 100).toFixed(2)}%`
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unexpected error'
}

function formatXAxisLabel(date: string, timeframe: PortfolioTimeframe): string {
  const value = new Date(`${date}T00:00:00.000Z`)

  if (timeframe === '5d' || timeframe === '1m') {
    return new Intl.DateTimeFormat('en-SG', { day: '2-digit', month: 'short' }).format(value)
  }

  if (timeframe === '3m' || timeframe === '6m' || timeframe === 'ytd') {
    return new Intl.DateTimeFormat('en-SG', { month: 'short' }).format(value)
  }

  return new Intl.DateTimeFormat('en-SG', { month: 'short', year: '2-digit' }).format(value)
}

function formatTooltipDate(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  return new Intl.DateTimeFormat('en-SG', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(value)
}

function getAnchorLabel(anchorType: PortfolioResponse['anchorType'] | PortfolioHistoryResponse['anchorType']) {
  if (anchorType === 'TRANSACTIONS_ONLY') {
    return 'Transactions-only anchor'
  }

  if (anchorType === 'BASELINE') {
    return 'Baseline anchor'
  }

  return 'No active anchor'
}

async function getDashboardSnapshot(
  timeframe: PortfolioTimeframe,
  pricingMethod: PricingMethod,
): Promise<DashboardSnapshot> {
  const history = await fetchPortfolioHistory()

  const [portfolioResult, portfolioValueResult] = await Promise.allSettled([
    fetchPortfolio(),
    fetchPortfolioValue(timeframe, pricingMethod),
  ])

  return {
    history,
    portfolio: portfolioResult.status === 'fulfilled' ? portfolioResult.value : null,
    portfolioValue: portfolioValueResult.status === 'fulfilled' ? portfolioValueResult.value : null,
  }
}

function ValueChart({
  series,
  timeframe,
}: {
  series?: PortfolioValuePoint[]
  timeframe: PortfolioTimeframe
}) {
  const safeSeries = Array.isArray(series) ? series : []
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  if (safeSeries.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white/50 p-6 text-sm text-slate-500">
        No portfolio value series yet.
      </div>
    )
  }

  const width = 640
  const height = 220
  const padding = 24
  const bottomPadding = 42
  const values = safeSeries.map((point) => point.holdingsValue)
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const range = Math.max(maximum - minimum, 1)

  const pointsData = safeSeries.map((point, index) => {
    const x = padding + (index * (width - padding * 2)) / Math.max(safeSeries.length - 1, 1)
    const y =
      height - bottomPadding - ((point.holdingsValue - minimum) / range) * (height - padding - bottomPadding)
    return { x, y, point, index }
  })

  const points = pointsData.map((item) => `${item.x},${item.y}`).join(' ')
  const activeIndex = hoveredIndex ?? pointsData.length - 1
  const activePoint = pointsData[activeIndex]

  const tickCount = Math.min(6, Math.max(3, safeSeries.length))
  const tickIndices = Array.from({ length: tickCount }, (_, i) => {
    if (tickCount === 1) return 0
    return Math.round((i * (safeSeries.length - 1)) / (tickCount - 1))
  }).filter((value, idx, arr) => idx === 0 || value !== arr[idx - 1])

  return (
    <div className="space-y-3 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>{safeSeries[0]?.date}</span>
        <span>{safeSeries[safeSeries.length - 1]?.date}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-64 w-full overflow-visible">
        <defs>
          <linearGradient id="valueGradient" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#0f766e" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#0f766e" stopOpacity="0" />
          </linearGradient>
        </defs>

        {tickIndices.map((index) => {
          const item = pointsData[index]
          if (!item) return null

          return (
            <g key={`tick-${index}`}>
              <line
                x1={item.x}
                x2={item.x}
                y1={height - bottomPadding}
                y2={height - bottomPadding + 6}
                stroke="#94a3b8"
                strokeOpacity="0.5"
              />
              <text
                x={item.x}
                y={height - 10}
                textAnchor="middle"
                fontSize="11"
                fill="#64748b"
              >
                {formatXAxisLabel(item.point.date, timeframe)}
              </text>
            </g>
          )
        })}

        <line
          x1={padding}
          x2={width - padding}
          y1={height - bottomPadding}
          y2={height - bottomPadding}
          stroke="#94a3b8"
          strokeOpacity="0.45"
        />

        <polyline
          fill="none"
          stroke="#0f766e"
          strokeWidth="3"
          points={points}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <polygon
          fill="url(#valueGradient)"
          points={`${padding},${height - bottomPadding} ${points} ${width - padding},${height - bottomPadding}`}
        />

        {pointsData.map((item) => {
          const isActive = item.index === activeIndex
          return (
            <circle
              key={`point-${item.index}`}
              cx={item.x}
              cy={item.y}
              r={isActive ? 4.5 : 3}
              fill={isActive ? '#0f766e' : '#14b8a6'}
              fillOpacity={isActive ? 1 : 0.75}
              stroke="#ffffff"
              strokeWidth={isActive ? 1.8 : 1.2}
              onMouseEnter={() => setHoveredIndex(item.index)}
              onMouseLeave={() => setHoveredIndex(null)}
              onClick={() => setHoveredIndex(item.index)}
              style={{ cursor: 'pointer' }}
            />
          )
        })}

        {activePoint && (
          <>
            <line
              x1={activePoint.x}
              x2={activePoint.x}
              y1={padding}
              y2={height - bottomPadding}
              stroke="#0f766e"
              strokeOpacity="0.25"
              strokeDasharray="4 4"
            />
            <g transform={`translate(${Math.min(width - 170, Math.max(8, activePoint.x - 82))}, ${padding + 2})`}>
              <rect width="164" height="44" rx="10" fill="#0f172a" fillOpacity="0.92" />
              <text x="10" y="18" fontSize="11" fill="#cbd5e1">
                {formatTooltipDate(activePoint.point.date)}
              </text>
              <text x="10" y="34" fontSize="12" fontWeight="700" fill="#f8fafc">
                {formatCurrency(activePoint.point.holdingsValue)}
              </text>
            </g>
          </>
        )}
      </svg>
      <div className="flex items-center justify-between text-sm font-medium text-slate-700">
        <span>{formatCurrency(minimum)}</span>
        <span>{formatCurrency(maximum)}</span>
      </div>
    </div>
  )
}


function UploadModal({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean
  title: string
  children: React.ReactNode
  onClose: () => void
}) {
  if (!open) {
    return null
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border border-white/10 bg-slate-900 p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-slate-300 transition hover:bg-white/10"
          >
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function App() {
  const [timeframe, setTimeframe] = useState<PortfolioTimeframe>('1y')
  const [pricingMethod, setPricingMethod] = useState<PricingMethod>('yahoo_finance')
  const [baselineFile, setBaselineFile] = useState<File | null>(null)
  const [transactionFile, setTransactionFile] = useState<File | null>(null)
  const [baselineUpload, setBaselineUpload] = useState<UploadState<UploadBaselineResponse>>(EMPTY_UPLOAD_STATE)
  const [transactionUpload, setTransactionUpload] = useState<UploadState<UploadTransactionsResponse>>(EMPTY_UPLOAD_STATE)
  const [history, setHistory] = useState<PortfolioHistoryResponse | null>(null)
  const [portfolio, setPortfolio] = useState<PortfolioResponse | null>(null)
  const [portfolioValue, setPortfolioValue] = useState<PortfolioValueResponse | null>(null)
  const [portfolioLoading, setPortfolioLoading] = useState(true)
  const [portfolioError, setPortfolioError] = useState<string | null>(null)
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false)
  const [baselineModalOpen, setBaselineModalOpen] = useState(false)
  const [transactionsModalOpen, setTransactionsModalOpen] = useState(false)

  async function refreshDashboard() {
    setPortfolioLoading(true)
    setPortfolioError(null)

    try {
      const snapshot = await getDashboardSnapshot(timeframe, pricingMethod)
      setHistory(snapshot.history)
      setPortfolio(snapshot.portfolio)
      setPortfolioValue(snapshot.portfolioValue)
    } catch (error) {
      setHistory(null)
      setPortfolio(null)
      setPortfolioValue(null)
      setPortfolioError(getErrorMessage(error))
    } finally {
      setPortfolioLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    async function loadInitialDashboard() {
      try {
        const snapshot = await getDashboardSnapshot(timeframe, pricingMethod)

        if (cancelled) {
          return
        }

        setHistory(snapshot.history)
        setPortfolio(snapshot.portfolio)
        setPortfolioValue(snapshot.portfolioValue)
        setPortfolioError(null)
      } catch (error) {
        if (cancelled) {
          return
        }

        setHistory(null)
        setPortfolio(null)
        setPortfolioValue(null)
        setPortfolioError(getErrorMessage(error))
      } finally {
        if (!cancelled) {
          setPortfolioLoading(false)
        }
      }
    }

    void loadInitialDashboard()

    return () => {
      cancelled = true
    }
  }, [timeframe, pricingMethod])

  async function handleBaselineSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!baselineFile) {
      setBaselineUpload({ ...EMPTY_UPLOAD_STATE, error: 'Choose a baseline text file first.' })
      return
    }

    setBaselineUpload({ loading: true, error: null, result: null, fileName: baselineFile.name })

    try {
      const result = await uploadBaseline(baselineFile)
      setBaselineUpload({ loading: false, error: null, result, fileName: baselineFile.name })
      setBaselineModalOpen(false)
      setBaselineFile(null)
      void refreshDashboard()
    } catch (error) {
      setBaselineUpload({
        loading: false,
        error: `Upload failed: ${getErrorMessage(error)}`,
        result: null,
        fileName: baselineFile.name,
      })
    }
  }

  async function handleTransactionsSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!transactionFile) {
      setTransactionUpload({ ...EMPTY_UPLOAD_STATE, error: 'Choose a transactions file first.' })
      return
    }

    setTransactionUpload({ loading: true, error: null, result: null, fileName: transactionFile.name })

    try {
      const result = await uploadTransactions(transactionFile)
      setTransactionUpload({ loading: false, error: null, result, fileName: transactionFile.name })
      setTransactionsModalOpen(false)
      setTransactionFile(null)
      void refreshDashboard()
    } catch (error) {
      setTransactionUpload({
        loading: false,
        error: `Upload failed: ${getErrorMessage(error)}`,
        result: null,
        fileName: transactionFile.name,
      })
    }
  }

  const holdings = portfolio
    ? Object.entries(portfolio.state.holdings).sort(([left], [right]) => left.localeCompare(right))
    : []

  const series = portfolioValue?.series ?? []
  const startHoldingsValue = series[0]?.holdingsValue
  const endHoldingsValue = series.length > 0 ? series[series.length - 1]?.holdingsValue : undefined
  const holdingsValueChange =
    typeof startHoldingsValue === 'number' && typeof endHoldingsValue === 'number'
      ? endHoldingsValue - startHoldingsValue
      : undefined
  const holdingsValueChangePercent =
    typeof startHoldingsValue === 'number' &&
    typeof endHoldingsValue === 'number' &&
    startHoldingsValue !== 0
      ? (endHoldingsValue - startHoldingsValue) / startHoldingsValue
      : undefined

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(30,58,87,0.9),rgba(8,12,18,1)_60%)] text-slate-100">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <header className="rounded-2xl border border-white/10 bg-slate-900/70 p-5 shadow-xl backdrop-blur-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-cyan-300">CMC Portfolio Tracker</p>
              <h1 className="mt-1 text-2xl font-semibold text-white">Portfolio Dashboard</h1>
            </div>

            <div className="relative">
              <button
                type="button"
                onClick={() => setActionsMenuOpen((open) => !open)}
                className="rounded-full border border-white/15 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
              >
                Actions
              </button>

              {actionsMenuOpen && (
                <div className="absolute right-0 z-20 mt-2 w-56 rounded-xl border border-white/10 bg-slate-900 p-2 shadow-2xl">
                  <button
                    type="button"
                    className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-100 transition hover:bg-white/10"
                    onClick={() => {
                      setActionsMenuOpen(false)
                      setBaselineModalOpen(true)
                    }}
                  >
                    Upload Baseline
                  </button>
                  <button
                    type="button"
                    className="mt-1 w-full rounded-lg px-3 py-2 text-left text-sm text-slate-100 transition hover:bg-white/10"
                    onClick={() => {
                      setActionsMenuOpen(false)
                      setTransactionsModalOpen(true)
                    }}
                  >
                    Upload Transactions
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-200">
            <span className="rounded-full border border-white/10 bg-white/10 px-3 py-1">
              {getAnchorLabel(portfolio?.anchorType ?? history?.anchorType ?? null)}
            </span>
            {history?.currentAnchorDate && (
              <span className="rounded-full border border-white/10 bg-white/10 px-3 py-1">
                Anchor {history.currentAnchorDate}
              </span>
            )}
            {baselineUpload.result && (
              <span className="rounded-full border border-emerald-300/30 bg-emerald-500/15 px-3 py-1 text-emerald-100">
                Baseline uploaded: {baselineUpload.result.baseline.date}
              </span>
            )}
            {transactionUpload.result && (
              <span className="rounded-full border border-emerald-300/30 bg-emerald-500/15 px-3 py-1 text-emerald-100">
                Transactions imported: {transactionUpload.result.added}
              </span>
            )}
          </div>
        </header>

        <main className="mt-6 grid gap-6 xl:grid-cols-2">
          <section className="rounded-2xl border border-white/10 bg-slate-900/65 p-6 shadow-xl backdrop-blur-sm">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold text-white">Portfolio</h2>
              <button
                type="button"
                onClick={() => void refreshDashboard()}
                className="rounded-full border border-white/15 px-4 py-2 text-sm text-slate-200 transition hover:bg-white/10"
              >
                Refresh
              </button>
            </div>

            {portfolioLoading && (
              <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-slate-300">
                Loading portfolio...
              </div>
            )}

            {!portfolioLoading && portfolioError && (
              <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-100">
                {portfolioError}
              </div>
            )}

            {!portfolioLoading && !portfolioError && portfolio && (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl bg-white/95 p-4 text-slate-950">
                    <p className="text-xs uppercase tracking-[0.16em] text-slate-500">State Date</p>
                    <p className="mt-2 text-lg font-semibold">{portfolio.state.date}</p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                    <p className="text-xs uppercase tracking-[0.16em] text-slate-400">
                      Holdings Change ({timeframe.toUpperCase()})
                    </p>
                    <p className="mt-2 text-lg font-semibold text-white">
                      {formatSignedCurrency(holdingsValueChange)}
                    </p>
                    <p className="mt-1 text-xs text-slate-300">
                      {formatSignedPercent(holdingsValueChangePercent)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                    <p className="text-xs uppercase tracking-[0.16em] text-slate-400">Transactions Applied</p>
                    <p className="mt-2 text-lg font-semibold text-white">{portfolio.transactionsApplied}</p>
                  </div>
                </div>

                {portfolio.warnings && portfolio.warnings.length > 0 && (
                  <div className="rounded-xl border border-amber-300/30 bg-amber-400/10 p-4 text-sm text-amber-100">
                    {portfolio.warnings.map((warning, index) => (
                      <p key={`${warning.type}-${index}`}>{warning.type}: {JSON.stringify(warning.details)}</p>
                    ))}
                  </div>
                )}

                <div className="overflow-hidden rounded-xl border border-white/10">
                  <table className="min-w-full divide-y divide-white/10 text-left text-sm">
                    <thead className="bg-white/5 text-slate-300">
                      <tr>
                        <th className="px-4 py-3 font-medium">Symbol</th>
                        <th className="px-4 py-3 font-medium">Quantity</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/10 text-slate-100">
                      {holdings.map(([symbol, quantity]) => (
                        <tr key={symbol}>
                          <td className="px-4 py-3 font-medium">{symbol}</td>
                          <td className="px-4 py-3">{quantity}</td>
                        </tr>
                      ))}
                      {holdings.length === 0 && (
                        <tr>
                          <td colSpan={2} className="px-4 py-6 text-center text-slate-400">
                            No holdings
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-white/10 bg-slate-900/65 p-6 shadow-xl backdrop-blur-sm">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <h2 className="text-xl font-semibold text-white">Performance</h2>

              <label className="text-sm text-slate-300">
                <span className="mb-1 block text-xs uppercase tracking-[0.16em] text-slate-400">Pricing</span>
                <select
                  value={pricingMethod}
                  onChange={(event) => setPricingMethod(event.target.value as PricingMethod)}
                  className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                >
                  <option value="yahoo_finance">Yahoo Finance</option>
                  <option value="google_finance">Google Finance</option>
                  <option value="transaction_forward_fill">Transaction Forward Fill</option>
                  <option value="stooq_free_live">Stooq</option>
                </select>
              </label>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {TIMEFRAME_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setTimeframe(option.value)}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold tracking-wide transition ${
                    timeframe === option.value
                      ? 'bg-cyan-300 text-slate-950'
                      : 'border border-white/15 bg-slate-900/60 text-slate-100 hover:bg-white/10'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {portfolioValue ? (
              <div className="mt-5 space-y-5">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl bg-white/95 p-4 text-slate-950">
                    <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Holdings Value</p>
                    <p className="mt-2 text-xl font-semibold">{formatCurrency(portfolioValue.holdingsValue)}</p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-white">
                    <p className="text-xs uppercase tracking-[0.16em] text-slate-400">Total Return</p>
                    <p className="mt-2 text-xl font-semibold">{formatPercent(portfolioValue.totalReturn)}</p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-white">
                    <p className="text-xs uppercase tracking-[0.16em] text-slate-400">TWR</p>
                    <p className="mt-2 text-xl font-semibold">{formatPercent(portfolioValue.twr)}</p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-white">
                    <p className="text-xs uppercase tracking-[0.16em] text-slate-400">IRR</p>
                    <p className="mt-2 text-xl font-semibold">{formatPercent(portfolioValue.irr)}</p>
                  </div>
                </div>

                {Array.isArray(portfolioValue.missingPriceSymbols) && portfolioValue.missingPriceSymbols.length > 0 && (
                  <div className="rounded-xl border border-amber-300/30 bg-amber-400/10 p-4 text-sm text-amber-100">
                    Missing price data: {portfolioValue.missingPriceSymbols.join(', ')}
                  </div>
                )}

                <ValueChart series={portfolioValue.series} timeframe={portfolioValue.timeframe} />
              </div>
            ) : (
              <div className="mt-5 rounded-xl border border-dashed border-white/15 bg-white/5 p-5 text-sm text-slate-300">
                No performance data
              </div>
            )}
          </section>
        </main>
      </div>

      <UploadModal
        open={baselineModalOpen}
        title="Upload Baseline"
        onClose={() => {
          if (!baselineUpload.loading) {
            setBaselineModalOpen(false)
          }
        }}
      >
        <form onSubmit={handleBaselineSubmit} className="space-y-4">
          <input
            type="file"
            accept=".pdf"
            onChange={(event) => setBaselineFile(event.target.files?.[0] ?? null)}
            className="block w-full text-sm text-slate-200 file:mr-4 file:rounded-full file:border-0 file:bg-amber-300 file:px-4 file:py-2 file:text-sm file:font-medium file:text-slate-950"
          />

          {baselineUpload.error && (
            <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-100">
              {baselineUpload.error}
            </div>
          )}

          {baselineUpload.result && (
            <div className="rounded-lg border border-emerald-300/30 bg-emerald-500/10 p-3 text-sm text-emerald-100">
              {RECONCILIATION_MESSAGES[baselineUpload.result.reconciliation?.status ?? 'MATCH']}
            </div>
          )}

          <button
            type="submit"
            disabled={baselineUpload.loading}
            className="rounded-full bg-amber-300 px-5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {baselineUpload.loading ? 'Uploading...' : 'Upload Baseline'}
          </button>
        </form>
      </UploadModal>

      <UploadModal
        open={transactionsModalOpen}
        title="Upload Transactions"
        onClose={() => {
          if (!transactionUpload.loading) {
            setTransactionsModalOpen(false)
          }
        }}
      >
        <form onSubmit={handleTransactionsSubmit} className="space-y-4">
          <input
            type="file"
            accept=".pdf"
            onChange={(event) => setTransactionFile(event.target.files?.[0] ?? null)}
            className="block w-full text-sm text-slate-200 file:mr-4 file:rounded-full file:border-0 file:bg-cyan-300 file:px-4 file:py-2 file:text-sm file:font-medium file:text-slate-950"
          />

          {transactionUpload.error && (
            <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-100">
              {transactionUpload.error}
            </div>
          )}

          {transactionUpload.result && (
            <div className="rounded-lg border border-emerald-300/30 bg-emerald-500/10 p-3 text-sm text-emerald-100">
              Imported {transactionUpload.result.added}, duplicates {transactionUpload.result.duplicates}, parse errors {transactionUpload.result.parseErrors}
            </div>
          )}

          <button
            type="submit"
            disabled={transactionUpload.loading}
            className="rounded-full bg-cyan-300 px-5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {transactionUpload.loading ? 'Uploading...' : 'Upload Transactions'}
          </button>
        </form>
      </UploadModal>
    </div>
  )
}

export default App
