import { useEffect, useMemo, useRef, useState } from 'react'
import type { ResourceRef, Trace, Hop, ProbeResult, ProbeLayer, Finding } from './types'
import { ReachActions, JustTestedNote, FindingRow, VerdictCaveat, RequestIndicator, type TracePanelProps } from './TracePanel'
import { reachVerdict, directLaneLabel, hostFromTarget } from './reachVerdict'
import { ReachabilityExplainer } from './ReachabilityExplainer'
import { TopologyGraph } from '../topology/TopologyGraph'
import type { TopologyNode } from '../../types/core'
import { traceToSubgraph } from './traceToSubgraph'
import { StatusDot, type StatusTone } from '../ui/status-tone'
import { AlertBanner } from '../ui/drawer-components'

/**
 * ReachabilityView is the full-screen Reachability tab body. It renders the trace
 * as the same path on the app's network graph: per-route truth on the EDGES (a
 * router node stays neutral), nothing reached past a break. A single honest verdict
 * line tops it. Drawer <TraceSummary>, the ?tab=reachability deeplink, and all
 * backend stay untouched.
 */
export function ReachabilityView(props: TracePanelProps) {
  const { trace, isLoading, error, inClusterError, probeError, onRunProbes, onRefresh } = props
  // A fetch that is still loading or has FAILED must not read as a definitive
  // "No reachability data." negative (ReachabilityDiagram's empty-trace fallback).
  // Mirror TracePanel: surface the loading state, and an error with a retry, so an
  // RBAC-denied / 500 / API-not-installed failure stays honest under uncertainty.
  if (isLoading && !trace) {
    return <div className="text-sm text-theme-text-tertiary p-4">Loading reachability…</div>
  }
  if (error && !trace) {
    return (
      <div className="p-1">
        <AlertBanner variant="error" title="Couldn’t load reachability" message={error.message}>
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              className="mt-2 text-xs px-2 py-1 rounded border border-theme-border bg-theme-surface text-theme-text-primary hover:bg-theme-hover transition-colors"
            >
              Retry
            </button>
          )}
        </AlertBanner>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      {/* A failed reachability-probe run must never be a silent no-op - surface it
          here (mirrors TracePanel). */}
      {probeError && (
        <AlertBanner variant="error" title="Reachability test failed" message={probeError.message}>
          {onRunProbes && (
            <button
              type="button"
              onClick={onRunProbes}
              className="mt-2 text-xs px-2 py-1 rounded border border-theme-border bg-theme-surface text-theme-text-primary hover:bg-theme-hover transition-colors"
            >
              Try again
            </button>
          )}
        </AlertBanner>
      )}
      {inClusterError && (
        <div className="rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-xs text-theme-text-secondary">
          <span className="font-medium text-theme-text-primary">In-cluster test:</span> {inClusterError}
        </div>
      )}
      <ReachabilityDiagram
        trace={trace}
        onNavigate={props.onNavigateToResource}
        onRunProbes={props.onRunProbes}
        probeRequested={props.probeRequested}
        probed={props.probed}
        onRunInCluster={props.onRunInCluster}
        inClusterRunning={props.inClusterRunning}
        inClusterAllowed={props.inClusterAllowed}
        probePath={props.probePath}
        onApplyProbePath={props.onApplyProbePath}
        runNonce={props.runNonce}
      />
    </div>
  )
}

