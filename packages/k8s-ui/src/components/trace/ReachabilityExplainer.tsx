import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Trace, ProbeResult, ProbeLayer } from './types'
import { externalNameHost, hostFromTarget, directLaneLabel } from './reachVerdict'
import { StatusDot, type StatusTone } from '../ui/status-tone'
import { Tooltip } from '../ui/Tooltip'
import { HEALTH_BADGE_COLORS } from '../../utils/badge-colors'

// A reachability tooltip: styled, width-capped hover text (matches TracePanel's
// VerdictCaveat) - replaces the raw browser `title=` so hints render on-brand.
const tip = (s: string) => <span className="block max-w-xs leading-snug whitespace-pre-line">{s}</span>

export interface ReachabilityExplainerProps {
  trace: Trace
  /** A live probe completed (≥1 non-skipped result). This block is the post-test
   *  read; before that the static path speaks for itself, so it renders nothing. */
  probed?: boolean
  /** The in-cluster Job is running right now — the "Real in-cluster traffic" column
   *  shows a live "testing…" state so the work is visible IN the table, not just on
   *  the button. */
  inClusterRunning?: boolean
  /** The HTTP request the L7 probes made (default "/"), shown in the header so the
   *  reader knows exactly what was tested. */
  probePath?: string
}

// A DIRECTION is one way traffic was (or could be) sent to a target. The same path
// can be tested several ways at once, and they can DISAGREE — that disagreement is
// the signal (e.g. reachable via the proxy but a real pod can't reach it).
type Direction = 'direct' | 'proxy' | 'real'
const DIRS: Direction[] = ['direct', 'proxy', 'real']
// Rows shown before the "Show N more" toggle kicks in (a long path list would
// otherwise push the reachability diagram below the fold).
const COLLAPSED_ROWS = 2
const DIR_LABEL: Record<Direction, string> = {
  direct: 'From Radar',
  proxy: 'Via API server',
  real: 'In-cluster',
}
const DIR_HELP: Record<Direction, string> = {
  direct: 'Radar dials the target directly from where it runs (your machine, for a laptop). Works for public or external addresses, not in-cluster ClusterIPs.',
  proxy: 'Via the Kubernetes API server: Radar reached the backend through the API server, which bypasses kube-proxy (ClusterIP routing) and NetworkPolicy. The app answers, but the real data path is not confirmed.',
  real: 'Real pod-to-pod traffic: the actual kube-proxy and NetworkPolicy path. A short-lived Job dials from inside the cluster, which the API-server column cannot prove. Use "Test inside the cluster" to fill this column.',
}
function directionOf(p: ProbeResult): Direction {
  if (p.path === 'apiserver') return 'proxy'
  return p.vantage === 'in-cluster' ? 'real' : 'direct'
}

const LAYER_RANK: Record<ProbeLayer, number> = { http: 4, tls: 3, tcp: 2, dns: 1 }

function hasRealProbes(trace: Trace): boolean {
  for (const h of [...(trace.downstream ?? []), ...(trace.upstreams ?? [])]) {
    if ((h.probes ?? []).some((p) => !p.skipped)) return true
  }
  return false
}

// Entry/router kinds: their probed "path" is an EXTERNAL front-door host (the URL a
// user hits), which is only meaningful from OUTSIDE the cluster. The API proxy can't
// dial a hostname and an in-cluster dial of it is a hairpin (not the real flow), so
// those vantages are n/a for an entry — never "not tested", never a green real cell.
const ENTRY_KINDS = new Set(['Ingress', 'Gateway', 'HTTPRoute', 'GRPCRoute'])

interface MatrixRow {
  /** Namespace-qualified unique key (matches the rowMap key) — distinct even for
   *  two same-named cross-namespace backends, so React reconciliation and the
   *  change-flash never collide on a shared label. */
  key: string
  label: string
  cells: Partial<Record<Direction, ProbeResult>>
  /** Whether the in-cluster test actually dials this path (a downstream Service/
   *  ExternalName) — entry hosts are NOT dialed, so they must never show a "testing…"
   *  state that then reverts to blank. */
  inClusterTestable: boolean
  /** This row is an external front-door host (Ingress/Gateway/Route), not a backend.
   *  The proxy + in-cluster columns are "n/a · entry", not a blank/real result. */
  isEntry: boolean
}

