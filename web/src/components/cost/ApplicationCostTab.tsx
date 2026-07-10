import { useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import { AlertCircle, DollarSign, HelpCircle, Loader2, TrendingUp } from 'lucide-react'
import type { AppRow, AppWorkload } from '@skyhook-io/k8s-ui'
import {
  COST_DISCOVERY_GRACE_MS,
  useOpenCostApplicationCost,
  useOpenCostApplicationCostTrend,
  type CostTimeRange,
  type CostUnavailableReason,
  type OpenCostApplicationCostResponse,
  type OpenCostApplicationCostTrendResponse,
  type OpenCostApplicationWorkloadCost,
  type OpenCostTrendSeries,
} from '../../api/client'
import { Tooltip } from '../ui/Tooltip'
import { StackedAreaChart } from './CostTrendChart'
import { formatCost, formatCostPerHour } from './format'
import { isOpenCostWorkloadKind } from './kinds'

const TIME_RANGES: { value: CostTimeRange; label: string }[] = [
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
]

type ApplicationCostState = 'loading' | 'data' | 'partial_missing_history' | 'partial_missing_current' | 'zero' | 'load_error' | CostUnavailableReason

interface ApplicationCostQueryStatus {
  currentLoading?: boolean
  trendLoading?: boolean
  currentError?: boolean
  trendError?: boolean
}

interface ApplicationCostTabProps {
  app: AppRow
  workloads: AppWorkload[]
  onSelectWorkloadCost?: (workload: AppWorkload) => void
}

export function ApplicationCostTab({ app, workloads, onSelectWorkloadCost }: ApplicationCostTabProps) {
  const [range, setRange] = useState<CostTimeRange>('24h')
  const [noPrometheusSince, setNoPrometheusSince] = useState<number | null>(null)
  const currentQuery = useOpenCostApplicationCost(workloads)
  const trendQuery = useOpenCostApplicationCostTrend(workloads, range)
  const trendMatchesRange = trendQuery.data?.range === range
  const trendData = trendMatchesRange ? trendQuery.data : undefined
  const trendLoading = trendQuery.isLoading || (trendQuery.isFetching && Boolean(trendQuery.data) && !trendMatchesRange)
  const state = getApplicationCostState(currentQuery.data, trendData, {
    currentLoading: currentQuery.isLoading,
    trendLoading,
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

  const supportedCount = workloads.filter((w) => isOpenCostWorkloadKind(w.kind)).length
  const chartSeries = useMemo(() => applicationChartSeries(trendData), [trendData])
  const workloadByKey = useMemo(() => {
    const map = new Map<string, AppWorkload>()
    for (const workload of workloads) map.set(applicationCostKey(workload), workload)
    return map
  }, [workloads])

  if (supportedCount === 0) {
    return <ApplicationCostUnavailable state="no_metrics" message="No steady-state workloads in this app are supported by workload cost yet." />
  }

  if (state === 'loading') {
    return (
      <div className="flex h-full min-h-[320px] items-center justify-center text-theme-text-tertiary">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading application cost…
      </div>
    )
  }

  if (state === 'no_prometheus' || state === 'no_metrics' || state === 'query_error' || state === 'load_error') {
    const discoveryAgeMs = noPrometheusSince == null ? 0 : Date.now() - noPrometheusSince
    if (state === 'no_prometheus' && discoveryAgeMs < COST_DISCOVERY_GRACE_MS) {
      return (
        <ApplicationCostDiscovering
          isFetching={currentQuery.isFetching || trendQuery.isFetching}
          onRetry={() => {
            setNoPrometheusSince(Date.now())
            currentQuery.refetch()
            trendQuery.refetch()
          }}
        />
      )
    }
    return <ApplicationCostUnavailable state={state} />
  }

  const current = currentQuery.data
  const trend = trendData
  const hasCurrent = current?.available === true && (current.coverage?.included ?? 0) > 0
  const totals = hasCurrent ? current?.totals : undefined
  const coverage = current?.coverage ?? trend?.coverage
  const included = coverage?.included ?? 0
  const total = coverage?.total ?? workloads.length
  const unavailableCount = coverage?.unavailable?.length ?? 0
  const unsupportedCount = coverage?.unsupported?.length ?? 0
  const hourly = totals?.hourlyCost ?? 0
  const monthly = hourly * 730
  const currentSplit = (totals?.cpuCost ?? 0) + (totals?.memoryCost ?? 0)
  const cpuPct = currentSplit > 0 ? ((totals?.cpuCost ?? 0) / currentSplit) * 100 : 0
  const memoryPct = currentSplit > 0 ? ((totals?.memoryCost ?? 0) / currentSplit) * 100 : 0
  const points = trend?.available ? trend.dataPoints ?? [] : []
  const hasTrend = points.length >= 2 && points.some((p) => p.value > 0)
  const rows = current?.workloads ?? []
  const maxCost = Math.max(...rows.map((row) => row.current?.hourlyCost ?? 0), 0)

  return (
    <div className="mx-auto max-w-[1180px] space-y-4">
      {(current?.partial || trend?.partial || state === 'partial_missing_history' || state === 'partial_missing_current') && (
        <div className="flex items-start gap-2 rounded-lg border border-theme-border bg-theme-base px-3 py-2 text-sm text-theme-text-secondary">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-theme-text-tertiary" />
          <span>
            Showing tracked steady-state compute for {included} of {total} workloads.
            {unavailableCount > 0 ? ` ${unavailableCount} workload${unavailableCount === 1 ? '' : 's'} had no cost metrics for this window.` : ''}
            {unsupportedCount > 0 ? ` ${unsupportedCount} job/batch or unsupported workload${unsupportedCount === 1 ? '' : 's'} excluded until that cost model lands.` : ''}
          </span>
        </div>
      )}

      <section className="rounded-lg border border-theme-border bg-theme-surface/50">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-theme-border px-4 py-3">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-theme-text-tertiary" />
            <div>
              <div className="flex items-center gap-1.5">
                <div className="text-sm font-semibold text-theme-text-primary">Application compute cost</div>
                <CostInfoTooltip content="Dollars are based on OpenCost CPU and memory allocation over time, grouped by the workloads in this application. This is allocated/requested compute cost, not raw utilization alone." />
              </div>
              <div className="text-xs text-theme-text-tertiary">{app.name} · Deployment, StatefulSet, and DaemonSet workloads</div>
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
                    ? 'bg-accent-muted font-medium text-accent-text'
                    : 'text-theme-text-tertiary hover:bg-theme-hover hover:text-theme-text-primary',
                )}
              >
                {tr.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-4 p-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          <div className="space-y-4">
            <CostMetricBlock
              label={`Spend over ${range}`}
              value={hasTrend ? `~${formatCost(trend?.windowTotalCost ?? 0)}` : trendLoading || state === 'partial_missing_history' ? '—' : formatCost(0)}
              subvalue={state === 'partial_missing_history' ? 'Historical data incomplete' : `${included} of ${total} workloads included`}
            />
            <CostMetricBlock
              label="Current rate"
              value={totals ? formatCostPerHour(hourly) : '—'}
              subvalue={totals ? `~${formatCost(monthly)}/mo at this rate` : 'Current allocation unavailable'}
            />
          </div>
          <div className="min-w-0">
            {trendLoading ? (
              <div className="flex h-[240px] items-center justify-center rounded-md border border-dashed border-theme-border bg-theme-base/60 text-sm text-theme-text-tertiary">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading historical cost…
              </div>
            ) : hasTrend && chartSeries.length > 0 ? (
              <div className="min-w-0">
                <StackedAreaChart series={chartSeries} />
              </div>
            ) : (
              <div className="flex h-[240px] items-center justify-center rounded-md border border-dashed border-theme-border bg-theme-base/60 text-sm text-theme-text-tertiary">
                No historical workload owner cost points for this range.
              </div>
            )}
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <CostMetricTile label="Tracked workloads" value={`${included}/${total}`} subvalue={unsupportedCount > 0 ? `${unsupportedCount} unsupported` : 'All supported workloads included'} />
        <CostMetricTile
          label="Efficiency"
          value={totals ? `${(totals.efficiency ?? 0).toFixed(0)}%` : '—'}
          subvalue={totals ? `${formatCost(totals.idleCost ?? 0)}/hr idle` : 'Current allocation unavailable'}
          tooltip="Actual CPU and memory usage divided by allocated CPU and memory cost across included workloads. Low efficiency usually means requested capacity is sitting idle."
        />
        <CostMetricTile
          label="Monthly projection"
          value={totals ? `~${formatCost(monthly)}` : '—'}
          subvalue={totals ? 'From current hourly rate' : 'Current allocation unavailable'}
        />
      </div>

      <section className="rounded-lg border border-theme-border bg-theme-surface/50 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5">
              <div className="text-sm font-semibold text-theme-text-primary">Current split</div>
              <CostInfoTooltip content="Last-hour allocated CPU and memory cost summed across included app workloads. Storage/PVC and network attribution remain at namespace and cluster level." />
            </div>
            <div className="text-xs text-theme-text-tertiary">Last 1h OpenCost allocation window</div>
          </div>
          <div className="text-sm font-medium text-theme-text-primary tabular-nums">{totals ? formatCostPerHour(currentSplit) : '—'}</div>
        </div>
        <div className="h-3 overflow-hidden rounded-full bg-theme-hover">
          <div className="flex h-full">
            {totals && (
              <>
                <div className="h-full bg-accent" style={{ width: `${cpuPct}%` }} />
                <div className="h-full bg-[var(--color-info)]" style={{ width: `${memoryPct}%` }} />
              </>
            )}
          </div>
        </div>
        <div className="mt-3 grid gap-2 text-xs text-theme-text-secondary sm:grid-cols-2">
          <CostLegendItem colorClass="bg-accent" label="CPU" value={totals ? formatCostPerHour(totals.cpuCost ?? 0) : '—'} />
          <CostLegendItem colorClass="bg-[var(--color-info)]" label="Memory" value={totals ? formatCostPerHour(totals.memoryCost ?? 0) : '—'} />
        </div>
      </section>

      <section className="rounded-lg border border-theme-border bg-theme-surface/50">
        <div className="flex items-center justify-between border-b border-theme-border px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-theme-text-primary">Workload contributors</div>
            <div className="text-xs text-theme-text-tertiary">Current hourly allocation, sorted by spend</div>
          </div>
          <div className="text-xs text-theme-text-tertiary">{rows.length} tracked</div>
        </div>
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-sm text-theme-text-tertiary">No workload cost rows available for this application.</div>
        ) : (
          <div className="divide-y divide-theme-border/60">
            {rows.map((row) => {
              const appWorkload = workloadByKey.get(applicationCostKey(row))
              return (
                <ApplicationWorkloadCostRow
                  key={applicationCostKey(row)}
                  row={row}
                  maxCost={maxCost}
                  onOpen={appWorkload && onSelectWorkloadCost ? () => onSelectWorkloadCost(appWorkload) : undefined}
                />
              )
            })}
          </div>
        )}
      </section>

      <div className="text-xs text-theme-text-tertiary">
        Powered by OpenCost via Prometheus. Application cost currently includes CPU and memory allocation for Deployment, StatefulSet, and DaemonSet workloads; batch/job and storage attribution are handled separately.
      </div>
    </div>
  )
}

