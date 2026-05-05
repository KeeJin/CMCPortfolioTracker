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
  { value: 'all', label: 'All' },
]

type DisplayCurrency = 'USD' | 'SGD'
type HoldingsSortKey = 'symbol' | 'quantity' | 'value'
type SortDirection = 'asc' | 'desc'

function formatCurrency(
  value: number | undefined,
  displayCurrency: DisplayCurrency = 'USD',
  usdSgdRate?: number | null
): string {
  if (value === undefined) return '—'
  const converted =
    displayCurrency === 'SGD' && usdSgdRate ? value * usdSgdRate : value
  return new Intl.NumberFormat(displayCurrency === 'SGD' ? 'en-SG' : 'en-US', {
    style: 'currency',
    currency: displayCurrency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(converted)
}

function formatPercent(value: number | undefined): string {
  if (value === undefined) return '—'
  return `${(value * 100).toFixed(2)}%`
}

function formatSignedCurrency(
  value: number | undefined,
  displayCurrency: DisplayCurrency = 'USD',
  usdSgdRate?: number | null
): string {
  if (value === undefined) return '—'
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}${formatCurrency(Math.abs(value), displayCurrency, usdSgdRate)}`
}

function formatSignedPercent(value: number | undefined): string {
  if (value === undefined) return '—'
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}${Math.abs(value * 100).toFixed(2)}%`
}

function compareMaybeNumber(
  left: number | undefined,
  right: number | undefined,
  direction: SortDirection,
): number {
  if (left === undefined && right === undefined) return 0
  if (left === undefined) return 1
  if (right === undefined) return -1

  if (left < right) return direction === 'asc' ? -1 : 1
  if (left > right) return direction === 'asc' ? 1 : -1
  return 0
}

function MetricLabel({ label, tooltip }: { label: string; tooltip: string }) {
  return (
    <p className="flex items-center gap-1 text-xs uppercase tracking-[0.16em] text-slate-400">
      <span>{label}</span>
      <span className="group relative inline-flex items-center">
        <span
          className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-400/70 text-[10px] font-semibold text-slate-300"
          aria-label={`${label} definition`}
        >
          i
        </span>
        <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 hidden w-56 -translate-x-1/2 rounded-md border border-white/15 bg-slate-950/95 px-2 py-1.5 text-[10px] normal-case leading-snug tracking-normal text-slate-100 shadow-lg group-hover:block group-focus-within:block">
          {tooltip}
        </span>
      </span>
    </p>
  )
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unexpected error'
}

function formatXAxisLabel(date: string, timeframe: PortfolioTimeframe, seriesStartDate?: string): string {
  const value = new Date(`${date}T00:00:00.000Z`)

  if (timeframe === '5d' || timeframe === '1m') {
    return new Intl.DateTimeFormat('en-SG', { day: '2-digit', month: 'short' }).format(value)
  }

  if (timeframe === '3m' || timeframe === '6m' || timeframe === 'ytd') {
    return new Intl.DateTimeFormat('en-SG', { month: 'short' }).format(value)
  }

  if (timeframe === 'all' && seriesStartDate) {
    // Use the same interval the backend chose: weekly (<= 6 months), else monthly.
    const spanDays = Math.round(
      (new Date(`${date}T00:00:00.000Z`).getTime() - new Date(`${seriesStartDate}T00:00:00.000Z`).getTime()) /
        86_400_000
    )
    if (spanDays <= 180) {
      return new Intl.DateTimeFormat('en-SG', { day: '2-digit', month: 'short' }).format(value)
    }
    return new Intl.DateTimeFormat('en-SG', { month: 'short', year: '2-digit' }).format(value)
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
  includePreBaselineEstimates: boolean,
): Promise<DashboardSnapshot> {
  const history = await fetchPortfolioHistory()

  const [portfolioResult, portfolioValueResult] = await Promise.allSettled([
    fetchPortfolio(),
    fetchPortfolioValue(timeframe, pricingMethod, includePreBaselineEstimates),
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
  displayCurrency,
  usdSgdRate,
  mode = 'holdings',
  twrSeries,
  benchmarkTwrSeries,
}: {
  series?: PortfolioValuePoint[]
  timeframe: PortfolioTimeframe
  displayCurrency: DisplayCurrency
  usdSgdRate?: number | null
  mode?: 'holdings' | 'twr'
  twrSeries?: number[]
  benchmarkTwrSeries?: number[]
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

  // When mode is 'twr' and twrSeries aligns, plot (factor - 1) as fraction.
  const isTwr = mode === 'twr' && Array.isArray(twrSeries) && twrSeries.length === safeSeries.length
  const yValues = isTwr
    ? twrSeries!.map((f) => f - 1)
    : safeSeries.map((p) => p.holdingsValue)

  // Benchmark values overlaid only in TWR mode
  const benchValues =
    isTwr &&
    Array.isArray(benchmarkTwrSeries) &&
    benchmarkTwrSeries.length === safeSeries.length
      ? benchmarkTwrSeries.map((f) => f - 1)
      : []

  const minimum = Math.min(...yValues, ...(benchValues.length ? benchValues : yValues))
  const maximum = Math.max(...yValues, ...(benchValues.length ? benchValues : yValues))
  const range = Math.max(maximum - minimum, isTwr ? 0.001 : 1)

  const lineColor = isTwr ? '#6366f1' : '#0f766e'
  const gradientId = isTwr ? 'twrGradient' : 'valueGradient'

  function fmtTooltipY(yValue: number): string {
    if (isTwr) {
      const pct = yValue * 100
      return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
    }
    return formatCurrency(yValue, displayCurrency, usdSgdRate)
  }

  function fmtAxisY(yValue: number): string {
    if (isTwr) {
      const pct = yValue * 100
      return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
    }
    return formatCurrency(yValue, displayCurrency, usdSgdRate)
  }

  const pointsData = safeSeries.map((point, index) => {
    const x = padding + (index * (width - padding * 2)) / Math.max(safeSeries.length - 1, 1)
    const yValue = yValues[index] ?? 0
    const y = height - bottomPadding - ((yValue - minimum) / range) * (height - padding - bottomPadding)
    return { x, y, point, index, yValue }
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
          <linearGradient id="twrGradient" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#6366f1" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
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
                {formatXAxisLabel(item.point.date, timeframe, safeSeries[0]?.date)}
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
          stroke={lineColor}
          strokeWidth="3"
          points={points}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <polygon
          fill={`url(#${gradientId})`}
          points={`${padding},${height - bottomPadding} ${points} ${width - padding},${height - bottomPadding}`}
        />

        {/* Benchmark (VOO) overlay line — dashed amber, only in TWR mode */}
        {benchValues.length > 0 && (
          <polyline
            fill="none"
            stroke="#f59e0b"
            strokeWidth="2"
            strokeDasharray="6 3"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={benchValues
              .map((v, i) => {
                const x =
                  padding +
                  (i * (width - padding * 2)) / Math.max(safeSeries.length - 1, 1)
                const y =
                  height -
                  bottomPadding -
                  ((v - minimum) / range) * (height - padding - bottomPadding)
                return `${x},${y}`
              })
              .join(' ')}
          />
        )}

        {pointsData.map((item) => {
          const isActive = item.index === activeIndex
          return (
            <circle
              key={`point-${item.index}`}
              cx={item.x}
              cy={item.y}
              r={isActive ? 4.5 : 3}
              fill={isActive ? lineColor : (isTwr ? '#818cf8' : '#14b8a6')}
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
              stroke={lineColor}
              strokeOpacity="0.25"
              strokeDasharray="4 4"
            />
            <g transform={`translate(${Math.min(width - 170, Math.max(8, activePoint.x - 82))}, ${padding + 2})`}>
              <rect width="164" height="44" rx="10" fill="#0f172a" fillOpacity="0.92" />
              <text x="10" y="18" fontSize="11" fill="#cbd5e1">
                {formatTooltipDate(activePoint.point.date)}
              </text>
              <text x="10" y="34" fontSize="12" fontWeight="700" fill="#f8fafc">
                {fmtTooltipY(activePoint.yValue)}
              </text>
            </g>
          </>
        )}
      </svg>
      <div className="flex items-center justify-between text-sm font-medium text-slate-700">
        <span>{fmtAxisY(minimum)}</span>
        <span>{fmtAxisY(maximum)}</span>
      </div>
      {benchValues.length > 0 && (
        <div className="mt-2 flex items-center gap-4 text-xs text-slate-400">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-5 rounded bg-indigo-400" />
            Portfolio
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-0.5 w-5 rounded"
              style={{ background: '#f59e0b', borderTop: '2px dashed #f59e0b' }}
            />
            VOO Benchmark
          </span>
        </div>
      )}
    </div>
  )
}


function ContributionChart({
  contributions,
  displayCurrency,
  usdSgdRate,
  timeframe,
}: {
  contributions: Record<string, number>
  displayCurrency: DisplayCurrency
  usdSgdRate?: number | null
  timeframe: string
}) {
  const entries = Object.entries(contributions)
    .map(([symbol, value]) => ({ symbol, value }))
    .sort((a, b) => b.value - a.value)

  if (entries.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-white/15 bg-white/5 p-6 text-sm text-slate-400">
        No contribution data available.
      </div>
    )
  }

  const maxAbs = Math.max(...entries.map((e) => Math.abs(e.value)), 1)
  const totalGain = entries.reduce((s, e) => (e.value > 0 ? s + e.value : s), 0)
  const totalLoss = entries.reduce((s, e) => (e.value < 0 ? s + e.value : s), 0)

  const ROW_H = 36
  const LABEL_W = 68
  const VALUE_W = 100
  const BAR_AREA = 360
  const svgWidth = LABEL_W + BAR_AREA + VALUE_W
  const svgHeight = entries.length * ROW_H + 8

  function barWidth(value: number) {
    return (Math.abs(value) / maxAbs) * (BAR_AREA / 2 - 4)
  }

  const midX = LABEL_W + BAR_AREA / 2

  function fmtContrib(v: number) {
    const converted = displayCurrency === 'SGD' && usdSgdRate ? v * usdSgdRate : v
    const sign = v > 0 ? '+' : v < 0 ? '-' : ''
    return `${sign}${new Intl.NumberFormat(displayCurrency === 'SGD' ? 'en-SG' : 'en-US', {
      style: 'currency',
      currency: displayCurrency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(Math.abs(converted))}`
  }

  return (
    <div className="space-y-3">
      {/* Summary strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl bg-white/95 p-3 text-slate-950">
          <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Positions</p>
          <p className="mt-1 text-lg font-semibold">{entries.length}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/5 p-3">
          <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Winners</p>
          <p className="mt-1 text-lg font-semibold text-emerald-400">
            {entries.filter((e) => e.value > 0).length}
          </p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/5 p-3">
          <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Losers</p>
          <p className="mt-1 text-lg font-semibold text-rose-400">
            {entries.filter((e) => e.value < 0).length}
          </p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/5 p-3">
          <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Net ({timeframe.toUpperCase()})</p>
          <p className={`mt-1 text-lg font-semibold ${totalGain + totalLoss >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {fmtContrib(totalGain + totalLoss)}
          </p>
        </div>
      </div>

      {/* Horizontal bar chart */}
      <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/3 p-4">
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="w-full"
          style={{ minWidth: `${svgWidth}px`, height: `${svgHeight}px` }}
        >
          {/* Centre line */}
          <line
            x1={midX}
            x2={midX}
            y1={0}
            y2={svgHeight}
            stroke="#475569"
            strokeOpacity="0.4"
            strokeWidth="1"
          />

          {entries.map((entry, i) => {
            const y = i * ROW_H + 4
            const isGain = entry.value >= 0
            const bw = barWidth(entry.value)
            const barX = isGain ? midX : midX - bw
            const fill = isGain ? '#10b981' : '#f43f5e'
            const fillOp = isGain ? '0.75' : '0.7'

            return (
              <g key={entry.symbol}>
                {/* Symbol label */}
                <text
                  x={LABEL_W - 8}
                  y={y + ROW_H / 2 + 4}
                  textAnchor="end"
                  fontSize="12"
                  fontWeight="600"
                  fill="#e2e8f0"
                >
                  {entry.symbol}
                </text>

                {/* Bar */}
                <rect
                  x={barX}
                  y={y + 6}
                  width={Math.max(bw, 2)}
                  height={ROW_H - 12}
                  rx="3"
                  fill={fill}
                  fillOpacity={fillOp}
                />

                {/* Value label */}
                <text
                  x={LABEL_W + BAR_AREA + 6}
                  y={y + ROW_H / 2 + 4}
                  textAnchor="start"
                  fontSize="11"
                  fontWeight="500"
                  fill={isGain ? '#34d399' : '#fb7185'}
                >
                  {fmtContrib(entry.value)}
                </text>
              </g>
            )
          })}
        </svg>
      </div>

      {/* Gain / loss totals */}
      <div className="flex justify-between text-xs text-slate-400 px-1">
        <span className="text-rose-400">Losses: {fmtContrib(totalLoss)}</span>
        <span className="text-emerald-400">Gains: {fmtContrib(totalGain)}</span>
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
  const [includePreBaselineEstimates, setIncludePreBaselineEstimates] = useState(true)
  const [displayCurrency, setDisplayCurrency] = useState<DisplayCurrency>('USD')
  const [selectedChart, setSelectedChart] = useState<'holdings' | 'twr'>('holdings')
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
  const [holdingsSort, setHoldingsSort] = useState<{ key: HoldingsSortKey; direction: SortDirection }>({
    key: 'value',
    direction: 'desc',
  })

  function toggleHoldingsSort(key: HoldingsSortKey) {
    setHoldingsSort((current) => {
      if (current.key === key) {
        return {
          key,
          direction: current.direction === 'asc' ? 'desc' : 'asc',
        }
      }

      return {
        key,
        direction: key === 'symbol' ? 'asc' : 'desc',
      }
    })
  }

  function getSortMarker(key: HoldingsSortKey) {
    if (holdingsSort.key !== key) return '↕'
    return holdingsSort.direction === 'asc' ? '↑' : '↓'
  }

  async function refreshDashboard() {
    setPortfolioLoading(true)
    setPortfolioError(null)

    try {
      const snapshot = await getDashboardSnapshot(
        timeframe,
        pricingMethod,
        includePreBaselineEstimates,
      )
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
      setPortfolioLoading(true)
      try {
        const snapshot = await getDashboardSnapshot(
          timeframe,
          pricingMethod,
          includePreBaselineEstimates,
        )

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
  }, [timeframe, pricingMethod, includePreBaselineEstimates])

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
    ? Object.entries(portfolio.state.holdings)
        .sort(([leftSymbol, leftQuantity], [rightSymbol, rightQuantity]) => {
          if (holdingsSort.key === 'symbol') {
            const symbolComparison = leftSymbol.localeCompare(rightSymbol)
            return holdingsSort.direction === 'asc' ? symbolComparison : -symbolComparison
          }

          if (holdingsSort.key === 'quantity') {
            if (leftQuantity < rightQuantity) return holdingsSort.direction === 'asc' ? -1 : 1
            if (leftQuantity > rightQuantity) return holdingsSort.direction === 'asc' ? 1 : -1
            return leftSymbol.localeCompare(rightSymbol)
          }

          const leftValue = portfolioValue?.positionValues?.[leftSymbol]
          const rightValue = portfolioValue?.positionValues?.[rightSymbol]
          const valueComparison = compareMaybeNumber(leftValue, rightValue, holdingsSort.direction)
          return valueComparison !== 0 ? valueComparison : leftSymbol.localeCompare(rightSymbol)
        })
    : []

  const series = portfolioValue?.series ?? []
  const startHoldingsValue = series[0]?.holdingsValue
  const endHoldingsValue = series.length > 0 ? series[series.length - 1]?.holdingsValue : undefined
  const holdingsValueChange =
    typeof startHoldingsValue === 'number' && typeof endHoldingsValue === 'number'
      ? endHoldingsValue - startHoldingsValue
      : undefined
  const usdSgdRate = portfolioValue?.usdSgdRate ?? null

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

            {!portfolioLoading && portfolioError && (
              <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-100">
                {portfolioError}
              </div>
            )}

            {!portfolioError && portfolio && (
              <div className={`space-y-4 transition-all duration-150 ${portfolioLoading ? 'pointer-events-none opacity-30 blur-[1px]' : ''}`}>
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
                      {formatSignedCurrency(holdingsValueChange, displayCurrency, usdSgdRate)}
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
                        <th className="px-4 py-3 font-medium">
                          <button
                            type="button"
                            onClick={() => toggleHoldingsSort('symbol')}
                            className="inline-flex items-center gap-2 transition hover:text-white"
                          >
                            <span>Symbol</span>
                            <span className="text-xs text-slate-400">{getSortMarker('symbol')}</span>
                          </button>
                        </th>
                        <th className="px-4 py-3 font-medium">
                          <button
                            type="button"
                            onClick={() => toggleHoldingsSort('quantity')}
                            className="inline-flex items-center gap-2 transition hover:text-white"
                          >
                            <span>Quantity</span>
                            <span className="text-xs text-slate-400">{getSortMarker('quantity')}</span>
                          </button>
                        </th>
                        <th className="px-4 py-3 font-medium text-right">
                          <button
                            type="button"
                            onClick={() => toggleHoldingsSort('value')}
                            className="inline-flex items-center gap-2 transition hover:text-white"
                          >
                            <span>Value</span>
                            <span className="text-xs text-slate-400">{getSortMarker('value')}</span>
                          </button>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/10 text-slate-100">
                      {holdings.map(([symbol, quantity]) => {
                        const posVal = portfolioValue?.positionValues?.[symbol]
                        return (
                          <tr key={symbol}>
                            <td className="px-4 py-3 font-medium">{symbol}</td>
                            <td className="px-4 py-3">{quantity}</td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {posVal !== undefined
                                ? formatCurrency(posVal, displayCurrency, usdSgdRate)
                                : <span className="text-slate-500">—</span>}
                            </td>
                          </tr>
                        )
                      })}
                      {holdings.length === 0 && (
                        <tr>
                          <td colSpan={3} className="px-4 py-6 text-center text-slate-400">
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

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <div className="flex overflow-hidden rounded-full border border-white/15 bg-slate-900/60 text-xs font-semibold">
                <button
                  type="button"
                  onClick={() => setDisplayCurrency('USD')}
                  className={`px-3 py-1.5 transition ${displayCurrency === 'USD' ? 'bg-cyan-300 text-slate-950' : 'text-slate-100 hover:bg-white/10'}`}
                >
                  USD
                </button>
                <button
                  type="button"
                  onClick={() => setDisplayCurrency('SGD')}
                  className={`px-3 py-1.5 transition ${displayCurrency === 'SGD' ? 'bg-cyan-300 text-slate-950' : 'text-slate-100 hover:bg-white/10'}`}
                >
                  SGD
                </button>
              </div>
              <div className="h-4 w-px bg-white/15" />
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

              <label className="ml-auto flex items-center gap-2 rounded-full border border-amber-300/25 bg-amber-400/10 px-3 py-1.5 text-xs font-medium text-amber-100">
                <input
                  type="checkbox"
                  checked={includePreBaselineEstimates}
                  onChange={(event) => setIncludePreBaselineEstimates(event.target.checked)}
                  className="h-3.5 w-3.5 rounded border-amber-200/60 bg-slate-900 text-amber-300 focus:ring-amber-300"
                />
                Include pre-baseline estimates
              </label>
            </div>

            {!portfolioValue && portfolioLoading && (
              <div className="mt-5 flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-5 text-sm text-slate-300">
                <svg className="h-5 w-5 animate-spin text-cyan-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Fetching portfolio data…
              </div>
            )}

            {portfolioValue ? (
              <div className="relative mt-5 space-y-5">
                {portfolioLoading && (
                  <div className="absolute -top-1 right-0 z-10 flex items-center gap-2 rounded-full border border-white/15 bg-slate-900/95 px-3 py-1.5 text-xs text-slate-300 shadow-lg">
                    <svg className="h-3.5 w-3.5 animate-spin text-cyan-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Updating…
                  </div>
                )}
                <div className={`space-y-5 transition-all duration-150 ${portfolioLoading ? 'pointer-events-none opacity-30 blur-[1px]' : ''}`}>
                {portfolioValue.estimation?.enabled && (
                  <div className="rounded-xl border border-amber-300/30 bg-amber-400/10 p-4 text-sm text-amber-100">
                    Estimation mode enabled. Metrics before {portfolioValue.estimation.originalBaselineDate} are inferred from
                    {` ${portfolioValue.estimation.knownPreBaselineTransactions} `}
                    known pre-baseline transaction(s). Baseline-date onward remains authoritative.
                  </div>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <div
                    className={`rounded-xl bg-white/95 p-4 text-slate-950 cursor-pointer select-none transition-all ${selectedChart === 'holdings' ? 'ring-2 ring-teal-500' : 'opacity-85 hover:opacity-100'}`}
                    onClick={() => setSelectedChart('holdings')}
                    title="Click to view holdings chart"
                  >
                    <MetricLabel
                      label="Holdings Value"
                      tooltip="Current market value of your holdings for the selected timeframe, shown in your chosen display currency."
                    />
                    <p className="mt-2 text-xl font-semibold">{formatCurrency(portfolioValue.holdingsValue, displayCurrency, usdSgdRate)}</p>
                    {displayCurrency === 'SGD' && usdSgdRate && (
                      <p className="mt-1 text-xs text-slate-400">1 USD = {usdSgdRate.toFixed(4)} SGD</p>
                    )}
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-white">
                    <MetricLabel
                      label="Total Return"
                      tooltip="Simple change from first to last portfolio value in the selected timeframe. This is not cash-flow adjusted."
                    />
                    <p className="mt-2 text-xl font-semibold">{formatPercent(portfolioValue.totalReturn)}</p>
                  </div>
                  <div
                    className={`rounded-xl border p-4 text-white cursor-pointer select-none transition-all ${selectedChart === 'twr' ? 'border-indigo-400/60 bg-indigo-500/20 ring-2 ring-indigo-400' : 'border-white/10 bg-white/5 opacity-85 hover:opacity-100'}`}
                    onClick={() => setSelectedChart('twr')}
                    title="Click to view TWR chart"
                  >
                    <MetricLabel
                      label="TWR"
                      tooltip="Time-Weighted Return. Measures investment performance excluding the impact of deposits and withdrawals."
                    />
                    <p className="mt-2 text-xl font-semibold">{formatPercent(portfolioValue.twr)}</p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-white">
                    <MetricLabel
                      label="IRR"
                      tooltip="Money-Weighted Return (XIRR). Includes timing and size of deposits and withdrawals to reflect your personal return."
                    />
                    <p className="mt-2 text-xl font-semibold">{formatPercent(portfolioValue.irr)}</p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-white">
                    <MetricLabel
                      label="CAGR"
                      tooltip="Compound Annual Growth Rate. Annualized TWR showing the equivalent yearly growth rate over the selected timeframe."
                    />
                    <p className="mt-2 text-xl font-semibold">{formatPercent(portfolioValue.cagr)}</p>
                    {portfolioValue.benchmarkCagr !== undefined && portfolioValue.cagr !== undefined && (
                      <p className={`mt-1 text-xs ${portfolioValue.cagr >= portfolioValue.benchmarkCagr ? 'text-emerald-400' : 'text-rose-400'}`}>
                        α {formatSignedPercent(portfolioValue.cagr - portfolioValue.benchmarkCagr)} vs VOO
                      </p>
                    )}
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-white">
                    <MetricLabel
                      label="Volatility"
                      tooltip="Annualized standard deviation of daily portfolio returns (×√252). Higher = more price variation."
                    />
                    <p className="mt-2 text-xl font-semibold">{formatPercent(portfolioValue.volatility)}</p>
                    {portfolioValue.cagr !== undefined && portfolioValue.volatility !== undefined && portfolioValue.volatility > 0 && (
                      <p className="mt-1 text-xs text-slate-400">
                        Sharpe ≈ {(portfolioValue.cagr / portfolioValue.volatility).toFixed(2)}
                      </p>
                    )}
                  </div>
                </div>

                {/* Benchmark comparison row */}
                {(portfolioValue.benchmarkReturn !== undefined ||
                  portfolioValue.benchmarkCagr !== undefined ||
                  portfolioValue.benchmarkVolatility !== undefined) && (
                  <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-4">
                    <p className="mb-3 text-xs uppercase tracking-[0.16em] text-amber-300">VOO Benchmark</p>
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <p className="text-xs text-slate-400">Return</p>
                        <p className="mt-1 text-base font-semibold text-white">{formatSignedPercent(portfolioValue.benchmarkReturn)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-slate-400">CAGR</p>
                        <p className="mt-1 text-base font-semibold text-white">{formatPercent(portfolioValue.benchmarkCagr)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-slate-400">Volatility</p>
                        <p className="mt-1 text-base font-semibold text-white">{formatPercent(portfolioValue.benchmarkVolatility)}</p>
                        {portfolioValue.benchmarkCagr !== undefined && portfolioValue.benchmarkVolatility !== undefined && portfolioValue.benchmarkVolatility > 0 && (
                          <p className="mt-0.5 text-xs text-slate-500">Sharpe ≈ {(portfolioValue.benchmarkCagr / portfolioValue.benchmarkVolatility).toFixed(2)}</p>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {Array.isArray(portfolioValue.missingPriceSymbols) && portfolioValue.missingPriceSymbols.length > 0 && (
                  <div className="rounded-xl border border-amber-300/30 bg-amber-400/10 p-4 text-sm text-amber-100">
                    Missing price data: {portfolioValue.missingPriceSymbols.join(', ')}
                  </div>
                )}

                <ValueChart
                  series={portfolioValue.series}
                  timeframe={portfolioValue.timeframe}
                  displayCurrency={displayCurrency}
                  usdSgdRate={usdSgdRate}
                  mode={selectedChart}
                  twrSeries={portfolioValue.twrSeries}
                  benchmarkTwrSeries={portfolioValue.benchmarkTwrSeries}
                />
              </div>
            </div>
            ) : (
              <div className="mt-5 rounded-xl border border-dashed border-white/15 bg-white/5 p-5 text-sm text-slate-300">
                No performance data
              </div>
            )}
          </section>
        </main>

        {/* Contribution analysis — full-width section below the two-column grid */}
        {portfolioValue?.positionContributions &&
          Object.keys(portfolioValue.positionContributions).length > 0 && (
            <section className={`mt-6 rounded-2xl border border-white/10 bg-slate-900/65 p-6 shadow-xl backdrop-blur-sm transition-all duration-150 ${portfolioLoading ? 'pointer-events-none opacity-30 blur-[1px]' : ''}`}>
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold text-white">Contribution Analysis</h2>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Price-return contribution per position for the selected timeframe ({timeframe.toUpperCase()}).
                    Shows how much each holding's price movement added or removed in {displayCurrency}.
                  </p>
                </div>
              </div>
              <ContributionChart
                contributions={portfolioValue.positionContributions}
                displayCurrency={displayCurrency}
                usdSgdRate={usdSgdRate}
                timeframe={timeframe}
              />

              {portfolioValue.realizedGains && Object.keys(portfolioValue.realizedGains).length > 0 && (
                <div className="mt-8">
                  <h3 className="mb-1 text-base font-semibold text-slate-200">Realized Gains (since baseline)</h3>
                  <p className="mb-4 text-xs text-slate-400">
                    Closed positions: (sale price − average buy price) × shares sold, priced in USD via Yahoo Finance.
                    This reflects actual locked-in profit or loss from trades completed after the baseline.
                  </p>
                  <ContributionChart
                    contributions={portfolioValue.realizedGains}
                    displayCurrency={displayCurrency}
                    usdSgdRate={usdSgdRate}
                    timeframe="all"
                  />
                </div>
              )}
            </section>
          )}
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
            accept=".pdf,.txt,.csv"
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
