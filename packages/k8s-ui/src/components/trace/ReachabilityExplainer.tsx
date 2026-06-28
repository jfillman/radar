import { useEffect, useRef, useState } from 'react'
import type { Trace, ProbeResult, ProbeLayer } from './types'
import { externalNameHost, hostFromTarget } from './reachVerdict'
import { StatusDot, type StatusTone } from '../ui/status-tone'

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
const DIR_LABEL: Record<Direction, string> = {
  direct: 'From your machine',
  proxy: 'Via API server',
  real: 'In-cluster',
}
const DIR_HELP: Record<Direction, string> = {
  direct: 'Radar dials the target directly from where it runs (your machine, for a laptop) — works for public/external addresses, not in-cluster ClusterIPs.',
  proxy: 'Control-plane path: Radar reached the backend through the Kubernetes API server, which bypasses kube-proxy (ClusterIP routing) and NetworkPolicy. The app answers — the real data path isn’t confirmed.',
  real: 'Real pod-to-pod traffic — the actual kube-proxy + NetworkPolicy path. A short-lived Job dials from INSIDE the cluster, which the API-server column can’t prove. Use "Test inside the cluster" to fill this column.',
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
function cellTitle(p?: ProbeResult): string | undefined {
  if (!p) return 'This direction was not attempted for this path.'
  const parts = [p.layer?.toUpperCase(), p.detail || p.reason || p.error].filter(Boolean)
  return [parts.join(' — '), p.command].filter(Boolean).join('\n')
}

function Cell({ p, flash, testing, naEntry }: { p?: ProbeResult; flash?: boolean; testing?: boolean; naEntry?: boolean }) {
  // An entry (front-door) host in a non-"From your machine" column: this vantage
  // can't apply (proxy can't dial a hostname; in-cluster is a hairpin, not the real
  // external flow). Say "n/a", distinct from a blank "not tested" — and suppress any
  // hairpin probe that landed here so it never reads as a real in-cluster result.
  if (naEntry) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px]" title="An ingress/gateway host is reached from OUTSIDE the cluster. The API proxy can't dial a hostname, and an in-cluster dial would be a hairpin (not the real flow) — so this vantage doesn't apply to a front-door host.">
        <StatusDot tone="neutral" size="sm" />
        <span className="text-theme-text-tertiary">n/a · entry</span>
      </span>
    )
  }
  // Live "testing…" while the in-cluster Job runs — the work is visible IN the cell,
  // not just on the button (which otherwise looks like the only thing that happened).
  if (testing) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] animate-pulse">
        <StatusDot tone="neutral" size="sm" />
        <span className="text-theme-text-tertiary">testing…</span>
      </span>
    )
  }
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] px-1 ${flash ? 'reach-flash' : ''}`} title={cellTitle(p)}>
      <StatusDot tone={cellTone(p)} size="sm" />
      <span className={!p ? 'text-theme-text-tertiary' : p.skipped ? 'text-theme-text-tertiary' : 'text-theme-text-secondary'}>{cellLabel(p)}</span>
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
  const realMissing = dirs.includes('real') && rows.every((r) => !r.cells.real)
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-theme-border bg-theme-surface px-3 py-2">
      <div className="text-xs font-medium text-theme-text-secondary">
        What this test checked
        <span className="ml-2 font-normal text-theme-text-tertiary">{rows.length > 1 ? `${rows.length} paths` : '1 path'} · request <span className="font-mono text-theme-text-secondary">GET {probePath || '/'}</span> · blank = not tested</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-theme-text-tertiary">
              <th className="pr-3 pb-1 font-normal">Path</th>
              {dirs.map((d) => (
                <th key={d} className="px-3 pb-1 font-normal whitespace-nowrap cursor-help" title={DIR_HELP[d]}>{DIR_LABEL[d]} ⓘ</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="align-top">
                <td className="pr-3 py-0.5 font-mono text-[11px] text-theme-text-primary whitespace-nowrap">{r.label}</td>
                {dirs.map((d) => (
                  <td key={d} className="px-3 py-0.5"><Cell p={r.cells[d]} flash={flashKeys.has(`${r.key}|${d}`)} testing={d === 'real' && inClusterRunning && r.inClusterTestable} naEntry={r.isEntry && d !== 'direct'} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {realMissing && (
        <div className="text-[11px] text-theme-text-tertiary">
          {ext
            ? 'The in-cluster data path differs from a direct external dial — clients inside the cluster may resolve or route this host differently.'
            : 'The in-cluster (pod-to-pod) data path wasn’t tested from here — run Radar inside the cluster to fill that column.'}
        </div>
      )}
    </div>
  )
}
