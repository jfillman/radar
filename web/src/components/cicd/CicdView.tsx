import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, Workflow } from 'lucide-react'
import { clsx } from 'clsx'
import {
  SummaryTile,
  Facet,
  Input,
  getTektonPipelineRunStatus,
  tektonRefName,
  formatAge,
  formatDuration,
  type SummaryTone,
} from '@skyhook-io/k8s-ui'
import { fetchJSON } from '../../api/client'

interface CicdViewProps {
  namespaces: string[]
  onOpenPipelineRun: (ref: { namespace: string; name: string }) => void
}

type StatusFacet = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'pending'

// Same bucketing as getTektonPipelineRunStatus's `level`, but named for the
// filter UI rather than the badge — cancelled reads as `degraded` there,
// which is correct as a health signal but a confusing filter label.
function statusFacet(run: any): StatusFacet {
  const cond = (run?.status?.conditions ?? []).find((c: any) => c?.type === 'Succeeded')
  if (!cond) return 'pending'
  if (cond.status === 'True') return 'succeeded'
  if (cond.status === 'False') {
    const reason = cond.reason || ''
    return reason === 'Cancelled' || reason.endsWith('Cancelled') ? 'cancelled' : 'failed'
  }
  return 'running'
}

const STATUS_LABEL: Record<StatusFacet, string> = {
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  pending: 'Pending',
}
const STATUS_TONE: Record<StatusFacet, 'success' | 'error' | 'info' | 'warning' | 'neutral'> = {
  running: 'info',
  succeeded: 'success',
  failed: 'error',
  cancelled: 'warning',
  pending: 'neutral',
}

function runStartTime(run: any): number {
  const t = run?.status?.startTime
  return t ? new Date(t).getTime() : 0
}

function runDurationMs(run: any): number | null {
  const start = run?.status?.startTime
  if (!start) return null
  const end = run?.status?.completionTime
  return (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()
}

// Fraction of declared tasks that have at least started (status.childReferences
// only tells us "a TaskRun was created for this task," not its outcome — an
// honest "how far did it get" proxy, not "how much succeeded").
function taskProgress(run: any): { started: number; total: number } {
  const total = (run?.status?.pipelineSpec?.tasks ?? []).length
  const started = (run?.status?.childReferences ?? []).length
  return { started, total }
}

function ProgressBar({ run, facet }: { run: any; facet: StatusFacet }) {
  const { started, total } = taskProgress(run)
  // A `matrix`-strategy task expands into several childReferences from one
  // declared pipeline task, so `started` can legitimately exceed `total` —
  // display against whichever is larger so the fraction never reads backwards
  // (e.g. "12/7"), without pretending the declared count was actually 12.
  const displayTotal = Math.max(total, started)
  const fraction = displayTotal > 0 ? Math.min(1, started / displayTotal) : facet === 'succeeded' ? 1 : 0
  const fillClass = {
    running: 'bg-sky-500',
    succeeded: 'bg-emerald-500',
    failed: 'bg-red-500',
    cancelled: 'bg-amber-500',
    pending: 'bg-theme-text-tertiary',
  }[facet]
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-full min-w-[80px] overflow-hidden rounded-full bg-theme-hover">
        <div
          className={clsx('h-full rounded-full transition-all', fillClass, facet === 'running' && 'animate-pulse')}
          style={{ width: `${Math.max(fraction * 100, displayTotal > 0 ? 4 : 0)}%` }}
        />
      </div>
      {displayTotal > 0 && (
        <span
          className="shrink-0 text-[11px] tabular-nums text-theme-text-tertiary"
          title={
            started > total
              ? `${total} declared task${total === 1 ? '' : 's'} expanded into ${started} runs (matrix strategy) — tasks started, not necessarily succeeded`
              : 'Tasks started, not necessarily succeeded'
          }
        >
          {started}/{displayTotal}
        </span>
      )}
    </div>
  )
}