// buildMatrix turns the raw per-hop probe results into the many-paths × many-directions
// grid: one row per tested path (a Service port, an external host), one column per
// direction it was tried from. A path appears once even though it's probed at several
// layers; the highest-information layer (http > tls > tcp > dns) represents each cell.
// pathLabel gives ONE stable identity per logical path so a hop's DNS/TCP/HTTP
// probes (which carry differently-shaped targets — "host", "host:80",
// "http://host/") collapse into a single row, and a port-less skip on one service
// never collides with another's: the hop name always anchors the key.
function pathLabel(name: string, p: ProbeResult): string {
  if (p.port) return `${name}:${p.port}`
  const host = hostFromTarget(p.target)
  return host && host !== name ? `${name} (${host})` : name
}

function buildMatrix(trace: Trace): { dirs: Direction[]; rows: MatrixRow[] } {
  const rowMap = new Map<string, MatrixRow>()
  const seen = new Set<Direction>()
  // Downstream Services/ExternalName are what the in-cluster Job dials; upstream entry
  // hosts are NOT — so only downstream rows may show a "testing…" state.
  const addHop = (h: NonNullable<Trace['downstream']>[number], testable: boolean) => {
    const name = h.resource?.name || h.resource?.kind || ''
    const ns = h.resource?.namespace ?? ''
    const entry = ENTRY_KINDS.has(h.resource?.kind ?? '')
    for (const p of h.probes ?? []) {
      const label = pathLabel(name, p)
      // The row KEY includes the namespace so two same-named backends across
      // namespaces (a cross-namespace Gateway API backendRef) don't collapse into
      // one row where one direction's result silently masks the other's. The
      // displayed label stays the clean path so the common case reads unchanged.
      const key = ns ? `${ns}/${label}` : label
      const dir = directionOf(p)
      seen.add(dir)
      let row = rowMap.get(key)
      if (!row) {
        // An entry host is never in-cluster-testable, regardless of whether it sits in
        // downstream (Ingress subject) or upstreams (Service subject) — this is also
        // what kills the "testing…" flicker on an Ingress-subject host row.
        row = { key, label, cells: {}, inClusterTestable: testable && !entry, isEntry: entry }
        rowMap.set(key, row)
      } else if (testable && !entry) {
        row.inClusterTestable = true
      }
      // A LIVE result always beats a skipped one; among the same skip-status, the
      // higher-information layer wins. (Never let a skipped TLS hide a live TCP.)
      // On a SAME-layer tie (e.g. a Pods fan-out: multiple pods, same http layer),
      // prefer the WORSE outcome so a failing member is never masked by a passing
      // one — never hide a failure (fail toward silence).
      const cur = row.cells[dir]
      const take = !cur
        ? true
        : !!cur.skipped !== !!p.skipped
          ? (!!cur.skipped && !p.skipped)
          : (LAYER_RANK[p.layer] ?? 0) !== (LAYER_RANK[cur.layer] ?? 0)
            ? (LAYER_RANK[p.layer] ?? 0) > (LAYER_RANK[cur.layer] ?? 0)
            : cellSeverity(p) > cellSeverity(cur)
      if (take) row.cells[dir] = p
    }
  }
  for (const h of (trace.downstream ?? []).filter((h) => h.resource?.kind !== 'Pods')) addHop(h, true)
  for (const h of trace.upstreams ?? []) addHop(h, false)
  // Always include the "real in-cluster traffic" column even when this run couldn't
  // test it (e.g. from a laptop): its ABSENCE is the point — it tells the operator the
  // gold-standard check is still missing, instead of hiding it.
  seen.add('real')
  const dirs = DIRS.filter((d) => seen.has(d))
  return { dirs, rows: [...rowMap.values()] }
}

// cellSeverity ranks a probe outcome so a same-layer tie keeps the WORSE one.
// Only real problems (5xx degraded / unhealthy failure) outrank an ok result —
// two oks tie and the first-arrived stays.
function cellSeverity(p?: ProbeResult): number {
  const t = cellTone(p)
  return t === 'unhealthy' ? 3 : t === 'degraded' ? 2 : 0
}

