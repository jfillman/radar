import type { Trace, Hop, ResourceRef, RouteResult, PodStatus, ProbeResult } from './types'
import type { Mark, SevTone } from './reachMarks'
import { routeMark, isSlow, formatLatency, declaredHosts, hostMatches, routeHostOf, originRouteEvidence, routeForOrigin } from './reachMarks'
import { originOf, type Origin } from './reachOrigins'
import { podProbeKey } from './podReach'

/**
 * Layout constants. Positions are COMPUTED from content, never hand-placed:
 * node boxes size to their text, so fixed coordinates collide the moment a name
 * or a tag runs long. Columns are laid out left to right with a guaranteed
 * gutter wide enough to hold an edge pill without touching either neighbour.
 */
// Chains can reach five columns (origin -> Gateway -> Route -> Service -> Pods),
// so the gutter is tighter than a 3-column layout would allow.
const GUTTER = 98
const ROW_GAP = 14
const LANE_PAD = { x: 14, top: 22, bottom: 14 }
const LANE_GAP = 20
/** Pills wrap to two lines, so the cap is what fits on two - not on one.
 *  At 16 it cut "HTTP 404 - reached" down to "HTTP 404...", which reports the
 *  status code and hides the only word that says what it meant. */
export const PILL_MAX_CHARS = 26
/** Hard cap on a pill's rendered width. MUST stay under GUTTER, or a pill
 *  overruns its gutter and lands on the node beside it. */
export const PILL_MAX_PX = 88

/** Columns are assigned in chain order. Every node belongs to exactly one,
 *  which is what guarantees left-to-right reading order and non-overlap. */
/** Width per column. The last column (Pods) is wider because it carries rows. */
const COL_W = { origin: 172, hop: 180, pods: 216 }

export interface GraphNode {
  id: string
  x: number
  y: number
  w: number
  h: number
  /** Small-caps type line, e.g. "SERVICE · PORT". */
  kind: string
  name: string
  sub: string
  /** The resource's OWN health. Never the path's truth - that lives on edges. */
  tone: SevTone
  tag?: string
  /** The hop's OWN findings, headline-first. The graph used to consume these
   *  only to pick a dot colour, discarding the cause, action and remediation
   *  the backend had already produced - so the one sentence that answers
   *  "what is wrong with this hop" was a click away behind a coloured pixel. */
  notes?: HopNote[]
  anomalies?: { mark: Mark; text: string }[]
  /** Per-endpoint delivery results, rendered as rows inside the node.
   *  A column of pod boxes cost more width than the whole rest of the path and
   *  fit fewer of them; rows carry the same per-pod truth in less space. */
  podRows?: PodRow[]
  /** Endpoints beyond the row cap, named rather than silently dropped. */
  moreRows?: number
  dim?: boolean
  ref?: ResourceRef
  hop?: Hop
  isOrigin?: boolean
  lane: 'control' | 'data'
}

export interface HopNote {
  /** Resource-health severity, NOT a traffic Mark: findings describe the object,
   *  marks describe what happened to a request. Keeping the two vocabularies
   *  apart is why the dot and the edge never mean the same thing. */
  severity: 'critical' | 'warning' | 'info'
  /** Short headline - the parsed cause when there is one. */
  text: string
  /** Everything the row could not fit, for the hover. */
  detail: string
}

export interface PodRow {
  name: string
  mark: Mark
  detail: string
  ref: ResourceRef
}

/** Rows shown before collapsing into a "+N more" line. */
export const POD_ROW_MAX = 6

/** Above this many sibling branches, only the selected one and the ones with
 *  findings stay expanded - the quiet remainder collapses to a single row. */
export const FAN_EXPANDED_MAX = 4

export interface GraphEdge {
  id: string
  /** SVG path data. */
  d: string
  mark: Mark
  label: string
  /** The untruncated label. ALWAYS set: the pill has a pixel cap as well as a
   *  character cap, so text can be visually cut without `label` being shortened,
   *  and a hover that only appears sometimes is worse than one that always does. */
  title: string
  /** Pill centre, in canvas coordinates. Always inside a gutter. */
  px: number
  py: number
}

export interface LaneBox {
  x: number
  y: number
  w: number
  h: number
  label: string
  /** Hover text. The band label is the most prominent word in the graph and had
   *  no explanation anywhere. */
  help: string
  /** Lane tint + label colour. */
  color: string
  dashed?: boolean
}