export function getApplicationCostState(
  current: OpenCostApplicationCostResponse | undefined,
  trend: OpenCostApplicationCostTrendResponse | undefined,
  status: ApplicationCostQueryStatus,
): ApplicationCostState {
  const loading = Boolean(status.currentLoading || status.trendLoading)
  const queryError = Boolean(status.currentError || status.trendError)
  const currentHasData = current?.available === true && (current.coverage?.included ?? 0) > 0
  const trendHasData = trend?.available === true && (trend.dataPoints ?? []).some((p) => p.value > 0)
  if (currentHasData) {
    if (status.trendLoading && !trend) return 'data'
    if (status.trendError || (trend?.available === false && trend.reason !== 'no_metrics')) return 'partial_missing_history'
    if ((current?.totals?.hourlyCost ?? 0) === 0 && !trendHasData) return 'zero'
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

function ApplicationWorkloadCostRow({ row, maxCost, onOpen }: { row: OpenCostApplicationWorkloadCost; maxCost: number; onOpen?: () => void }) {
  const current = row.current
  const hourly = current?.hourlyCost ?? 0
  const monthly = hourly * 730
  const cpuPct = hourly > 0 ? ((current?.cpuCost ?? 0) / hourly) * 100 : 0
  const barWidth = maxCost > 0 ? Math.max((hourly / maxCost) * 100, 3) : 0
  const content = (
    <>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded bg-theme-base px-1.5 py-0.5 text-[10px] uppercase text-theme-text-tertiary">{row.kind}</span>
          <span className="truncate text-sm font-medium text-theme-text-primary">{row.name}</span>
          <span className="shrink-0 text-xs text-theme-text-tertiary">{row.namespace}</span>
        </div>
        {!row.available && <div className="mt-0.5 text-xs text-theme-text-tertiary">{reasonLabel(row.reason)}</div>}
      </div>
      <div className="text-right text-sm font-medium tabular-nums text-theme-text-primary">{current ? formatCostPerHour(hourly) : '—'}</div>
      <div className="hidden text-right text-xs tabular-nums text-theme-text-tertiary sm:block">{current ? `~${formatCost(monthly)}/mo` : '—'}</div>
      <div className="hidden min-w-0 items-center gap-2 md:flex">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-theme-hover" style={{ maxWidth: `${barWidth}%` }}>
          <div className="flex h-full">
            <div className="h-full bg-accent" style={{ width: `${cpuPct}%` }} />
            <div className="h-full bg-[var(--color-info)]" style={{ width: `${100 - cpuPct}%` }} />
          </div>
        </div>
      </div>
      <div className="hidden text-right text-xs tabular-nums text-theme-text-tertiary lg:block">
        {current ? `${formatCost(current.cpuCost)} / ${formatCost(current.memoryCost)}` : '—'}
      </div>
    </>
  )

  if (!onOpen) {
    return <div className="grid grid-cols-[minmax(180px,1fr)_100px] gap-3 px-4 py-3 sm:grid-cols-[minmax(180px,1fr)_100px_100px] md:grid-cols-[minmax(220px,1fr)_100px_100px_minmax(160px,1fr)] lg:grid-cols-[minmax(220px,1fr)_110px_110px_minmax(180px,1fr)_130px]">{content}</div>
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid w-full grid-cols-[minmax(180px,1fr)_100px] gap-3 px-4 py-3 text-left transition-colors hover:bg-theme-hover sm:grid-cols-[minmax(180px,1fr)_100px_100px] md:grid-cols-[minmax(220px,1fr)_100px_100px_minmax(160px,1fr)] lg:grid-cols-[minmax(220px,1fr)_110px_110px_minmax(180px,1fr)_130px]"
    >
      {content}
    </button>
  )
}

function applicationChartSeries(trend: OpenCostApplicationCostTrendResponse | undefined): OpenCostTrendSeries[] {
  return (trend?.series ?? [])
    .filter((series) => (series.dataPoints ?? []).length >= 2)
    .map((series) => ({
      namespace: `${series.name} (${series.kind})`,
      dataPoints: series.dataPoints ?? [],
    }))
}

function applicationCostKey(ref: { kind: string; namespace: string; name: string }) {
  return `${ref.kind}/${ref.namespace}/${ref.name}`
}

function reasonLabel(reason?: CostUnavailableReason) {
  if (reason === 'no_prometheus') return 'Prometheus not found'
  if (reason === 'query_error') return 'Cost query failed'
  return 'No workload cost metrics'
}

function ApplicationCostDiscovering({ isFetching, onRetry }: { isFetching: boolean; onRetry: () => void }) {
  return (
    <div className="flex h-full min-h-[320px] items-center justify-center">
      <div className="flex max-w-md flex-col items-center gap-3 text-center text-theme-text-secondary">
        <Loader2 className="h-8 w-8 animate-spin text-theme-text-tertiary/60" />
        <div>
          <p className="text-sm font-medium text-theme-text-primary">Looking for Prometheus cost data…</p>
          <p className="mt-1 text-xs text-theme-text-tertiary">First discovery can take a few seconds while Radar checks cluster services and opens a local port-forward.</p>
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

function ApplicationCostUnavailable({ state, message }: { state: CostUnavailableReason | 'load_error'; message?: string }) {
  const text = message ?? (
    state === 'no_prometheus'
      ? 'Prometheus not found. OpenCost application cost requires Prometheus or VictoriaMetrics.'
      : state === 'query_error'
        ? 'Cost data is temporarily unavailable. Prometheus was found, but application cost queries failed.'
        : state === 'load_error'
          ? 'Could not load application cost data. Check access to these workloads and try again.'
          : 'OpenCost workload metrics were not found for this application.'
  )
  return (
    <div className="flex h-full min-h-[320px] items-center justify-center">
      <div className="flex max-w-md flex-col items-center gap-3 text-center text-theme-text-secondary">
        <DollarSign className="h-8 w-8 text-theme-text-tertiary/50" />
        <div className="text-sm">{text}</div>
      </div>
    </div>
  )
}

function CostMetricBlock({ label, value, subvalue }: { label: string; value: string; subvalue?: string }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase text-theme-text-tertiary">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-theme-text-primary tabular-nums">{value}</div>
      {subvalue && <div className="mt-1 text-xs text-theme-text-tertiary">{subvalue}</div>}
    </div>
  )
}

function CostMetricTile({ label, value, subvalue, tooltip }: { label: string; value: string; subvalue?: string; tooltip?: string }) {
  return (
    <div className="rounded-lg border border-theme-border bg-theme-surface/50 p-4">
      <div className="flex items-center gap-1.5">
        <div className="text-xs font-medium uppercase text-theme-text-tertiary">{label}</div>
        {tooltip && <CostInfoTooltip content={tooltip} />}
      </div>
      <div className="mt-1 text-lg font-semibold text-theme-text-primary tabular-nums">{value}</div>
      {subvalue && <div className="mt-1 text-xs text-theme-text-tertiary">{subvalue}</div>}
    </div>
  )
}

function CostInfoTooltip({ content }: { content: string }) {
  return (
    <Tooltip content={content} className="max-w-[280px] whitespace-normal text-left" delay={150}>
      <HelpCircle className="h-3.5 w-3.5 cursor-help text-theme-text-tertiary transition-colors hover:text-theme-text-secondary" />
    </Tooltip>
  )
}

function CostLegendItem({ colorClass, label, value }: { colorClass: string; label: string; value: string }) {
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