function cellTone(p?: ProbeResult): StatusTone {
  if (!p) return 'neutral'
  if (p.skipped) return 'neutral'
  if (!p.ok || p.tone === 'unhealthy') return 'unhealthy'
  if (p.tone === 'degraded') return 'degraded'
  if (p.tone === 'reached') return 'neutral'
  return 'healthy'
}

// cellLabel says WHAT was actually attempted + how it ended — never a bare "not
// tested here" that hides a real DNS/TCP attempt. A skip names the layer and the
// concise reason (the full reason + any command is on the tooltip); a genuinely
// un-attempted direction is a faint dash, visually distinct from an attempted skip.
function cellLabel(p?: ProbeResult): string {
  if (!p) return '—'
  const L = (p.layer || '').toUpperCase()
  if (p.skipped) {
    const r = (p.reason || '').toLowerCase()
    // Only claim a resolution FAILURE when the reason actually says so. A bare
    // DNS-layer skip (wildcard host, vantage, not-attempted) isn't a resolve
    // failure — neutral copy, with the full reason on the tooltip.
    if (/resolve|nxdomain|no such host/.test(r)) return 'DNS didn’t resolve from here'
    if (p.layer === 'dns') return 'DNS not tested here'
    if (/https|tls|plain http/.test(r)) return 'HTTPS — needs a direct test'
    if (/non-http|doesn.t speak http|not http/.test(r)) return `${L} — not HTTP`
    if (/udp|sctp/.test(r)) return `${L} — needs a ${/(udp|sctp)/.exec(r)?.[1].toUpperCase()} client`
    return `${L || 'probe'} not run here`
  }
  if (!p.ok) return p.detail || p.error || `${L} failed`
  return p.detail || `${L} ok`
}
// The HTTP status code from a probe's detail - shown IN the pill ("Verified · 200",
// "Reached · 404") so this essential per-row fact never gets folded away.
function httpCode(p?: ProbeResult): string | undefined {
  return /HTTP\s+(\d{3})/i.exec(p?.detail || '')?.[1]
}

// plainReason renders WHY a "Reached" isn't a full pass, in plain language for a
// non-developer (no jargon like "route/auth not verified"). The code lives in the
// pill, so this sentence omits it - and is undefined for a clean 2xx (the "Verified ·
// 200" pill already says it all).
function plainReason(p: ProbeResult): string | undefined {
  const code = httpCode(p)
  if (code) {
    if (code.startsWith('2')) return undefined
    if (code === '401' || code === '403') return 'Reachable, but this path needs authentication.'
    if (code.startsWith('4')) return 'The app answered, but nothing serves this path.'
    if (code.startsWith('3')) return 'Reachable, but it redirected instead of serving this path.'
    if (code.startsWith('5')) return 'The app is reachable but erroring on this path.'
  }
  return cellLabel(p)
}

// A surface cell's status: a short outcome word plus its tone, and the one-line
// reason folded in beneath the pill. The muted variant (blank or "n/a") uses the
// elevated surface so a not-tested cell never needs explaining.
export type ReachPillState = { label: string; tone: StatusTone; code?: string; reason?: string; pulse?: boolean; muted?: boolean }

function pillState(p: ProbeResult | undefined, opts: { testing?: boolean; naEntry?: boolean }): ReachPillState {
  // An entry (front-door) host in a non-direct column: the proxy can't dial a hostname
  // and an in-cluster dial of it is a hairpin, so this vantage simply doesn't apply.
  if (opts.naEntry) return { label: 'n/a', tone: 'neutral', muted: true, reason: 'A front-door host is reached from outside the cluster, so this vantage doesn’t apply.' }
  // Live "testing…" while the in-cluster Job runs - the work is visible IN the cell.
  if (opts.testing) return { label: 'Testing…', tone: 'neutral', pulse: true, reason: 'Running a Job inside the cluster to test the real pod-to-pod path.' }
  if (!p) return { label: 'Not tested', tone: 'neutral', muted: true }
  if (p.skipped) return { label: 'Not tested', tone: 'neutral', muted: true, reason: plainReason(p) }
  const tone = cellTone(p)
  const label = tone === 'unhealthy' ? 'Unreachable' : tone === 'degraded' ? 'Degraded' : tone === 'neutral' ? 'Reached' : 'Verified'
  return { label, tone, code: httpCode(p), reason: plainReason(p) }
}