export interface GraphModel {
  nodes: GraphNode[]
  edges: GraphEdge[]
  brackets: { d: string }[]
  originIsControl: boolean
  canvas: { w: number; h: number }
  /** Lanes bound only their own nodes, so an unused half of the dataplane does
   *  not render as a large empty rectangle. */
  laneControl?: LaneBox
  laneData?: LaneBox
}

const refId = (r?: ResourceRef): string => (r ? `${r.kind}/${r.namespace ?? ''}/${r.name || 'pods'}` : '')

const isPodsHop = (h: Hop): boolean => h.resource?.kind === 'Pods' || /pods/i.test(h.edge ?? '')

function truncate(s: string, n = PILL_MAX_CHARS): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

/** Estimated rendered height of a node box. The renderer uses fixed type sizes,
 *  so this stays accurate without a measure pass. */
function estHeight(n: {
  anomalies?: unknown[]
  notes?: { text: string }[]
  podRows?: unknown[]
  moreRows?: number
  isOrigin?: boolean
  sub?: string
}): number {
  const base = n.isOrigin ? 66 : 60
  const anomalies = n.anomalies?.length ?? 0
  const rows = n.podRows?.length ?? 0
  // Long sub-lines wrap; approximate at ~34 characters per line.
  const subLines = Math.max(1, Math.ceil((n.sub?.length ?? 0) / 34))
  // Notes wrap too, and a wrapped note that the layout did not reserve room for
  // is exactly how a node grows into the row beneath it.
  const noteLines = (n.notes ?? []).reduce((sum, x) => sum + Math.max(1, Math.ceil(x.text.length / 26)), 0)
  return (
    base +
    (subLines - 1) * 13 +
    (noteLines > 0 ? 8 + noteLines * 13 : 0) +
    (anomalies > 0 ? 8 + anomalies * 17 : 0) +
    (rows > 0 ? 8 + rows * 17 + (n.moreRows ? 15 : 0) : 0)
  )
}

/** Rendered per node before collapsing; the rest stay one click away. */
const HOP_NOTE_MAX = 2

/**
 * A hop's findings as node rows: the parsed `cause` when the detector produced
 * one (it is written to be short), else the raw message. The full text - and the
 * remediation - stay in the inspector, so the graph carries the headline and
 * never becomes the place you read paragraphs.
 */
function hopNotes(hop?: Hop): HopNote[] {
  const findings = hop?.findings ?? []
  if (findings.length === 0) return []
  const rank = { critical: 0, warning: 1, info: 2 } as const
  const ordered = [...findings].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3))
  const notes = ordered.slice(0, HOP_NOTE_MAX).map((f) => ({
    severity: f.severity,
    text: f.cause || f.message,
    detail: [f.message, f.action || f.remediation].filter((x) => !!x && x !== (f.cause || f.message)).join(' — '),
  }))
  const hidden = ordered.length - notes.length
  if (hidden > 0) {
    notes.push({ severity: ordered[notes.length].severity, text: `+${hidden} more`, detail: 'Select this resource to read the rest.' })
  }
  return notes
}

/** Health from a hop's findings alone - the same rule the topology view uses:
 *  a critical finding is red only when nothing is serving. */
function hopTone(hop: Hop | undefined, origin: Origin): SevTone {
  if (!hop) return 'unknown'
  const findings = hop.findings ?? []
  const ready = typeof hop.meta?.ready === 'number' ? (hop.meta.ready as number) : undefined
  const serving = typeof ready === 'number' && ready > 0
  if (findings.some((f) => f.severity === 'critical')) return serving ? 'degraded' : 'unhealthy'
  if (findings.some((f) => f.severity === 'warning')) return 'degraded'
  // Scoped to the SELECTED origin, like every other probe read in this file.
  // Pooling every vantage here let one origin's failure paint the dot red while
  // the rows beneath it - which do filter by origin - showed that same vantage
  // had never run. Same node, two scopes, two answers.
  const live = probesFromOrigin(hop.probes ?? [], origin).filter((p) => !p.skipped)
  if (live.length === 0) return 'unknown'
  // A FAILED apiserver-proxy probe is indirect evidence: the proxy path itself
  // may be what failed and the real path was never tested, so it must never
  // paint the node red. Real failures still do - omitting the !ok check
  // entirely rendered a green dot on a hop whose probes had failed.
  const judged = live.filter((p) => !(p.path === 'apiserver' && (!p.ok || p.tone === 'unhealthy')))
  if (judged.length === 0) return 'unknown'
  if (judged.some((p) => !p.ok || p.tone === 'unhealthy')) return 'unhealthy'
  if (judged.some((p) => p.tone === 'degraded')) return 'degraded'
  return 'healthy'
}