export function CicdView({ namespaces, onOpenPipelineRun }: CicdViewProps) {
  const namespacesParam = namespaces.join(',')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<Set<StatusFacet>>(new Set())
  const [pipelineFilter, setPipelineFilter] = useState<Set<string>>(new Set())

  const runsQuery = useQuery({
    queryKey: ['cicd-pipelineruns', namespacesParam],
    queryFn: async () => {
      const params = new URLSearchParams({ group: 'tekton.dev' })
      if (namespacesParam) params.set('namespaces', namespacesParam)
      return fetchJSON<any[]>(`/resources/pipelineruns?${params}`)
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
  })

  const tasksRunningQuery = useQuery({
    queryKey: ['cicd-taskruns-running', namespacesParam],
    queryFn: async () => {
      const params = new URLSearchParams({ group: 'tekton.dev' })
      if (namespacesParam) params.set('namespaces', namespacesParam)
      const all = await fetchJSON<any[]>(`/resources/taskruns?${params}`)
      return all.filter((t) => {
        const cond = (t?.status?.conditions ?? []).find((c: any) => c?.type === 'Succeeded')
        return cond?.status === 'Unknown'
      }).length
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
  })

  const runs = runsQuery.data ?? []

  const stats = useMemo(() => {
    const counts: Record<StatusFacet, number> = { running: 0, succeeded: 0, failed: 0, cancelled: 0, pending: 0 }
    for (const r of runs) counts[statusFacet(r)]++
    const finished = counts.succeeded + counts.failed
    const successRate = finished > 0 ? Math.round((counts.succeeded / finished) * 100) : null
    return { counts, total: runs.length, successRate }
  }, [runs])

  const pipelineCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of runs) {
      const name = tektonRefName(r?.spec?.pipelineRef)
      m.set(name, (m.get(name) ?? 0) + 1)
    }
    return m
  }, [runs])

  const filteredRuns = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = runs.filter((r) => {
      if (statusFilter.size > 0 && !statusFilter.has(statusFacet(r))) return false
      const pipelineName = tektonRefName(r?.spec?.pipelineRef)
      if (pipelineFilter.size > 0 && !pipelineFilter.has(pipelineName)) return false
      if (q) {
        const haystack = `${r?.metadata?.name ?? ''} ${r?.metadata?.namespace ?? ''} ${pipelineName}`.toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
    return [...rows].sort((a, b) => runStartTime(b) - runStartTime(a))
  }, [runs, search, statusFilter, pipelineFilter])

  const toggleStatus = (v: StatusFacet) => setStatusFilter((prev) => {
    const next = new Set(prev)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    return next
  })
  const togglePipeline = (v: string) => setPipelineFilter((prev) => {
    const next = new Set(prev)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    return next
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-theme-border bg-theme-surface/70 px-4 py-3">
        <div className="mb-3 flex items-center gap-2">
          <Workflow className="h-4 w-4 text-theme-text-tertiary" />
          <h1 className="text-sm font-semibold text-theme-text-primary">CI/CD</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <SummaryTile label="Total Runs" value={stats.total} loading={runsQuery.isLoading} />
          <SummaryTile
            label="Running"
            value={stats.counts.running}
            tone="info"
            loading={runsQuery.isLoading}
            active={statusFilter.has('running')}
            onClick={() => toggleStatus('running')}
          />
          <SummaryTile
            label="Succeeded"
            value={stats.counts.succeeded}
            tone="success"
            loading={runsQuery.isLoading}
            active={statusFilter.has('succeeded')}
            onClick={() => toggleStatus('succeeded')}
          />
          <SummaryTile
            label="Failed"
            value={stats.counts.failed}
            tone="error"
            loading={runsQuery.isLoading}
            active={statusFilter.has('failed')}
            onClick={() => toggleStatus('failed')}
          />
          <SummaryTile
            label="Success Rate"
            value={stats.successRate ?? 0}
            tone={(stats.successRate == null ? 'neutral' : stats.successRate >= 90 ? 'success' : stats.successRate >= 70 ? 'warning' : 'error') as SummaryTone}
            loading={runsQuery.isLoading}
          />
          <SummaryTile label="Tasks Running" value={tasksRunningQuery.data ?? 0} tone="info" loading={tasksRunningQuery.isLoading} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 overflow-y-auto border-r border-theme-border bg-theme-surface/50">
          <Facet
            title="Status"
            options={(Object.keys(STATUS_LABEL) as StatusFacet[]).map((v) => ({
              value: v,
              label: STATUS_LABEL[v],
              count: stats.counts[v],
              tone: STATUS_TONE[v],
            }))}
            selected={statusFilter}
            onToggle={toggleStatus}
          />
          <Facet
            title="Pipeline"
            options={[...pipelineCounts.entries()].map(([name, count]) => ({ value: name, label: name, count }))}
            selected={pipelineFilter}
            onToggle={togglePipeline}
          />
        </aside>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-theme-border px-4 py-2">
            <div className="relative max-w-md">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-text-tertiary" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search PipelineRuns, namespaces, pipelines..."
                className="h-8 w-full rounded-md border border-theme-border bg-theme-base pl-8 pr-3 text-sm text-theme-text-primary placeholder:text-theme-text-tertiary focus:outline-none focus:ring-1 focus:ring-blue-500/50"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {runsQuery.isLoading ? (
              <div className="p-4 text-sm text-theme-text-tertiary">Loading PipelineRuns…</div>
            ) : filteredRuns.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-theme-text-tertiary">
                {runs.length === 0 ? 'No PipelineRuns found.' : 'No PipelineRuns match the current filters.'}
              </div>
            ) : (
              <div className="divide-y divide-theme-border">
                {filteredRuns.map((run) => {
                  const facet = statusFacet(run)
                  const status = getTektonPipelineRunStatus(run)
                  const durationMs = runDurationMs(run)
                  const name = run.metadata?.name ?? ''
                  const namespace = run.metadata?.namespace ?? ''
                  return (
                    <button
                      key={`${namespace}/${name}`}
                      type="button"
                      onClick={() => onOpenPipelineRun({ namespace, name })}
                      className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-theme-hover"
                    >
                      <div className="w-64 min-w-0 shrink-0">
                        <div className="truncate text-sm font-medium text-theme-text-primary">{name}</div>
                        <div className="truncate text-xs text-theme-text-tertiary">{namespace}</div>
                      </div>
                      <div className="w-40 shrink-0">
                        <span className={clsx('badge', status.color)}>{status.text}</span>
                      </div>
                      <div className="w-40 shrink-0 truncate text-xs text-theme-text-secondary" title={tektonRefName(run?.spec?.pipelineRef)}>
                        {tektonRefName(run?.spec?.pipelineRef)}
                      </div>
                      <div className="min-w-[140px] flex-1">
                        <ProgressBar run={run} facet={facet} />
                      </div>
                      <div className="w-28 shrink-0 text-right text-xs text-theme-text-tertiary tabular-nums">
                        {durationMs !== null ? formatDuration(durationMs, true) : '—'}
                      </div>
                      <div className="w-24 shrink-0 text-right text-xs text-theme-text-tertiary tabular-nums">
                        {run?.status?.startTime ? formatAge(run.status.startTime) : '—'}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
