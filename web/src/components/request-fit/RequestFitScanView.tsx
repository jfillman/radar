import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AlertTriangle, ChevronRight, ExternalLink, Gauge, Loader2, RefreshCw, Search, X } from 'lucide-react'
import { EmptyState, Input, PageHeader } from '@skyhook-io/k8s-ui'
import { Badge } from '@skyhook-io/k8s-ui/components/ui/Badge'
import {
  useAutoPromConnect,
  useClusterInfo,
  usePrometheusStatus,
  useRequestFitScan,
  type RightsizingRow,
} from '../../api/client'
import { REQUEST_FIT_DOCS_URL, getRequestFitExplanation, getRequestFitPresentation } from '../resource/RightsizingStrip'
import { buildWorkloadPath } from '../../utils/navigation'
import { flattenScanResults, scanClassCounts, type RequestFitScanRow, type ScanClass, type ScanSignal } from './model'

export const REQUEST_FIT_SCAN_DESCRIPTION = 'Compare CPU and memory requests with recent demand across your visible workloads. Advisory only; Radar never changes requests.'
export const REQUEST_FIT_SCAN_METHODOLOGY = 'Uses seven days of 5-minute samples: CPU P95 and memory P99, plus 15% headroom.'

export type RequestFitScanSurfaceState = 'discovering' | 'prometheus_required' | 'first_run' | 'scanning' | 'fatal_error' | 'unavailable' | 'results'

export function getRequestFitScanSurfaceState(input: {
  statusLoading: boolean
  hasStatus: boolean
  connected: boolean
  pending: boolean
  hasResult: boolean
  hasError: boolean
  resultState?: string
}): RequestFitScanSurfaceState {
  if (input.statusLoading && !input.hasStatus) return 'discovering'
  if (!input.connected) return 'prometheus_required'
  if (input.pending && !input.hasResult) return 'scanning'
  if (input.hasError && !input.hasResult) return 'fatal_error'
  if (!input.hasResult) return 'first_run'
  if (input.resultState === 'unavailable') return 'unavailable'
  return 'results'
}

interface RequestFitScanViewProps {
  namespaces: string[]
}

const CLASS_META: Record<ScanClass, { label: string; severity: 'warning' | 'info' | 'success' | 'neutral'; helper: string }> = {
  needs_review: { label: 'Needs review', severity: 'warning', helper: 'Too low, missing, or safety signal' },
  potential_reduction: { label: 'Potential reductions', severity: 'info', helper: 'Requests may be higher than demand' },
  in_range: { label: 'In range', severity: 'success', helper: 'Requests match recent demand' },
  need_data: { label: 'Need data', severity: 'neutral', helper: 'History, ownership, or query incomplete' },
}

const SIGNAL_LABEL: Record<ScanSignal, string> = {
  hpa: 'HPA', oom: 'OOM', throttling: 'Throttling', query_error: 'Query error', scaled_zero: 'Scaled to zero',
}

const ROW_PAGE_SIZE = 50