function ReachabilityDiagram({ trace, onNavigate, onRunProbes, probeRequested, probed, onRunInCluster, inClusterRunning, inClusterAllowed, probePath, onApplyProbePath, runNonce }: { trace?: Trace; onNavigate?: (ref: ResourceRef) => void; onRunProbes?: () => void; probeRequested?: boolean; probed?: boolean; onRunInCluster?: () => void; inClusterRunning?: boolean; inClusterAllowed?: boolean; probePath?: string; onApplyProbePath?: (p: string) => void; runNonce?: number }) {
  // Track the selection by ID, not by node object - the node is re-derived from the
  // CURRENT topology each render, so when a probe (e.g. the in-cluster test) updates
  // the trace, the open detail panel refreshes in place instead of showing stale data
  // until you click away and back.
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const topo = useMemo(() => (trace ? traceToSubgraph(trace, probePath) : null), [trace, probePath])
  const selected = useMemo(() => (selectedId ? topo?.nodes.find((n) => n.id === selectedId) : undefined), [topo, selectedId])
  // Open the graph with the SUBJECT (the resource you're viewing) already selected, so
  // its detail panel shows by default. Done once per subject - after that the operator
  // owns the selection (clicking other nodes, or closing the panel, sticks).
  const initedFor = useRef<string>('')
  useEffect(() => {
    if (!topo || !trace) return
    const key = `${trace.subject.kind}/${trace.subject.namespace ?? ''}/${trace.subject.name}`
    if (initedFor.current === key) return
    const subj = topo.nodes.find((n) => n.kind === trace.subject.kind && n.name === trace.subject.name)
    if (subj) {
      setSelectedId(subj.id)
      initedFor.current = key
    }
  }, [topo, trace])
  if (!trace) {
    return <div className="text-sm text-theme-text-tertiary p-4">No reachability data.</div>
  }
  const v = reachVerdict(trace, probed)
  // An in-cluster test has produced results when any hop carries an in-cluster
  // probe - used to label the in-cluster button as a re-run.
  const inClusterTested = [...(trace.downstream ?? []), ...(trace.upstreams ?? [])].some((h) => (h.probes ?? []).some((p) => p.vantage === 'in-cluster'))
  // Click SELECTS and reveals the hop's detail in place - it must NOT navigate away
  // (that dropped the reachability context). The detail panel offers an explicit
  // "Open ↗" to leave when the operator actually wants the resource page.
  const onNodeClick = (node: TopologyNode) => setSelectedId(node.id)
  // Size the canvas to the path - a 2-node path shouldn't float in a huge empty grid.
  const nodeCount = topo?.nodes.length ?? 2
  // Give the graph real breathing room - a cramped canvas hides the path. Min is
  // ~2x the old floor; taller paths grow up to a generous cap.
  const canvasHeight = Math.min(640, Math.max(360, nodeCount * 78))
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-theme-border bg-theme-surface px-3 py-2">
        <div className="flex items-start gap-2 min-w-0">
          {/* Nudge the dot to the optical center of the headline's first line (text-sm,
              ~20px line-box) so it reads as a status marker, not a stray bullet. */}
          <span className="mt-[7px] shrink-0"><StatusDot tone={v.tone} size="sm" /></span>
          <div className="min-w-0">
            <div className="text-sm font-medium text-theme-text-primary">
              {v.icon ? v.icon + ' ' : ''}{v.text}
              <JustTestedNote nonce={runNonce} />
            </div>
            <VerdictCaveat caveat={v.caveat} detail={v.detail} />
            {probed && <RequestIndicator path={probePath} onApplyProbePath={onApplyProbePath} />}
          </div>
        </div>
        <ReachActions
          onRunProbes={onRunProbes}
          probeRequested={probeRequested}
          probed={probed}
          onRunInCluster={onRunInCluster}
          inClusterRunning={inClusterRunning}
          inClusterAllowed={inClusterAllowed}
          inClusterTested={inClusterTested}
          probePath={probePath}
          onApplyProbePath={onApplyProbePath}
        />
      </div>
      <ReachabilityExplainer trace={trace} probed={probed} inClusterRunning={inClusterRunning} probePath={probePath} />
      {/* Canvas + the selected node's detail SIDE BY SIDE - the detail must be
          immediately visible on click, not stranded below the fold. */}
      <div className="flex gap-3">
        <div style={{ height: canvasHeight }} className="flex-1 min-w-0 rounded-lg border border-theme-border overflow-hidden bg-theme-base">
          <TopologyGraph
            topology={topo}
            viewMode="traffic"
            groupingMode="none"
            showExportButton={false}
            selectedNodeId={selected?.id}
            onNodeClick={onNodeClick}
          />
        </div>
        {selected && (
          <div style={{ maxHeight: canvasHeight }} className="w-80 shrink-0 overflow-auto">
            <HopDetailPanel node={selected} namespace={trace.subject.namespace} onNavigate={onNavigate} onClose={() => setSelectedId(undefined)} inClusterRunning={inClusterRunning} />
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <DiagramLegend />
        {!selected && <span className="text-[11px] text-theme-text-tertiary shrink-0">Click any box for its config + probe results →</span>}
      </div>
    </div>
  )
}

// The connection stack a DevOps engineer debugs in order. Config is "layer 0" (static),
// then the network layers each probe carries via its `layer` field.
const LAYER_SEQ: ProbeLayer[] = ['dns', 'tcp', 'tls', 'http']
const LAYER_NAME: Record<ProbeLayer, string> = { dns: 'DNS', tcp: 'TCP', tls: 'TLS', http: 'HTTP' }
type Dir = 'direct' | 'proxy' | 'real'
const DIR_NAME: Record<Dir, string> = { direct: 'From Radar', proxy: 'Via API server', real: 'In-cluster' }
function dirOf(p: ProbeResult): Dir {
  if (p.path === 'apiserver') return 'proxy'
  return p.vantage === 'in-cluster' ? 'real' : 'direct'
}
// layerSeverity ranks a probe by its rendered tone so a same-layer tie resolves
// worse-wins (mirrors ReachabilityExplainer's cellSeverity).
function layerSeverity(p: ProbeResult): number {
  const t = layerView(p).tone
  return t === 'unhealthy' ? 3 : t === 'degraded' ? 2 : 0
}
function layerView(p: ProbeResult): { tone: StatusTone; text: string } {
  if (p.skipped) return { tone: 'neutral', text: p.reason || 'not tested here' }
  if (!p.ok || p.tone === 'unhealthy') return { tone: 'unhealthy', text: p.detail || p.error || 'failed' }
  if (p.tone === 'degraded') return { tone: 'degraded', text: p.detail || 'server error' }
  if (p.tone === 'reached') return { tone: 'neutral', text: p.detail || 'reached (unverified)' }
  const ok = p.layer === 'dns' ? 'resolved' : p.layer === 'tcp' ? 'connected' : p.layer === 'tls' ? 'valid' : 'ok'
  return { tone: 'healthy', text: p.detail || ok }
}

// DirectionStack shows one vantage's DNS→TCP→TLS→HTTP chain. Layers the probe didn't
// attempt are OMITTED (e.g. the proxy does HTTP directly, no DNS/TCP) - but once a
// layer FAILS, the layers that would follow read "not reached", so the break point is
// unmistakable instead of just trailing off.
function DirectionStack({ label, probes }: { label: string; probes: ProbeResult[] }) {
  const byLayer = new Map<ProbeLayer, ProbeResult>()
  for (const p of probes) {
    const cur = byLayer.get(p.layer)
    if (!cur) {
      byLayer.set(p.layer, p)
      continue
    }
    // A LIVE result beats a skipped one; among the same skip-status, prefer the
    // WORSE outcome so a failing sibling (sampled multi-pod in-cluster, multi-port
    // Service) is never masked by a passing one - fail toward surfacing the
    // failure, matching ReachabilityExplainer's worse-wins and nodeOwnStatus
    // (which already marks the node degraded/unhealthy on any bad probe).
    const take = !!cur.skipped !== !!p.skipped
      ? (!!cur.skipped && !p.skipped)
      : layerSeverity(p) > layerSeverity(cur)
    if (take) byLayer.set(p.layer, p)
  }
  const rows: { layer: ProbeLayer; p?: ProbeResult; brokenBy?: string }[] = []
  let brokenBy: string | undefined
  for (const L of LAYER_SEQ) {
    const p = byLayer.get(L)
    if (p) {
      rows.push({ layer: L, p })
      // Only a REAL failure cascades "not reached" to later layers. A skip (DNS not
      // resolvable from this vantage, TLS skipped for plain HTTP) is "not tested
      // here", not a failure - it must not make absent downstream layers read as a
      // break that never happened.
      if (!p.skipped && (!p.ok || p.tone === 'unhealthy')) brokenBy = LAYER_NAME[L]
    } else if (brokenBy) {
      rows.push({ layer: L, brokenBy })
    }
  }
  if (rows.length === 0) return null
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[10px] uppercase tracking-wide text-theme-text-tertiary">{label}</div>
      {rows.map((r, i) => (
        <div key={i} className="flex flex-col gap-0.5">
          <div className="flex items-start gap-1.5 text-[11px]">
            <span className="w-9 shrink-0 font-mono text-theme-text-tertiary">{LAYER_NAME[r.layer]}</span>
            {r.p ? (
              <>
                <span className="mt-0.5 shrink-0"><StatusDot tone={layerView(r.p).tone} size="sm" /></span>
                <span className="text-theme-text-secondary break-all">{layerView(r.p).text}</span>
              </>
            ) : (
              <span className="text-theme-text-tertiary">· not reached ({r.brokenBy} failed)</span>
            )}
          </div>
          {r.p?.skipped && r.p.command && (
            <code className="ml-9 block break-all rounded bg-theme-base px-2 py-1 text-[10px] font-mono text-theme-text-tertiary">{r.p.command}</code>
          )}
        </div>
      ))}
    </div>
  )
}