function probesForPod(pod: PodStatus, probes: ProbeResult[]): ProbeResult[] {
  return probes.filter((p) => {
    const key = podProbeKey(p.target)
    return key === pod.name || (!!pod.ip && key === pod.ip)
  })
}

/**
 * Marks that mean this origin actually produced evidence for the scenario.
 * Anything else (untested / denied / blocked / excluded / config) means it did
 * not run, and must not inherit another origin's result.
 */
const EVIDENCE_MARKS: Mark[] = ['proved', 'failed', 'answered', 'proxied', 'stale', 'running', 'slow']

export function originProducedEvidence(origin: Origin): boolean {
  return EVIDENCE_MARKS.includes(origin.mark)
}

/**
 * A hop's probes belong to whichever origin produced them. The graph renders
 * ONE origin at a time, so it must read only that origin's probes - otherwise a
 * vantage that never ran inherits another's result and a laptop's success is
 * painted as a solid proved line inside the dataplane lane.
 */
function probesFromOrigin(probes: ProbeResult[], origin: Origin): ProbeResult[] {
  return probes.filter((p) => originOf(p) === origin.id)
}

/**
 * Anomalies held out of a population aggregate. Averaging them away is exactly
 * how a single refusing endpoint that real users hit becomes invisible, so each
 * category is counted and named rather than folded into a percentage.
 */
function populationAnomalies(roster: PodStatus[], total: number, probes: ProbeResult[], publishNotReady: boolean): { mark: Mark; text: string }[] {
  const out: { mark: Mark; text: string }[] = []
  const failing = roster.filter((p) => p.ready && probesForPod(p, probes).some((x) => !x.skipped && (!x.ok || x.tone === 'unhealthy')))
  if (failing.length > 0) {
    out.push({ mark: 'failed', text: `${failing.length} endpoint${failing.length > 1 ? 's' : ''} refused the connection` })
  }
  const slow = roster.filter((p) => p.ready && probesForPod(p, probes).some((x) => !x.skipped && x.ok && isSlow(x)))
  if (slow.length > 0) {
    const worst = slow
      .flatMap((p) => probesForPod(p, probes))
      .filter((x) => !x.skipped && isSlow(x))
      .sort((a, b) => (b.latencyNs ?? 0) - (a.latencyNs ?? 0))[0]
    out.push({ mark: 'slow', text: `${slow.length} slow · ${formatLatency(worst?.latencyNs)}` })
  }
  // With publishNotReadyAddresses the dataplane routes to NotReady Pods too, so
  // they are eligible endpoints - calling them "excluded, never routed to" is
  // false precisely when someone is debugging a not-ready Pod that IS serving.
  const notReady = publishNotReady ? [] : roster.filter((p) => !p.ready)
  if (notReady.length > 0) {
    out.push({ mark: 'excluded', text: `${notReady.length} NotReady — never routed to` })
  }
  // The roster is capped for payload size; anything past it is eligible but
  // unobserved. Unprobed is not proven, so it must be stated, not implied.
  const omitted = total - roster.length
  if (omitted > 0) out.push({ mark: 'untested', text: `${omitted} eligible, not probed` })
  return out
}

/** Short forms for the origin capsule's tag - the full wording would overrun
 *  the box and collide with the node beside it. */
const SHORT_KIND_TAG: Record<string, string> = {
  SYNTHETIC: 'SYNTHETIC',
  'REAL CLIENT': 'REAL CLIENT',
  'REAL CALLER': 'REAL CALLER',
  'RELAYED · NOT A CALLER': 'RELAYED',
}

interface Placed {
  col: number
  row: number
  w: number
  node: Omit<GraphNode, 'x' | 'y' | 'w' | 'h'>
}