// The reason folded into a blank in-cluster cell.
function inClusterNotTestedReason(ext?: string): string {
  return ext
    ? 'Clients inside the cluster may resolve or route this host differently - run the in-cluster test to confirm.'
    : 'Not tested from here - run Radar inside the cluster to test the real pod-to-pod path.'
}

// ReachStatusPill - a rounded status chip built from the shared health-badge palette
// (tinted background + text) plus a solid StatusDot. The muted variant drops the dot
// and sits on the elevated surface, keeping "not tested / n·a" visually quiet.
function ReachPill({ state }: { state: ReachPillState }) {
  if (state.muted) {
    return <span className="inline-flex items-center rounded-full bg-theme-elevated px-2 py-0.5 text-[11px] font-semibold text-theme-text-tertiary">{state.label}</span>
  }
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${HEALTH_BADGE_COLORS[state.tone] ?? ''}`}>
      <StatusDot tone={state.tone} size="sm" className={`shrink-0 ${state.pulse ? 'animate-pulse' : ''}`} />
      {state.label}
      {state.code && <span className="font-mono font-normal opacity-80">· {state.code}</span>}
    </span>
  )
}

/**
 * ReachabilityExplainer states, in plain language for a non-k8s operator, exactly
 * what a probe run DID and — the part operators miss — what it did NOT prove. The
 * core is a MATRIX: every tested path (each port / host) as a row, and each DIRECTION
 * it was tried from (direct, API proxy, real in-cluster) as a column, so the reader
 * sees the multi-path / multi-direction reality and any disagreement between
 * directions at a glance. "Not confirmed" stays a first-class row, never a footnote.
 */
export function ReachabilityExplainer({ trace, probed, inClusterRunning, probePath }: ReachabilityExplainerProps): React.ReactElement | null {
  const ext = externalNameHost(trace)
  const { dirs, rows } = buildMatrix(trace)
  // Flash-on-change: snapshot every cell's value each render; when a value differs
  // from last time, briefly highlight it so a fast/identical-looking result still
  // reads as "new". Hooks must run unconditionally — before the early returns below.
  const sigs = new Map<string, string>()
  for (const r of rows) for (const d of dirs) sigs.set(`${r.key}|${d}`, `${cellLabel(r.cells[d])}|${cellTone(r.cells[d])}`)
  const sigKey = Array.from(sigs.entries()).map(([k, v]) => `${k}=${v}`).join(';')
  const prevRef = useRef<Map<string, string> | null>(null)
  const [flashKeys, setFlashKeys] = useState<Set<string>>(new Set())
  // Collapse a long path list so the card never pushes the diagram below the fold -
  // show the first COLLAPSED_ROWS, with a toggle to reveal the rest.
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = sigs
    if (!prev) return
    const changed = new Set<string>()
    for (const [k, v] of sigs) if (prev.has(k) && prev.get(k) !== v) changed.add(k)
    if (changed.size === 0) return
    setFlashKeys(changed)
    const t = setTimeout(() => setFlashKeys(new Set()), 1700)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigKey])

  if (!probed && !hasRealProbes(trace) && !inClusterRunning) return null
  if (rows.length === 0) return null
  // The matrix earns its space only when it shows something the path rows don't:
  // MULTIPLE paths, or more than one direction actually tested (so you can read them
  // agreeing/disagreeing). A single path tested one way is a 1-cell table restating
  // the verdict + path — suppress it there. EXCEPTION: while the in-cluster test runs,
  // show it so the "testing…" column is visible (and so the new column's arrival is felt).
  const testedDirs = dirs.filter((d) => rows.some((r) => r.cells[d]))
  if (!inClusterRunning && rows.length <= 1 && testedDirs.length <= 1) return null
  // Label the direct column from a DIRECT-lane probe's own vantage - never the whole
  // trace's first probe: once the in-cluster test has run, the trace also holds
  // in-cluster probes, and picking one of those would mislabel the (always-local) direct
  // column as "in-cluster". directionOf routes in-cluster vantages to the 'real' column.
  const directVantage = rows.map((r) => r.cells.direct).find((p) => p?.vantage)?.vantage
  // One grid template shared by the column-header band and every data row so the
  // surface columns line up: a wider PATH column, then one equal column per direction.
  const gridCols = `minmax(7rem, 1.4fr) ${dirs.map(() => 'minmax(0, 1fr)').join(' ')}`
  const bandLabel = 'text-[10px] font-bold uppercase tracking-wider text-theme-text-tertiary'
  const collapsible = rows.length > COLLAPSED_ROWS
  const visibleRows = collapsible && !expanded ? rows.slice(0, COLLAPSED_ROWS) : rows
  const hiddenCount = rows.length - COLLAPSED_ROWS
  return (
    <div className="overflow-hidden rounded-xl border border-theme-border bg-theme-surface">
      {/* Card header - title + scannable meta chips. */}
      <div className="flex items-center justify-between gap-3 border-b border-theme-border px-4 py-3">
        <span className="text-sm font-semibold text-theme-text-primary">What this test checked</span>
        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center rounded-md bg-theme-elevated px-2 py-0.5 text-xs font-medium text-theme-text-secondary">{rows.length > 1 ? `${rows.length} paths` : '1 path'}</span>
          <span className="inline-flex items-center rounded-md bg-theme-elevated px-2 py-0.5 font-mono text-xs font-medium text-theme-text-secondary">GET {probePath || '/'}</span>
        </div>
      </div>
      {/* Column-header band - PATH + one direction per surface, each with its tooltip. */}
      <div className="grid gap-x-4 border-b border-theme-border bg-theme-base px-4 py-2" style={{ gridTemplateColumns: gridCols }}>
        <div className={bandLabel}>Path</div>
        {dirs.map((d) => (
          <div key={d} className={`${bandLabel} border-l border-theme-border pl-4`}>
            <Tooltip content={tip(DIR_HELP[d])} position="bottom">
              <span className="cursor-help">{d === 'direct' ? directLaneLabel(directVantage) : DIR_LABEL[d]} ⓘ</span>
            </Tooltip>
          </div>
        ))}
      </div>
      {/* One row per path: the request on the left, a status pill + reason per surface. */}
      {visibleRows.map((r) => (
        <div key={r.key} className="grid items-start gap-x-4 border-b border-theme-border px-4 py-3 last:border-b-0" style={{ gridTemplateColumns: gridCols }}>
          <div className="flex min-w-0 items-center gap-2">
            <span className="inline-flex shrink-0 items-center rounded bg-theme-elevated px-1.5 py-0.5 font-mono text-[10px] font-bold text-theme-text-secondary">GET</span>
            <span className="truncate font-mono text-[12px] text-theme-text-primary">{r.label}</span>
          </div>
          {dirs.map((d) => {
            const testing = d === 'real' && inClusterRunning && r.inClusterTestable
            const naEntry = r.isEntry && d !== 'direct'
            const state = pillState(r.cells[d], { testing, naEntry })
            // The pill (outcome + status code) is always visible; the plain-language
            // "why" lives on its tooltip so the rows stay scannable instead of a wall
            // of repeated sentences.
            const reason = state.reason ?? (d === 'real' && !r.cells[d] && !testing && !naEntry ? inClusterNotTestedReason(ext) : undefined)
            return (
              <div key={d} className={`border-l border-theme-border pl-4 ${flashKeys.has(`${r.key}|${d}`) ? 'reach-flash' : ''}`}>
                {reason ? (
                  <Tooltip content={tip(reason)} position="bottom">
                    <span className="cursor-help"><ReachPill state={state} /></span>
                  </Tooltip>
                ) : (
                  <ReachPill state={state} />
                )}
              </div>
            )
          })}
        </div>
      ))}
      {/* Collapse toggle - keeps a long list from pushing the diagram below the fold. */}
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex w-full items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium text-theme-text-secondary transition-colors hover:bg-theme-hover"
        >
          {expanded ? 'Show less' : `Show ${hiddenCount} more ${hiddenCount === 1 ? 'path' : 'paths'}`}
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      )}
    </div>
  )
}