// podReach summarizes ONE pod's probe results into a single reachability cell: its
// worst live outcome (a failure wins, so a bad pod is never masked), else the deepest
// layer it reached, with the vantage that produced it (apiserver = indirect knock,
// in-cluster = real data path).
// A Pods-hop probe target is "<name> port <N>" (apiserver path) or "<ip>:<port>"
// (data path). The pod identity is the first token with any :port stripped, which
// joins back to the roster's name (apiserver) or ip (data). hostFromTarget is
// IPv6-aware for the ip:port form.
export function podProbeKey(target?: string): string {
  return hostFromTarget((target || '').split(' ')[0])
}

export function podReach(probes: ProbeResult[]): { tone: StatusTone; text: string; vantage: string } {
  const live = probes.filter((p) => !p.skipped)
  if (live.length === 0) return { tone: 'neutral', text: 'not tested', vantage: '' }
  const vantage = live.some((p) => p.vantage === 'in-cluster') ? 'real' : live.some((p) => p.path === 'apiserver') ? 'via API server' : ''
  const failed = live.find((p) => !p.ok || p.tone === 'unhealthy')
  if (failed) return { tone: 'unhealthy', text: failed.detail || failed.error || `${failed.layer.toUpperCase()} failed`, vantage }
  const order: ProbeLayer[] = ['http', 'tls', 'tcp', 'dns']
  const best = order.map((L) => live.find((p) => p.layer === L && p.ok)).find(Boolean)
  return { tone: best?.tone === 'degraded' ? 'degraded' : 'healthy', text: best?.detail || 'reached', vantage }
}