export function RequestFitScanView({ namespaces }: RequestFitScanViewProps) {
  useAutoPromConnect()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { data: clusterInfo } = useClusterInfo()
  const { data: promStatus, isLoading: statusLoading, refetch: retryPrometheus } = usePrometheusStatus()
  const scan = useRequestFitScan(namespaces)
  const [result, setResult] = useState<Awaited<ReturnType<typeof scan.mutateAsync>>>()
  const [openRow, setOpenRow] = useState<string | null>(null)
  const [visibleLimit, setVisibleLimit] = useState(ROW_PAGE_SIZE)
  const scopeKey = `${clusterInfo?.context ?? ''}\0${[...namespaces].sort().join(',')}`
  const scopeKeyRef = useRef(scopeKey)
  scopeKeyRef.current = scopeKey

  useEffect(() => {
    setResult(undefined)
    setOpenRow(null)
    scan.reset()
    // A result belongs to exactly one cluster + namespace scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey])

  const runScan = async () => {
    const startedForScope = scopeKey
    try {
      const next = await scan.mutateAsync()
      if (scopeKeyRef.current === startedForScope) setResult(next)
    } catch {
      // Keep a same-scope snapshot visible when a refresh fails.
    }
  }

  const rows = useMemo(() => result ? flattenScanResults(result) : [], [result])
  const counts = useMemo(() => scanClassCounts(rows), [rows])
  const classFilter = params.get('rfClass') as ScanClass | null
  const search = params.get('rfQ') ?? ''
  const kindFilter = params.get('rfKind') ?? ''
  const namespaceFilter = params.get('rfNs') ?? ''
  const signalFilter = params.get('rfSignal') as ScanSignal | null
  const setFilter = (key: string, value?: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }
  const clearFilters = () => {
    const next = new URLSearchParams(params)
    for (const key of ['rfClass', 'rfQ', 'rfKind', 'rfNs', 'rfSignal']) next.delete(key)
    setParams(next, { replace: true })
  }
  const filteredRows = rows.filter((row) => {
    if (classFilter && row.classification !== classFilter) return false
    if (kindFilter && row.kind !== kindFilter) return false
    if (namespaceFilter && row.namespace !== namespaceFilter) return false
    if (signalFilter && !row.signals.has(signalFilter)) return false
    if (search && !`${row.namespace} ${row.name} ${row.container} ${row.kind}`.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })
  const visibleRows = filteredRows.slice(0, visibleLimit)

  useEffect(() => {
    setVisibleLimit(ROW_PAGE_SIZE)
  }, [classFilter, search, kindFilter, namespaceFilter, signalFilter])
  const kinds = [...new Set(rows.map((row) => row.kind))].sort()
  const resultNamespaces = [...new Set(rows.map((row) => row.namespace))].sort()
  const activeFilters = Boolean(classFilter || search || kindFilter || namespaceFilter || signalFilter)
  const surfaceState = getRequestFitScanSurfaceState({
    statusLoading,
    hasStatus: Boolean(promStatus),
    connected: promStatus?.connected === true,
    pending: scan.isPending,
    hasResult: Boolean(result),
    hasError: Boolean(scan.error),
    resultState: result?.state,
  })

  const openWorkload = (row: RequestFitScanRow) => {
    navigate(`${buildWorkloadPath({ kind: row.kind, namespace: row.namespace, name: row.name })}?tab=cost`)
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1920px] flex-col gap-4 px-6 py-6">
        <PageHeader
          icon={Gauge}
          title="Request fit"
          description={REQUEST_FIT_SCAN_DESCRIPTION}
          actions={
            <>
              <a href={REQUEST_FIT_DOCS_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent-text hover:underline">
                How it works <ExternalLink className="h-3 w-3" />
              </a>
              {result?.scannedAt && <span className="text-xs text-theme-text-tertiary">Scanned {formatScanTime(result.scannedAt)}</span>}
              {result && (
                <button type="button" onClick={runScan} disabled={scan.isPending} className="btn-brand inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium">
                  <RefreshCw className={`h-3.5 w-3.5 ${scan.isPending ? 'animate-spin' : ''}`} />
                  {scan.isPending ? 'Scanning…' : 'Run again'}
                </button>
              )}
            </>
          }
        />

        {surfaceState === 'discovering' ? (
          <CenteredState loading title="Looking for Prometheus…" body="Radar is checking the current cluster for workload metrics." />
        ) : surfaceState === 'prometheus_required' ? (
          <CenteredState
            title="Prometheus is required"
            body="Connect Prometheus to scan workload request fit. Radar reads metrics only and never changes requests."
            action={<button type="button" onClick={() => retryPrometheus()} className="btn-brand px-3 py-1.5 text-xs font-medium">Check again</button>}
          />
        ) : surfaceState === 'first_run' ? (
          <FirstRunState namespaces={namespaces} onRun={runScan} />
        ) : surfaceState === 'scanning' ? (
          <CenteredState loading title="Scanning workload requests…" body="Querying recent CPU and memory demand for the current scope. This can take a moment on large clusters." />
        ) : surfaceState === 'fatal_error' ? (
          <CenteredState
            title="Request fit scan failed"
            body={errorMessage(scan.error)}
            action={<button type="button" onClick={runScan} className="btn-brand px-3 py-1.5 text-xs font-medium">Try again</button>}
          />
        ) : surfaceState === 'unavailable' && result ? (
          <CenteredState
            title="Request fit is unavailable"
            body={unavailableMessage(result.reason)}
            action={<button type="button" onClick={runScan} disabled={scan.isPending} className="btn-brand px-3 py-1.5 text-xs font-medium">Try again</button>}
          />
        ) : result ? (
          <div className={`flex flex-col gap-4 transition-opacity ${scan.isPending ? 'opacity-70' : ''}`}>
            {scan.error && (
              <Notice tone="warning" text={`Refresh failed; showing results from ${formatScanTime(result.scannedAt)}. ${errorMessage(scan.error)}`} />
            )}
            {scan.isPending && <Notice text="Scanning the current scope. Previous results remain visible until the scan completes." />}
            <ScanSummary result={result} counts={counts} selected={classFilter} onSelect={(value) => setFilter('rfClass', classFilter === value ? undefined : value)} />
            <ScanNotices result={result} rows={rows} />
            {result.coverage.workloadsDiscovered === 0 || rows.length === 0 ? (
              <EmptyState
                variant="card"
                headline="No supported workloads in this scope"
                body="No Deployment, StatefulSet, or DaemonSet containers are visible in the selected namespaces."
              />
            ) : (
              <section className="overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-theme-sm">
                <ScanFilters
                  search={search} onSearch={(value) => setFilter('rfQ', value || undefined)}
                  kind={kindFilter} kinds={kinds} onKind={(value) => setFilter('rfKind', value || undefined)}
                  namespace={namespaceFilter} namespaces={resultNamespaces} onNamespace={(value) => setFilter('rfNs', value || undefined)}
                  signal={signalFilter} onSignal={(value) => setFilter('rfSignal', value || undefined)}
                  shown={filteredRows.length} total={rows.length} onClear={clearFilters} active={activeFilters}
                />
                {filteredRows.length === 0 ? (
                  <EmptyState
                    tone="filtered"
                    headline="No results match the current filters"
                    body="Clear a filter to see more scan results."
                    action={<button type="button" onClick={clearFilters} className="badge badge-sm border border-theme-border bg-theme-elevated text-theme-text-primary">Clear all filters</button>}
                  />
                ) : (
                  <div>
                    <div className="grid grid-cols-[minmax(260px,1.35fr)_minmax(190px,1fr)_minmax(190px,1fr)_minmax(150px,.8fr)_28px] gap-3 border-b border-theme-border px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-theme-text-tertiary">
                      <span>Workload / container</span><span>CPU request</span><span>Memory request</span><span>Signals</span><span />
                    </div>
                    <div className="table-divide-subtle">
                      {visibleRows.map((row) => (
                        <ScanResultRow key={row.id} row={row} open={openRow === row.id} onToggle={() => setOpenRow(openRow === row.id ? null : row.id)} onOpen={() => openWorkload(row)} />
                      ))}
                      {visibleRows.length < filteredRows.length && (
                        <div className="flex justify-center border-t border-theme-border px-4 py-3">
                          <button type="button" onClick={() => setVisibleLimit((value) => value + ROW_PAGE_SIZE)} className="text-xs font-medium text-accent-text hover:underline">
                            Show {Math.min(ROW_PAGE_SIZE, filteredRows.length - visibleRows.length)} more
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </section>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function FirstRunState({ namespaces, onRun }: { namespaces: string[]; onRun: () => void }) {
  const scope = namespaces.length === 0 ? 'all visible namespaces' : namespaces.length === 1 ? namespaces[0] : `${namespaces.length} selected namespaces`
  return (
    <div className="rounded-xl border border-theme-border bg-theme-surface p-8 text-center shadow-theme-sm">
      <Gauge className="mx-auto h-9 w-9 text-theme-text-tertiary" />
      <h2 className="mt-3 text-base font-semibold text-theme-text-primary">Find requests that need attention</h2>
      <p className="mx-auto mt-1 max-w-xl text-sm text-theme-text-secondary">Scan {scope} for workloads whose CPU or memory requests may be too high, too low, or missing.</p>
      <p className="mt-3 text-xs text-theme-text-tertiary">{REQUEST_FIT_SCAN_METHODOLOGY}</p>
      <button type="button" onClick={onRun} className="btn-brand mt-5 px-4 py-2 text-sm font-medium">Scan visible workloads</button>
    </div>
  )
}

function ScanSummary({ result, counts, selected, onSelect }: {
  result: NonNullable<ReturnType<typeof useRequestFitScan>['data']>
  counts: ReturnType<typeof scanClassCounts>
  selected: ScanClass | null
  onSelect: (value: ScanClass) => void
}) {
  const evaluated = result.coverage.workloadsEvaluated ?? result.workloads.length
  const withData = result.coverage.workloadsWithData ?? result.workloads.length
  const discovered = result.coverage.workloadsDiscovered ?? result.workloads.length
  return (
    <section className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-theme-sm">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {(Object.keys(CLASS_META) as ScanClass[]).map((key) => {
          const meta = CLASS_META[key]
          return (
            <button key={key} type="button" onClick={() => onSelect(key)} className={`rounded-lg border p-3 text-left transition-colors ${selected === key ? 'border-accent bg-accent-muted' : 'border-theme-border bg-theme-base/50 hover:bg-theme-hover'}`}>
              <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium text-theme-text-primary">{meta.label}</span><Badge severity={meta.severity} size="sm">{counts[key]} containers</Badge></div>
              <p className="mt-1 text-xs text-theme-text-tertiary">{meta.helper}</p>
            </button>
          )
        })}
      </div>
      <div className="mt-3 text-xs text-theme-text-tertiary">{evaluated} of {discovered} visible workloads evaluated · {withData} with demand data · {result.window || '7d'} window · 5m samples</div>
    </section>
  )
}

function ScanNotices({ result, rows }: { result: NonNullable<ReturnType<typeof useRequestFitScan>['data']>; rows: RequestFitScanRow[] }) {
  const notices: { tone?: 'warning'; text: string }[] = []
  if (result.state === 'partial') {
    const insufficient = rows.filter((row) => row.classification === 'need_data').length
    const queryErrors = rows.filter((row) => row.signals.has('query_error')).length
    notices.push({ text: `Scan completed with partial coverage. ${insufficient} containers need more evidence; ${queryErrors} had query errors.` })
  }
  if ((result.coverage.restrictedKinds?.length ?? 0) > 0) {
    notices.push({ text: 'Some workload kinds or namespaces were excluded by your Kubernetes access.' })
  }
  if ((result.coverage.unavailableKinds?.length ?? 0) > 0) {
    notices.push({ text: 'Some workload kinds could not be evaluated with the available cache or ownership evidence.' })
  }
  for (const warning of result.warnings ?? []) notices.push({ text: warningMessage(warning.code) })
  if (rows.length > 0 && rows.every((row) => row.classification === 'need_data')) {
    notices.push({ text: 'There is not enough recent evidence to classify any container yet.' })
  }
  if (rows.length > 0 && rows.every((row) => row.classification === 'in_range')) {
    notices.push({ text: 'Requests are in range for every container with enough evidence.' })
  }
  return notices.length > 0 ? <div className="flex flex-col gap-2">{notices.map((notice, i) => <Notice key={`${i}-${notice.text}`} {...notice} />)}</div> : null
}

function Notice({ text, tone }: { text: string; tone?: 'warning' }) {
  return <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${tone === 'warning' ? 'status-degraded' : 'border-theme-border bg-theme-surface text-theme-text-secondary'}`}><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{text}</div>
}

function ScanFilters(props: {
  search: string; onSearch: (value: string) => void
  kind: string; kinds: string[]; onKind: (value: string) => void
  namespace: string; namespaces: string[]; onNamespace: (value: string) => void
  signal: ScanSignal | null; onSignal: (value: string) => void
  shown: number; total: number; active: boolean; onClear: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-theme-border p-3">
      <div className="relative mr-auto min-w-56">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-text-tertiary" />
        <Input value={props.search} onChange={(event) => props.onSearch(event.target.value)} placeholder="Search workloads…" className="h-8 w-64 pl-8 pr-7 text-xs" />
        {props.search && <button type="button" aria-label="Clear search" onClick={() => props.onSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-theme-text-tertiary hover:text-theme-text-primary"><X className="h-3.5 w-3.5" /></button>}
      </div>
      <Select value={props.namespace} onChange={props.onNamespace} label="All namespaces" options={props.namespaces} />
      <Select value={props.kind} onChange={props.onKind} label="All kinds" options={props.kinds} />
      <Select value={props.signal ?? ''} onChange={props.onSignal} label="All signals" options={Object.entries(SIGNAL_LABEL).map(([value, label]) => ({ value, label }))} />
      <span className="text-xs tabular-nums text-theme-text-tertiary">{props.shown} of {props.total}</span>
      {props.active && <button type="button" onClick={props.onClear} className="text-xs text-accent-text hover:underline">Clear filters</button>}
    </div>
  )
}

function Select({ value, onChange, label, options }: { value: string; onChange: (value: string) => void; label: string; options: (string | { value: string; label: string })[] }) {
  return <select value={value} onChange={(event) => onChange(event.target.value)} className="h-8 rounded-md border border-theme-border bg-theme-elevated px-2 text-xs text-theme-text-secondary"><option value="">{label}</option>{options.map((option) => { const item = typeof option === 'string' ? { value: option, label: option } : option; return <option key={item.value} value={item.value}>{item.label}</option> })}</select>
}

function ScanResultRow({ row, open, onToggle, onOpen }: { row: RequestFitScanRow; open: boolean; onToggle: () => void; onOpen: () => void }) {
  return (
    <div className="border-b border-theme-border/50 last:border-b-0">
      <button type="button" onClick={onToggle} aria-expanded={open} className="grid w-full grid-cols-[minmax(260px,1.35fr)_minmax(190px,1fr)_minmax(190px,1fr)_minmax(150px,.8fr)_28px] items-center gap-3 px-4 py-3 text-left hover:bg-theme-hover/50">
        <div className="min-w-0"><div className="flex items-center gap-2"><Badge kind={row.kind} size="sm">{row.kind}</Badge><span className="truncate text-sm font-medium text-theme-text-primary">{row.name}</span></div><div className="mt-1 truncate text-xs text-theme-text-tertiary">{row.namespace} · {row.container}</div></div>
        <FitCell row={row.cpu} />
        <FitCell row={row.memory} />
        <div className="flex flex-wrap gap-1">{[...row.signals].map((signal) => <Badge key={signal} severity={signal === 'oom' || signal === 'query_error' ? 'error' : signal === 'throttling' ? 'warning' : 'neutral'} size="sm">{SIGNAL_LABEL[signal]}</Badge>)}{row.signals.size === 0 && <span className="text-xs text-theme-text-tertiary">None</span>}</div>
        <ChevronRight className={`h-4 w-4 text-theme-text-tertiary transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="grid gap-4 border-t border-theme-border bg-theme-base/40 px-4 py-3 md:grid-cols-[1fr_1fr_auto]">
          <FitWhy label="CPU" row={row.cpu} />
          <FitWhy label="Memory" row={row.memory} />
          <button type="button" onClick={onOpen} className="self-start text-xs font-medium text-accent-text hover:underline">Open workload</button>
        </div>
      )}
    </div>
  )
}

function FitCell({ row }: { row?: RightsizingRow }) {
  if (!row) return <span className="text-xs text-theme-text-tertiary">No result</span>
  const presentation = getRequestFitPresentation(row.fit, row.queryError)
  return <div className="min-w-0"><div className="flex items-center gap-1.5 text-xs tabular-nums"><span className="text-theme-text-secondary">{row.currentRequest ?? 'Unset'}</span>{row.recommendedRequest && <><span className="text-theme-text-tertiary">→</span><span className="font-medium text-theme-text-primary">{row.recommendedRequest}</span></>}</div><Badge severity={presentation.severity} size="sm" className="mt-1">{presentation.label === 'Balanced' ? 'In range' : presentation.label}</Badge></div>
}

function FitWhy({ label, row }: { label: string; row?: RightsizingRow }) {
  if (!row) return <div><div className="text-[11px] font-medium uppercase tracking-wide text-theme-text-tertiary">{label}</div><p className="mt-1 text-xs text-theme-text-secondary">No result returned.</p></div>
  const explanation = getRequestFitExplanation(row)
  return <div><div className="text-[11px] font-medium uppercase tracking-wide text-theme-text-tertiary">{label} evidence</div><p className="mt-1 text-xs text-theme-text-secondary">{row.observed ? `${row.observed.name} ${row.observed.formatted} · ` : ''}{row.sampleCount} of {row.expectedSamples} samples{row.confidence ? ` · ${row.confidence} confidence` : ''}.</p>{explanation && <p className="mt-1 text-xs text-theme-text-tertiary">{explanation}</p>}</div>
}

function CenteredState({ loading, title, body, action }: { loading?: boolean; title: string; body: string; action?: React.ReactNode }) {
  return <div className="flex min-h-64 items-center justify-center rounded-xl border border-theme-border bg-theme-surface"><div className="flex max-w-lg flex-col items-center px-6 text-center">{loading ? <Loader2 className="h-8 w-8 animate-spin text-theme-text-tertiary" /> : <Gauge className="h-8 w-8 text-theme-text-tertiary" />}<h2 className="mt-3 text-base font-semibold text-theme-text-primary">{title}</h2><p className="mt-1 text-sm text-theme-text-secondary">{body}</p>{action && <div className="mt-4">{action}</div>}</div></div>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.'
}

function unavailableMessage(reason?: string): string {
  if (reason === 'workload_kinds_unavailable') return 'No supported workload kinds are available with your current Kubernetes access.'
  if (reason === 'owner_metrics_missing') return 'kube-state-metrics ownership metrics were not found. Request fit needs kube_pod_owner to map samples to workloads.'
  if (reason === 'deployment_owner_metrics_missing') return 'Deployment history cannot be mapped because kube_replicaset_owner is unavailable from kube-state-metrics.'
  if (reason === 'owner_metrics_query_failed') return 'Radar found Prometheus, but could not query kube-state-metrics ownership data.'
  if (reason === 'scan_incomplete') return 'The scan could not evaluate any workloads in the current scope.'
  return 'Prometheus or kube-state-metrics does not expose the metrics required for this scan.'
}

function warningMessage(code: string): string {
  if (code === 'scan_deadline_exceeded') return 'The scan reached its time limit. Results from completed batches are shown.'
  if (code === 'owner_metrics_query_failed') return 'Workload ownership evidence could not be queried.'
  if (code.endsWith('_query_failed')) return `Some ${code.replace('_query_failed', '').replaceAll('_', ' ')} evidence could not be queried.`
  return 'Some request-fit evidence was unavailable. Available results are shown.'
}

function formatScanTime(value: string): string {
  const timestamp = new Date(value)
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}
