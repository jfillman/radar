import { useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import { AlertCircle, DollarSign, HelpCircle, Loader2, TrendingUp } from 'lucide-react'
import {
  useOpenCostWorkload,
  useOpenCostWorkloadTrend,
  COST_DISCOVERY_GRACE_MS,
  type CostTimeRange,
  type CostUnavailableReason,
  type OpenCostTrendDataPoint,
  type OpenCostWorkloadDetailResponse,
  type OpenCostWorkloadTrendResponse,
} from '../../api/client'
import { Tooltip } from '../ui/Tooltip'
import { formatCostAxis } from './format'

const TIME_RANGES: { value: CostTimeRange; label: string }[] = [
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
]

type WorkloadCostState = 'loading' | 'data' | 'partial_missing_history' | 'partial_missing_current' | 'zero' | 'load_error' | CostUnavailableReason

interface WorkloadCostQueryStatus {
  currentLoading?: boolean
  trendLoading?: boolean
  currentError?: boolean
  trendError?: boolean
}

interface WorkloadCostTabProps {
  kind: string
  namespace: string
  name: string
}

export function WorkloadCostTab({ kind, namespace, name }: WorkloadCostTabProps) {
  const [range, setRange] = useState<CostTimeRange>('24h')
  const [noPrometheusSince, setNoPrometheusSince] = useState<number | null>(null)
  const currentQuery = useOpenCostWorkload(kind, namespace, name)
  const trendQuery = useOpenCostWorkloadTrend(kind, namespace, name, range)

  const state = getWorkloadCostState(currentQuery.data, trendQuery.data, {
    currentLoading: currentQuery.isLoading,
    trendLoading: trendQuery.isLoading,
    currentError: currentQuery.isError,
    trendError: trendQuery.isError,
  })

  useEffect(() => {
    if (state === 'no_prometheus') {
      setNoPrometheusSince((prev) => prev ?? Date.now())
    } else {
      setNoPrometheusSince(null)
    }
  }, [state])

  if (state === 'loading') {
    return (
      <div className="flex h-full min-h-[320px] items-center justify-center text-theme-text-tertiary">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading workload cost…
      </div>
    )
  }

  if (state === 'no_prometheus' || state === 'no_metrics' || state === 'query_error' || state === 'load_error') {
    const discoveryAgeMs = noPrometheusSince == null ? 0 : Date.now() - noPrometheusSince
    if (state === 'no_prometheus' && discoveryAgeMs < COST_DISCOVERY_GRACE_MS) {
      return (
        <WorkloadCostDiscovering
          isFetching={currentQuery.isFetching || trendQuery.isFetching}
          onRetry={() => {
            setNoPrometheusSince(Date.now())
            currentQuery.refetch()
            trendQuery.refetch()
          }}
        />
      )
    }
    return <WorkloadCostUnavailable state={state} />
  }

  const current = currentQuery.data?.current
  const trend = trendQuery.data
  const points = trend?.available ? trend.dataPoints ?? [] : []
  const hasTrend = points.length >= 2 && points.some((p) => p.value > 0)
  const hasCurrent = Boolean(current)
  const trendLoading = trendQuery.isLoading && !trend
  const hourly = current?.hourlyCost ?? 0
  const monthly = hourly * 730
  const windowTotal = trend?.available ? trend.windowTotalCost ?? 0 : 0
  const cpuCost = current?.cpuCost ?? 0
  const memoryCost = current?.memoryCost ?? 0
  const splitTotal = cpuCost + memoryCost
  const cpuPct = splitTotal > 0 ? (cpuCost / splitTotal) * 100 : 0
  const memoryPct = splitTotal > 0 ? (memoryCost / splitTotal) * 100 : 0
  const windowSpendValue = hasTrend
    ? `~${formatCost(windowTotal)}`
    : trendLoading || state === 'partial_missing_history'
      ? '—'
      : formatCost(0)

  return (
    <div className="mx-auto max-w-[1100px] space-y-4">
      <section className="rounded-lg border border-theme-border bg-theme-surface/50">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-theme-border px-4 py-3">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-theme-text-tertiary" />
            <div>
              <div className="flex items-center gap-1.5">
                <div className="text-sm font-semibold text-theme-text-primary">Historical compute cost</div>
                <MetricInfoTooltip
                  content="Dollars are based on OpenCost CPU and memory allocation over time, not raw utilization. Efficiency compares actual usage against that allocated cost."
                />
              </div>
              <div className="text-xs text-theme-text-tertiary">CPU and memory allocation attributed by workload ownership</div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {TIME_RANGES.map((tr) => (
              <button
                key={tr.value}
                onClick={() => setRange(tr.value)}
                className={clsx(
                  'rounded-md px-2 py-1 text-xs transition-colors',
                  range === tr.value
                    ? 'bg-accent-muted text-accent-text font-medium'
                    : 'text-theme-text-tertiary hover:bg-theme-hover hover:text-theme-text-primary',
                )}
              >
                {tr.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-4 p-4 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="space-y-4">
            <MetricBlock
              label={`Spend over ${range}`}
              value={windowSpendValue}
              subvalue={state === 'partial_missing_history' ? 'Historical data unavailable' : undefined}
            />
            <MetricBlock
              label="Current rate"
              value={hasCurrent ? `${formatCost(hourly)}/hr` : '—'}
              subvalue={hasCurrent ? `~${formatCost(monthly)}/mo at this rate` : 'Current allocation unavailable'}
            />
          </div>
          <div className="min-w-0">
            {trendLoading ? (
              <div className="flex h-[240px] items-center justify-center rounded-md border border-dashed border-theme-border bg-theme-base/60 text-sm text-theme-text-tertiary">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading historical cost…
              </div>
            ) : hasTrend ? (
              <WorkloadCostLineChart points={points} />
            ) : (
              <div className="flex h-[240px] items-center justify-center rounded-md border border-dashed border-theme-border bg-theme-base/60 text-sm text-theme-text-tertiary">
                No historical workload owner cost points for this range.
              </div>
            )}
          </div>
        </div>
      </section>

      {state === 'partial_missing_history' && (
        <div className="flex items-start gap-2 rounded-lg border border-theme-border bg-theme-base px-3 py-2 text-sm text-theme-text-secondary">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-theme-text-tertiary" />
          <span>Current cost is available, but historical workload owner metrics are not available for this range.</span>
        </div>
      )}
      {state === 'partial_missing_current' && (
        <div className="flex items-start gap-2 rounded-lg border border-theme-border bg-theme-base px-3 py-2 text-sm text-theme-text-secondary">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-theme-text-tertiary" />
          <span>Historical cost is available, but current workload allocation metrics are not available.</span>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <MetricTile label="Replicas" value={hasCurrent ? String(current?.replicas ?? 0) : '—'} />
        <MetricTile
          label="Efficiency"
          value={hasCurrent ? (current?.efficiency ? `${current.efficiency.toFixed(0)}%` : '0%') : '—'}
          subvalue={hasCurrent ? `${formatCost(current?.idleCost ?? 0)}/hr idle` : 'Current allocation unavailable'}
          tooltip="Actual CPU and memory usage divided by allocated CPU and memory cost for the last hour. Low efficiency usually means requested capacity is sitting idle."
        />
        <MetricTile
          label="Monthly projection"
          value={hasCurrent ? `~${formatCost(monthly)}` : '—'}
          subvalue={hasCurrent ? 'From current hourly rate' : 'Current allocation unavailable'}
        />
      </div>

      <section className="rounded-lg border border-theme-border bg-theme-surface/50 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5">
              <div className="text-sm font-semibold text-theme-text-primary">Current cost split</div>
              <MetricInfoTooltip content="Last-hour allocated CPU and memory cost for this workload. This is the cost of reserved/requested capacity, not only what the containers used." />
            </div>
            <div className="text-xs text-theme-text-tertiary">Last 1h OpenCost allocation window</div>
          </div>
          <div className="text-sm font-medium text-theme-text-primary tabular-nums">{hasCurrent ? `${formatCost(splitTotal)}/hr` : '—'}</div>
        </div>
        <div className="h-3 overflow-hidden rounded-full bg-theme-hover">
          <div className="flex h-full">
            {hasCurrent && (
              <>
                <div className="h-full bg-accent" style={{ width: `${cpuPct}%` }} />
                <div className="h-full bg-[var(--color-info)]" style={{ width: `${memoryPct}%` }} />
              </>
            )}
          </div>
        </div>
        <div className="mt-3 grid gap-2 text-xs text-theme-text-secondary sm:grid-cols-2">
          <LegendItem colorClass="bg-accent" label="CPU" value={hasCurrent ? `${formatCost(cpuCost)}/hr` : '—'} />
          <LegendItem colorClass="bg-[var(--color-info)]" label="Memory" value={hasCurrent ? `${formatCost(memoryCost)}/hr` : '—'} />
        </div>
      </section>

      <div className="text-xs text-theme-text-tertiary">
        Powered by OpenCost via Prometheus. Workload cost currently includes CPU and memory allocation; storage/PVC attribution remains at namespace and cluster level.
      </div>
    </div>
  )
}

export function getWorkloadCostState(
  current: OpenCostWorkloadDetailResponse | undefined,
  trend: OpenCostWorkloadTrendResponse | undefined,
  status: boolean | WorkloadCostQueryStatus,
): WorkloadCostState {
  const queryStatus: WorkloadCostQueryStatus = typeof status === 'boolean'
    ? { currentLoading: status, trendLoading: status }
    : status
  const loading = Boolean(queryStatus.currentLoading || queryStatus.trendLoading)
  const queryError = Boolean(queryStatus.currentError || queryStatus.trendError)

  const currentRow = current?.available ? current.current : undefined
  const trendHasData = trend?.available === true && (trend.dataPoints ?? []).some((p) => p.value > 0)
  if (currentRow) {
    if (queryStatus.trendLoading && !trend) return 'data'
    if (queryStatus.trendError || (trend?.available === false && trend.reason !== 'no_metrics')) return 'partial_missing_history'
    if (currentRow.hourlyCost === 0 && currentRow.replicas === 0 && !trendHasData) return 'zero'
    if (!trend?.available) return 'partial_missing_history'
    return 'data'
  }
  if (trendHasData) return 'partial_missing_current'
  if (queryError) return 'load_error'
  if (loading) return 'loading'

  const reason = current?.reason ?? trend?.reason
  if (reason === 'no_prometheus' || reason === 'query_error') return reason
  return 'no_metrics'
}

function WorkloadCostDiscovering({ isFetching, onRetry }: { isFetching: boolean; onRetry: () => void }) {
  return (
    <div className="flex h-full min-h-[320px] items-center justify-center">
      <div className="flex max-w-md flex-col items-center gap-3 text-center text-theme-text-secondary">
        <Loader2 className="h-8 w-8 animate-spin text-theme-text-tertiary/60" />
        <div>
          <p className="text-sm font-medium text-theme-text-primary">Looking for Prometheus cost data…</p>
          <p className="mt-1 text-xs text-theme-text-tertiary">
            First discovery can take a few seconds while Radar checks cluster services and opens a local port-forward.
          </p>
        </div>
        <button
          onClick={onRetry}
          disabled={isFetching}
          className="text-xs text-accent-text transition-colors hover:text-theme-text-primary disabled:cursor-not-allowed disabled:text-theme-text-disabled"
        >
          {isFetching ? 'Checking…' : 'Check again'}
        </button>
      </div>
    </div>
  )
}

function WorkloadCostUnavailable({ state }: { state: CostUnavailableReason | 'load_error' }) {
  const message = state === 'no_prometheus'
    ? 'Prometheus not found. OpenCost workload cost requires Prometheus or VictoriaMetrics.'
    : state === 'query_error'
      ? 'Cost data is temporarily unavailable. Prometheus was found, but workload cost queries failed.'
      : state === 'load_error'
        ? 'Could not load workload cost data. Check access to this workload and try again.'
        : 'OpenCost workload metrics were not found for this workload.'

  return (
    <div className="flex h-full min-h-[320px] items-center justify-center">
      <div className="flex max-w-md flex-col items-center gap-3 text-center text-theme-text-secondary">
        <DollarSign className="h-8 w-8 text-theme-text-tertiary/50" />
        <div className="text-sm">{message}</div>
      </div>
    </div>
  )
}

function MetricBlock({ label, value, subvalue }: { label: string; value: string; subvalue?: string }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase text-theme-text-tertiary">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-theme-text-primary tabular-nums">{value}</div>
      {subvalue && <div className="mt-1 text-xs text-theme-text-tertiary">{subvalue}</div>}
    </div>
  )
}

function MetricTile({ label, value, subvalue, tooltip }: { label: string; value: string; subvalue?: string; tooltip?: string }) {
  return (
    <div className="rounded-lg border border-theme-border bg-theme-surface/50 p-4">
      <div className="flex items-center gap-1.5">
        <div className="text-xs font-medium uppercase text-theme-text-tertiary">{label}</div>
        {tooltip && <MetricInfoTooltip content={tooltip} />}
      </div>
      <div className="mt-1 text-lg font-semibold text-theme-text-primary tabular-nums">{value}</div>
      {subvalue && <div className="mt-1 text-xs text-theme-text-tertiary">{subvalue}</div>}
    </div>
  )
}

function MetricInfoTooltip({ content }: { content: string }) {
  return (
    <Tooltip content={content} className="max-w-[280px] whitespace-normal text-left" delay={150}>
      <HelpCircle className="h-3.5 w-3.5 cursor-help text-theme-text-tertiary transition-colors hover:text-theme-text-secondary" />
    </Tooltip>
  )
}

function LegendItem({ colorClass, label, value }: { colorClass: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-theme-base px-2.5 py-2">
      <span className="flex items-center gap-2">
        <span className={clsx('h-2.5 w-2.5 rounded-sm', colorClass)} />
        {label}
      </span>
      <span className="font-medium tabular-nums text-theme-text-primary">{value}</span>
    </div>
  )
}

function WorkloadCostLineChart({ points }: { points: OpenCostTrendDataPoint[] }) {
  const chart = useMemo(() => buildLineChart(points), [points])
  if (!chart) return null

  return (
    <div className="h-[240px] w-full">
      <svg viewBox="0 0 720 240" className="h-full w-full overflow-visible">
        {chart.yTicks.map((tick) => (
          <g key={tick.y}>
            <line x1="44" x2="704" y1={tick.y} y2={tick.y} stroke="var(--border-subtle)" />
            <text x="34" y={tick.y + 4} textAnchor="end" className="fill-theme-text-tertiary text-[10px]">
              {formatCostAxis(tick.value)}
            </text>
          </g>
        ))}
        <path d={chart.areaPath} fill="var(--accent-muted)" />
        <path d={chart.linePath} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <text x="44" y="232" className="fill-theme-text-tertiary text-[10px]">
          {formatChartTime(points[0]?.timestamp)}
        </text>
        <text x="704" y="232" textAnchor="end" className="fill-theme-text-tertiary text-[10px]">
          {formatChartTime(points[points.length - 1]?.timestamp)}
        </text>
      </svg>
    </div>
  )
}

export function buildLineChart(points: OpenCostTrendDataPoint[]) {
  if (points.length < 2) return null
  const width = 720
  const height = 240
  const left = 44
  const right = 16
  const top = 14
  const bottom = 28
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const minTs = points[0].timestamp
  const maxTs = points[points.length - 1].timestamp
  if (maxTs <= minTs) return null
  const maxValue = Math.max(...points.map((p) => p.value), 0)
  const yMax = maxValue > 0 ? maxValue * 1.15 : 1
  const toX = (ts: number) => left + ((ts - minTs) / (maxTs - minTs)) * plotWidth
  const toY = (value: number) => top + plotHeight - (value / yMax) * plotHeight
  const coords = points.map((p) => [toX(p.timestamp), toY(p.value)] as const)
  const linePath = coords.map(([x, y], idx) => `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const baseline = top + plotHeight
  const areaPath = `${linePath} L ${coords[coords.length - 1][0].toFixed(1)} ${baseline.toFixed(1)} L ${coords[0][0].toFixed(1)} ${baseline.toFixed(1)} Z`
  const yTicks = [0, 0.5, 1].map((pct) => ({
    value: yMax * pct,
    y: top + plotHeight - pct * plotHeight,
  }))
  return { linePath, areaPath, yTicks }
}

function formatCost(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '$0.00'
  if (value < 0.0001) return formatCostAxis(value)
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

function formatChartTime(timestamp?: number) {
  if (!timestamp) return ''
  return new Date(timestamp * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
  })
}