interface BuildOpts {
  trace: Trace
  route?: RouteResult
  origin: Origin
  stale?: boolean
  running?: boolean
}

/**
 * Builds the laned graph for ONE scenario seen from ONE origin.
 *
 * Selecting a different origin genuinely re-routes the graph rather than
 * relabelling it: a control-plane origin enters the subject from the upper lane
 * through an apiserver node, having bypassed kube-proxy, NetworkPolicy and the
 * mesh entirely. Drawing both the same way would be the central lie this view
 * exists to prevent.
 */
export function buildGraph({ trace, route, origin, stale, running }: BuildOpts): GraphModel {
  const placed: Placed[] = []
  const originIsControl = origin.lane === 'control'

  const subjectId = refId(trace.subject)
  const subjectNodeId = `n:${subjectId}`
  const downstream = trace.downstream ?? []
  const subjectHop = downstream.find((h) => refId(h.resource) === subjectId)
  const upstreams = trace.upstreams ?? []

  /**
   * Upstreams are PARALLEL entry points, and a subject can have several
   * backends each with their own Pods. Laying all of that out as one series
   * invented a path that does not exist - two Ingresses read as
   * "Ingress A then Ingress B", and only the first backend's Pods survived.
   * Parentage follows the same rule the topology converter uses.
   */
  const backends: { hop: Hop; id: string }[] = []
  const podGroups: { hop: Hop; id: string; parentId: string }[] = []
  let lastServiceId = subjectNodeId
  for (const dn of downstream) {
    const base = refId(dn.resource)
    if (base === subjectId) {
      lastServiceId = subjectNodeId
      continue
    }
    if (isPodsHop(dn)) {
      // An unnamed Pods hop's id collapses to the same value for every backend,
      // so it must be scoped to its owning Service or later groups are dropped.
      podGroups.push({ hop: dn, id: dn.resource?.name ? `n:${base}` : `${lastServiceId}::pods`, parentId: lastServiceId })
    } else {
      const id = `n:${base}`
      backends.push({ hop: dn, id })
      lastServiceId = id
    }
  }

  /** The scenario names a host; only the entries serving it are on this path.
   *  Shares its matcher with scenario grouping so dimming and grouping can never
   *  disagree about which front door serves a host. */
  const routeHost = routeHostOf(route?.route ?? '')
  const servesRoute = (h: Hop): boolean => !!routeHost && declaredHosts(h).some((d) => hostMatches(d, routeHost))
  // Prefer this origin's OWN result over the merged rollup. Without it the graph
  // painted whatever the worst vantage saw under the selected vantage's name -
  // the central misattribution this view exists to prevent. originProducedEvidence
  // remains the fallback gate for traces carrying no per-vantage breakdown.
  const ev = originRouteEvidence(route, origin.id)
  const asSeen = ev.kind === 'none' ? undefined : ev.result

  const matched = upstreams.filter(servesRoute)
  const activeUpstreams = matched.length > 0 ? matched : upstreams

  /**
   * Fan-out branches are peers, and until now every one of them rendered
   * identically - so on a Gateway with seven attached routes, changing the
   * selected scenario changed nothing on screen and there was no way to tell
   * which branch you were diagnosing. Only entry points were ever dimmed.
   *
   * A branch is on the selected path when it serves the scenario's host or
   * carries its backend. When NOTHING matches we dim nothing: a graph where
   * every branch is greyed out says "none of this is relevant", which is worse
   * than saying nothing at all.
   */
  const routeTarget = (route?.target ?? '').split(':')[0].trim().toLowerCase()
  const onSelectedPath = (h: Hop): boolean => {
    if (servesRoute(h)) return true
    const name = (h.resource?.name ?? '').toLowerCase()
    return !!routeTarget && name === routeTarget
  }
  const matchedBackends = backends.filter((b) => onSelectedPath(b.hop))
  const focusBranches = matchedBackends.length > 0 && matchedBackends.length < backends.length

  /**
   * Exception-first. A Gateway with seven attached routes rendered seven equally
   * loud cards that overflowed the pane, and six of them were fine. What the
   * operator needs is the selected branch and anything WRONG; the quiet
   * remainder is context and can be one line.
   *
   * Collapsing is by relevance, never by position - dropping "the last three"
   * would hide whichever route happened to sort late.
   */
  const worthExpanding = (b: { hop: Hop }): boolean =>
    onSelectedPath(b.hop) || (b.hop.findings ?? []).length > 0
  const expanded = backends.length > FAN_EXPANDED_MAX ? backends.filter(worthExpanding) : backends
  const collapsed = backends.filter((b) => !expanded.includes(b))

  const hopSub = (h: Hop): string => {
    const c = h.config
    if (c?.clusterIP) return `ClusterIP ${c.clusterIP}`
    if (c?.addresses?.length) return c.addresses.join(', ')
    if (c?.hostnames?.length) return c.hostnames.join(', ')
    if (c?.serviceType) return c.serviceType
    return h.resource?.namespace ?? ''
  }

  // ---- columns follow depth in the branch, not position in a list ----
  const COL_ORIGIN = 0
  const COL_ENTRY = 1
  const colSubject = upstreams.length > 0 ? COL_ENTRY + 1 : COL_ENTRY
  const colBackend = colSubject + 1
  const colPods = backends.length > 0 ? colBackend + 1 : colSubject + 1

  /**
   * Two mechanisms never touch the front door, so drawing them through it is a
   * lie the picture tells before any label is read:
   *
   *  - the API-server proxy dials the Service/Pod subresource directly;
   *  - the in-cluster Job dials the BACKEND Service - internal/trace's own
   *    ProbeRequest doc says the in-cluster dial bypasses the front door, and
   *    the server only stamps its results onto downstream hops.
   *
   * Only the workstation vantage actually requests the declared hostname. When
   * the origin bypasses, it enters beside the declared entries rather than
   * through them: both then point at the subject, which is the truth - one
   * exercised, one merely configured.
   */
  const bypassesFrontDoor = origin.id === 'apiserver' || origin.id === 'incluster'
  const originSkipsEntries = upstreams.length > 0 && bypassesFrontDoor
  const colOrigin = originSkipsEntries ? COL_ENTRY : COL_ORIGIN

  placed.push({
    col: colOrigin,
    // Below the entries it sits beside, so the edge to the subject never has to
    // cross one of them.
    row: originSkipsEntries ? upstreams.length : 0,
    w: COL_W.origin,
    node: {
      id: `origin:${origin.id}`,
      kind: 'TESTED FROM',
      name: origin.name,
      sub: origin.mech,
      tone: 'info',
      tag: SHORT_KIND_TAG[origin.kindTag] ?? origin.kindTag,
      isOrigin: true,
      lane: originIsControl ? 'control' : 'data',
    },
  })

  upstreams.forEach((up, i) => {
    const active = activeUpstreams.includes(up)
    placed.push({
      col: COL_ENTRY,
      row: i,
      w: COL_W.hop,
      node: {
        id: `n:${refId(up.resource)}`,
        kind: (up.resource?.kind || 'ENTRY').toUpperCase(),
        name: up.resource?.name ?? 'entry',
        sub: active ? hopSub(up) : 'does not serve this host',
        tone: hopTone(up, origin),
        notes: hopNotes(up),
        // Entries that do not serve the selected host are shown, but dimmed -
        // hiding them would misrepresent what is attached to this resource.
        dim: !active,
        ref: up.resource,
        hop: up,
        lane: 'data',
      },
    })
  })

  placed.push({
    col: colSubject,
    row: 0,
    w: COL_W.hop,
    node: {
      id: subjectNodeId,
      kind: (trace.subject.kind || 'SERVICE').toUpperCase(),
      name: `${trace.subject.name}${route?.target ? ` ${route.target}` : ''}`,
      sub: subjectHop ? hopSub(subjectHop) : trace.subject.namespace || '',
      tone: hopTone(subjectHop, origin),
      notes: hopNotes(subjectHop),
      ref: trace.subject,
      hop: subjectHop,
      lane: 'data',
    },
  })

  expanded.forEach((b, i) => {
    const onPath = !focusBranches || matchedBackends.includes(b)
    placed.push({
      col: colBackend,
      row: i,
      w: COL_W.hop,
      node: {
        id: b.id,
        kind: (b.hop.resource?.kind || 'BACKEND').toUpperCase(),
        name: b.hop.resource?.name ?? '',
        sub: onPath ? hopSub(b.hop) : 'not on the selected path',
        tone: hopTone(b.hop, origin),
        dim: !onPath,
        notes: hopNotes(b.hop),
        ref: b.hop.resource,
        hop: b.hop,
        lane: 'data',
      },
    })
  })

  if (collapsed.length > 0) {
    placed.push({
      col: colBackend,
      row: expanded.length,
      w: COL_W.hop,
      node: {
        id: 'collapsed:backends',
        kind: `${collapsed.length} MORE`,
        name: collapsed.length === 1 ? '1 more route' : `${collapsed.length} more routes`,
        // Named so the row is a statement, not a truncation: these are quiet
        // because nothing was found on them, not because they were dropped.
        sub: 'nothing found · not on the selected path',
        tone: 'unknown',
        dim: true,
        lane: 'data',
      },
    })
  }

  const deliveryBlocked = (asSeen ? routeMark(asSeen, { stale, running }) : 'untested') === 'failed'
  podGroups.forEach((g, i) => {
    const hop = g.hop
    const roster = hop.config?.pods ?? []
    const total = hop.config?.podTotal ?? roster.length
    const ready = typeof hop.meta?.ready === 'number' ? (hop.meta.ready as number) : roster.filter((p) => p.ready).length
    const selected = typeof hop.meta?.selected === 'number' ? (hop.meta.selected as number) : total
    const publishNotReady = !!hop.meta?.publishNotReadyAddresses
    const probes = probesFromOrigin(hop.probes ?? [], origin)

    // Anomaly-first: keeping the FIRST six rows hid the failing or excluded Pod
    // behind five healthy ones, which is exactly the row worth showing.
    const rank = (x: PodStatus): number => {
      const mine = probesForPod(x, probes).filter((q) => !q.skipped)
      if (mine.some((q) => !q.ok || q.tone === 'unhealthy')) return 0
      if (mine.some(isSlow)) return 1
      if (!x.ready) return 2
      if (mine.length === 0) return 3
      return 4
    }
    const ordered = [...roster].sort((a, b) => rank(a) - rank(b))
    const podRows: PodRow[] = []
    for (const p of ordered.slice(0, POD_ROW_MAX)) {
      const mine = probesForPod(p, probes).filter((x) => !x.skipped)
      const failed = mine.find((x) => !x.ok || x.tone === 'unhealthy')
      let mark: Mark
      let detail: string
      if (!p.ready && !publishNotReady) {
        mark = 'excluded'
        detail = 'not ready — nothing sent here'
      } else if (failed) {
        mark = 'failed'
        detail = failed.detail || failed.error || 'refused'
      } else if (mine.length === 0 && deliveryBlocked) {
        mark = 'blocked'
        detail = 'not reached — failed earlier'
      } else if (mine.length === 0) {
        mark = 'untested'
        detail = 'not tested'
      } else {
        const slowest = mine.filter(isSlow).sort((a, b) => (b.latencyNs ?? 0) - (a.latencyNs ?? 0))[0]
        mark = slowest ? 'slow' : 'proved'
        const best = mine.find((x) => x.layer === 'http') ?? mine[0]
        detail = slowest ? `slow · ${formatLatency(slowest.latencyNs)}` : best?.detail || 'reached'
      }
      if (!p.ready && publishNotReady) detail = `${detail} · not ready, sent traffic anyway`
      podRows.push({ name: p.name, mark, detail, ref: { kind: 'Pod', name: p.name, namespace: trace.subject.namespace } })
    }

    placed.push({
      col: colPods,
      row: i,
      w: COL_W.pods,
      node: {
        id: g.id,
        kind: 'PODS',
        // "taking traffic" claims observed delivery; readiness only establishes
        // ELIGIBILITY. The inspector already says "eligible" for this same
        // number - the graph must not contradict it.
        name: `${ready} of ${selected} eligible`,
        sub: publishNotReady
          ? 'not-ready Pods are sent traffic too'
          : ready === selected
            ? 'every selected Pod is eligible'
            : `${selected - ready} not eligible`,
        tone: hopTone(hop, origin),
        hop,
        notes: hopNotes(hop),
        anomalies: populationAnomalies(roster, total, probes, publishNotReady),
        podRows,
        moreRows: Math.max(0, roster.length - POD_ROW_MAX),
        lane: 'data',
      },
    })
  })

  // ---- resolve geometry ----
  const usedCols = [...new Set(placed.map((p) => p.col))].sort((a, b) => a - b)
  const colX = new Map<number, number>()
  const colW = new Map<number, number>()
  let x = 0
  for (const c of usedCols) {
    const w = Math.max(...placed.filter((p) => p.col === c).map((p) => p.w))
    colW.set(c, w)
    colX.set(c, x)
    x += w + GUTTER
  }

  const heightOf = (p: Placed) => estHeight(p.node)

  const controlPlaced = placed.filter((p) => p.node.lane === 'control')
  const dataPlaced = placed.filter((p) => p.node.lane === 'data')
  const controlH = controlPlaced.reduce((m, p) => Math.max(m, heightOf(p)), 0)
  const controlTop = controlPlaced.length > 0 ? LANE_PAD.top : 0
  const dataTop = controlPlaced.length > 0 ? controlTop + controlH + LANE_PAD.bottom + LANE_GAP + LANE_PAD.top : LANE_PAD.top

  const nodes: GraphNode[] = []
  const pos = new Map<string, GraphNode>()

  for (const p of controlPlaced) {
    const n: GraphNode = { ...p.node, x: colX.get(p.col)!, y: controlTop, w: colW.get(p.col)!, h: heightOf(p) }
    nodes.push(n)
    pos.set(n.id, n)
  }

  const byCol = new Map<number, Placed[]>()
  for (const p of dataPlaced) {
    const arr = byCol.get(p.col) ?? []
    arr.push(p)
    byCol.set(p.col, arr)
  }
  const colHeights = new Map<number, number>()
  for (const [c, list] of byCol) {
    colHeights.set(c, list.reduce((sum, p) => sum + heightOf(p), 0) + (list.length - 1) * ROW_GAP)
  }
  const dataH = Math.max(0, ...colHeights.values())

  for (const [c, list] of byCol) {
    let y = dataTop + (dataH - colHeights.get(c)!) / 2
    for (const p of list.sort((a, b) => a.row - b.row)) {
      const h = heightOf(p)
      const n: GraphNode = { ...p.node, x: colX.get(c)!, y, w: colW.get(c)!, h }
      nodes.push(n)
      pos.set(n.id, n)
      y += h + ROW_GAP
    }
  }

  // ---- edges ----
  const edges: GraphEdge[] = []
  const brackets: { d: string }[] = []
  const crossesLanes = new Set<string>()

  const connect = (id: string, fromId: string, toId: string, mark: Mark, label: string) => {
    const a = pos.get(fromId)
    const b = pos.get(toId)
    if (!a || !b) return
    if (a.lane !== b.lane) crossesLanes.add(id)
    const x1 = a.x + a.w
    const y1 = a.y + a.h / 2
    const x2 = b.x
    const y2 = b.y + b.h / 2
    const dx = Math.max(30, (x2 - x1) * 0.45)
    edges.push({
      id,
      d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`,
      mark,
      label: truncate(label),
      title: label,
      px: (x1 + x2) / 2,
      py: (y1 + y2) / 2,
    })
  }

  const originNodeId = `origin:${origin.id}`
  // 'own' is this origin's result. 'none' means the producer told us it did not
  // test this route, which outranks anything it did on OTHER routes - so the
  // coarse pooled gate only applies to legacy traces with no breakdown at all.
  const hasEvidence = ev.kind === 'own' || (ev.kind === 'rollup' && originProducedEvidence(origin))
  const routeMarkNow: Mark = asSeen ? routeMark(asSeen, { stale, running }) : 'untested'
  // A relay can never read as proof: it bypassed the real network path however
  // clean the response was.
  const entryMark: Mark = !hasEvidence
    ? origin.mark
    : originIsControl && routeMarkNow === 'proved'
      ? 'proxied'
      : routeMarkNow
  const originBlocked = !!origin.unavailable && origin.mark === 'blocked'
  const noEvidenceLabel =
    origin.mark === 'denied' ? 'not permitted' : origin.mark === 'blocked' ? 'not routable' : 'not tested'
  const entryLabel = !hasEvidence
    ? noEvidenceLabel
    : asSeen?.evidence || (originIsControl ? 'relayed by Kubernetes' : 'request')

  // The request enters at the entry points that serve this host; everything
  // after is configuration, drawn dotted. There is no segment-local evidence to
  // claim otherwise.
  if (upstreams.length > 0 && !originSkipsEntries) {
    for (const up of upstreams) {
      const id = `n:${refId(up.resource)}`
      const active = activeUpstreams.includes(up)
      connect(`e:origin-${id}`, originNodeId, id, originBlocked ? 'blocked' : active ? entryMark : 'untested', active ? entryLabel : 'other host')
      connect(`e:${id}-subject`, id, subjectNodeId, 'config', 'routes to')
    }
  } else {
    // The declared entries stay drawn, and stay CONFIG: they are how traffic is
    // meant to arrive, and this run did not use them.
    for (const up of upstreams) {
      connect(`e:${`n:${refId(up.resource)}`}-subject`, `n:${refId(up.resource)}`, subjectNodeId, 'config', 'routes to')
    }
    connect(
      'e:origin-subject',
      originNodeId,
      subjectNodeId,
      originBlocked ? 'blocked' : entryMark,
      originSkipsEntries ? 'direct to backend' : entryLabel,
    )
  }
  for (const b of expanded) {
    const onPath = !focusBranches || matchedBackends.includes(b)
    connect(`e:subject-${b.id}`, subjectNodeId, b.id, onPath ? 'config' : 'excluded', onPath ? 'sends to' : 'other host')
  }
  if (collapsed.length > 0) connect('e:subject-collapsed', subjectNodeId, 'collapsed:backends', 'config', 'also serves')
  // When the producer localized the break to the Service's own routing, the
  // Service->Pods edge is where it happened - packets reached the workload, so
  // what sits between them is what failed. Only ever drawn from a boundary the
  // producer actually established; an unlocalized failure colours nothing.
  const boundary = ev.kind === 'own' ? routeForOrigin(route, origin.id)?.failedBoundary : undefined
  const podEdgeMark: Mark = boundary === 'service-routing' ? 'failed' : 'config'
  const podEdgeLabel = boundary === 'service-routing' ? 'breaks here' : 'selects'
  for (const g of podGroups) connect(`e:${g.id}`, g.parentId, g.id, podEdgeMark, podEdgeLabel)

  // ---- lane boxes: bound only their own nodes ----
  const boxFor = (list: GraphNode[], label: string, help: string, color: string, dashed?: boolean): LaneBox | undefined => {
    if (list.length === 0) return undefined
    const x0 = Math.min(...list.map((n) => n.x)) - LANE_PAD.x
    const x1 = Math.max(...list.map((n) => n.x + n.w)) + LANE_PAD.x
    const y0 = Math.min(...list.map((n) => n.y)) - LANE_PAD.top
    const y1 = Math.max(...list.map((n) => n.y + n.h)) + LANE_PAD.bottom
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, label, help, color, dashed }
  }
  const laneControl = boxFor(
    nodes.filter((n) => n.lane === 'control'),
    'FROM OUTSIDE THE CLUSTER',
    'Started outside the cluster. What it crosses on the way depends on the address it was given — a public hostname goes through your load balancer and ingress, while a relayed request skips the cluster network altogether.',
    'var(--color-info)',
    true,
  )
  const laneData = boxFor(
    nodes.filter((n) => n.lane === 'data'),
    'FROM INSIDE THE CLUSTER',
    'Started from a Pod inside the cluster, so the request goes through the cluster’s own routing, network policy and mesh. It dials the backend directly, so it says nothing about whether the front door works.',
    'var(--accent-text)',
  )

  // A cross-lane edge's midpoint lands on the dataplane lane's top edge, which
  // is exactly where the lane label sits. Park those pills in the gap between
  // the lanes - otherwise empty - so neither covers the other.
  if (laneControl && laneData) {
    const gapCentre = (laneControl.y + laneControl.h + laneData.y) / 2
    for (const e of edges) {
      if (crossesLanes.has(e.id)) e.py = gapCentre
    }
  }

  const canvas = {
    w: Math.max(...nodes.map((n) => n.x + n.w), 300) + LANE_PAD.x + 4,
    h: Math.max(...nodes.map((n) => n.y + n.h), 200) + LANE_PAD.bottom + 4,
  }

  return { nodes, edges, brackets, originIsControl, canvas, laneControl, laneData }
}