// PodReachabilityGrid renders one row per pod: its Kubernetes readiness plus whether
// it answered when knocked on DIRECTLY (per-node reachability - the chain is skipped).
// So the operator sees WHICH pod is broken and which shape: crashing (NotReady, nothing
// to knock on → "not tested") vs ready-but-not-serving (Ready, but the knock failed).
function PodReachabilityGrid({ hop, namespace, onNavigate }: { hop?: Hop; namespace?: string; onNavigate?: (ref: ResourceRef) => void }) {
  const roster = hop?.config?.pods ?? []
  if (roster.length === 0) return null
  const probes = hop?.probes ?? []
  // The roster is capped for JSON size; podTotal is the real count. Never let a
  // sampled fleet read as complete - say "showing N of M" when it's a sample.
  const total = hop?.config?.podTotal ?? roster.length
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] uppercase tracking-wide text-theme-text-tertiary">
        Pods ({total > roster.length ? `showing ${roster.length} of ${total}` : roster.length})
      </div>
      {roster.map((pod) => {
        const mine = probes.filter((p) => podProbeKey(p.target) === pod.name || (!!pod.ip && podProbeKey(p.target) === pod.ip))
        const reach = pod.ready ? podReach(mine) : { tone: 'neutral' as StatusTone, text: 'not tested (pod not ready)', vantage: '' }
        const dot: StatusTone = !pod.ready ? 'unhealthy' : reach.tone === 'unhealthy' ? 'degraded' : reach.tone
        return (
          <div key={pod.name} className="flex items-start gap-1.5 text-[11px]">
            <span className="mt-0.5 shrink-0"><StatusDot tone={dot} size="sm" /></span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                {onNavigate && namespace ? (
                  <button type="button" onClick={() => onNavigate({ kind: 'Pod', name: pod.name, namespace })} className="font-mono text-theme-text-secondary hover:underline break-all">{pod.name}</button>
                ) : (
                  <span className="font-mono text-theme-text-secondary break-all">{pod.name}</span>
                )}
                <span className="shrink-0 text-theme-text-tertiary">{pod.ready ? 'Ready' : 'Not ready'}</span>
              </div>
              <div className="break-all text-theme-text-tertiary">
                {pod.ready ? `${reach.text}${reach.vantage ? ` · ${reach.vantage}` : ''}` : pod.reason || 'not ready'}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// HopDetailPanel: the selected node's diagnostic as a connection STACK - Config first
// (static issues), then one DNS→TCP→TLS→HTTP stack per direction it was tried from, so
// a DevOps engineer reads exactly which layer breaks, and from where.
function HopDetailPanel({ node, namespace, onNavigate, onClose, inClusterRunning }: { node: TopologyNode; namespace?: string; onNavigate?: (ref: ResourceRef) => void; onClose?: () => void; inClusterRunning?: boolean }) {
  const data = node.data as { ref?: ResourceRef; subtitleOverride?: string; hop?: Hop }
  const hop = data.hop
  const ref = data.ref
  const findings: Finding[] = hop?.findings ?? []
  const probes = hop?.probes ?? []
  const byDir = new Map<Dir, ProbeResult[]>()
  for (const p of probes) {
    const d = dirOf(p)
    const arr = byDir.get(d) ?? []
    arr.push(p)
    byDir.set(d, arr)
  }
  const dirs = (['direct', 'proxy', 'real'] as Dir[]).filter((d) => byDir.has(d))
  // Direct column is always the local dial (directionOf routes in-cluster → 'real'), so
  // take the vantage from a direct-lane probe - not any probe, which after an in-cluster
  // run could be an in-cluster one and mislabel the direct column.
  const directVantage = byDir.get('direct')?.find((p) => p.vantage)?.vantage
  // This node gets dialed in-cluster only if it's a Service/Pods/ExternalName (not an
  // Ingress/Gateway entry) - so only those show the live "testing…" state, mirroring
  // the matrix's In-cluster column.
  const inClusterTestable = node.kind === 'Service' || node.kind === 'Pods' || node.kind === 'ExternalName'
  const showTesting = !!inClusterRunning && inClusterTestable
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="font-mono text-theme-text-primary break-all">{node.kind} {node.name}</span>
          {data.subtitleOverride ? <span className="text-theme-text-tertiary"> · {data.subtitleOverride}</span> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {ref?.name && onNavigate ? (
            <button type="button" onClick={() => onNavigate(ref)} className="text-theme-accent hover:underline">Open ↗</button>
          ) : null}
          {onClose ? (
            <button type="button" onClick={onClose} aria-label="Close detail" className="text-theme-text-tertiary hover:text-theme-text-primary">✕</button>
          ) : null}
        </div>
      </div>
      {findings.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[10px] uppercase tracking-wide text-theme-text-tertiary">Config</div>
          {findings.map((f, i) => (
            <FindingRow key={i} finding={f} onNavigate={onNavigate} />
          ))}
        </div>
      )}
      {/* For the Pods node, the per-pod grid replaces the aggregated per-direction
          stack - the stack collapses all pods into one worst-wins chain, which is
          exactly the per-pod detail this node is here to show. */}
      {node.kind === 'Pods' && (hop?.config?.pods?.length ?? 0) > 0 ? (
        <PodReachabilityGrid hop={hop} namespace={namespace} onNavigate={onNavigate} />
      ) : (
        /* While the in-cluster Job runs, the In-cluster section reads "testing…" in
           place - don't show a stale prior In-cluster stack underneath it. */
        dirs.filter((d) => !(d === 'real' && showTesting)).map((d) => <DirectionStack key={d} label={d === 'direct' ? directLaneLabel(directVantage) : DIR_NAME[d]} probes={byDir.get(d)!} />)
      )}
      {showTesting && (
        <div className="flex flex-col gap-0.5">
          <div className="text-[10px] uppercase tracking-wide text-theme-text-tertiary">{DIR_NAME.real}</div>
          <div className="flex items-center gap-1.5 text-[11px] animate-pulse">
            <span className="shrink-0"><StatusDot tone="neutral" size="sm" /></span>
            <span className="text-theme-text-tertiary">testing… (running a Job inside the cluster)</span>
          </div>
        </div>
      )}
      {findings.length === 0 && probes.length === 0 && !showTesting && !(node.kind === 'Pods' && (hop?.config?.pods?.length ?? 0) > 0) && (
        <div className="text-theme-text-tertiary">No findings or probe results for this hop.</div>
      )}
    </div>
  )
}

function DiagramLegend() {
  // The route EDGES carry the reachability truth (per route); nodes show each
  // resource's own health. Labels match the edge colors in TopologyGraph.
  const edges: { color: string; dash?: string; label: string }[] = [
    { color: '#22c55e', label: 'verified (real traffic)' },
    { color: '#22c55e', dash: '5 4', label: 'reached via proxy' },
    { color: '#ef4444', label: 'unreachable (route breaks)' },
    { color: '#94a3b8', dash: '6 3', label: 'blocked (past a break)' },
    { color: '#cbd5e1', dash: '2 4', label: 'not tested' },
  ]
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-theme-text-tertiary">
      {edges.map((e) => (
        <span key={e.label} className="inline-flex items-center gap-1.5">
          <svg width="18" height="6" aria-hidden>
            <line x1="0" y1="3" x2="18" y2="3" stroke={e.color} strokeWidth="2" strokeDasharray={e.dash} />
          </svg>
          {e.label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <StatusDot tone="unhealthy" size="sm" /> node = the resource’s own health
      </span>
    </div>
  )
}
