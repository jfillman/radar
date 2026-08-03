import type { Trace, Hop, ResourceRef, RouteResult, PodStatus, ProbeResult } from './types'
import type { Mark, SevTone } from './reachMarks'
import { routeMark, isSlow, formatLatency } from './reachMarks'
import type { Origin } from './reachOrigins'
import { podProbeKey } from './podReach'

/**
 * Layout constants. Positions are COMPUTED from content, never hand-placed:
 * node boxes size to their text, so fixed coordinates collide the moment a name
 * or a tag runs long. Columns are laid out left to right with a guaranteed
 * gutter wide enough to hold an edge pill without touching either neighbour.
 */
const GUTTER = 150
const ROW_GAP = 14
const LANE_PAD = { x: 14, top: 22, bottom: 14 }
const LANE_GAP = 20
/** Pills are truncated to this many characters so one never outgrows a gutter. */
export const PILL_MAX_CHARS = 20
/** Hard cap on a pill's rendered width. MUST stay under GUTTER, or a pill
 *  overruns its gutter and lands on the node beside it. */
export const PILL_MAX_PX = 132

/** Column order. Every node belongs to exactly one, which is what guarantees
 *  left-to-right reading order and non-overlap. */
const enum Col {
  Origin = 0,
  Relay = 1,
  Subject = 2,
  Endpoints = 3,
}

const COL_WIDTH: Record<number, number> = {
  [Col.Origin]: 204,
  [Col.Relay]: 192,
  [Col.Subject]: 204,
  [Col.Endpoints]: 264,
}

/** Above this many backends the individual pods collapse into one population
 *  node with anomalies pinned under it - a wall of identical rows conveys less
 *  than a count plus the outliers. */
export const POD_DETAIL_MAX = 5

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

export interface PodRow {
  name: string
  mark: Mark
  detail: string
  ref: ResourceRef
}

/** Rows shown before collapsing into a "+N more" line. */
export const POD_ROW_MAX = 6

export interface GraphEdge {
  id: string
  /** SVG path data. */
  d: string
  mark: Mark
  label: string
  /** Full label, when `label` was truncated to fit the gutter. */
  title?: string
  /** Pill centre, in canvas coordinates. Always inside a gutter. */
  px: number
  py: number
}

export interface LaneBox {
  x: number
  y: number
  w: number
  h: number
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
function estHeight(n: { anomalies?: unknown[]; podRows?: unknown[]; moreRows?: number; isOrigin?: boolean; sub?: string }): number {
  const base = n.isOrigin ? 66 : 60
  const anomalies = n.anomalies?.length ?? 0
  const rows = n.podRows?.length ?? 0
  // Long sub-lines wrap; approximate at ~34 characters per line.
  const subLines = Math.max(1, Math.ceil((n.sub?.length ?? 0) / 34))
  return (
    base +
    (subLines - 1) * 13 +
    (anomalies > 0 ? 8 + anomalies * 17 : 0) +
    (rows > 0 ? 8 + rows * 17 + (n.moreRows ? 15 : 0) : 0)
  )
}

/** Health from a hop's findings alone - the same rule the topology view uses:
 *  a critical finding is red only when nothing is serving. */
function hopTone(hop?: Hop): SevTone {
  if (!hop) return 'unknown'
  const findings = hop.findings ?? []
  const ready = typeof hop.meta?.ready === 'number' ? (hop.meta.ready as number) : undefined
  const serving = typeof ready === 'number' && ready > 0
  if (findings.some((f) => f.severity === 'critical')) return serving ? 'degraded' : 'unhealthy'
  if (findings.some((f) => f.severity === 'warning')) return 'degraded'
  const live = (hop.probes ?? []).filter((p) => !p.skipped)
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
 * Anomalies held out of a population aggregate. Averaging them away is exactly
 * how a single refusing endpoint that real users hit becomes invisible, so each
 * category is counted and named rather than folded into a percentage.
 */
function populationAnomalies(hop: Hop, roster: PodStatus[], total: number): { mark: Mark; text: string }[] {
  const probes = hop.probes ?? []
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
  const notReady = roster.filter((p) => !p.ready)
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
  col: Col
  row: number
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
  const downstream = trace.downstream ?? []
  const subjectHop = downstream.find((h) => refId(h.resource) === subjectId)
  const podsHop = downstream.find(isPodsHop)
  const upstreams = trace.upstreams ?? []

  const entryHop = upstreams[0]
  const isFront =
    !!entryHop && !!route?.route && upstreams.some((u) => (u.resource?.name ? route.route.includes(u.resource.name) : false))

  // ---- placement ----
  placed.push({
    col: Col.Origin,
    row: 0,
    node: {
      id: `origin:${origin.id}`,
      kind: originIsControl ? 'PROBE ORIGIN · CONTROL PLANE' : 'PROBE ORIGIN · DATAPLANE',
      name: origin.name,
      sub: origin.mech,
      tone: 'info',
      tag: SHORT_KIND_TAG[origin.kindTag] ?? origin.kindTag,
      isOrigin: true,
      lane: originIsControl ? 'control' : 'data',
    },
  })

  // A relay is not a hop. An explicit kube-apiserver node cost a whole column
  // to repeat what the origin capsule, the dashed proxy edge, the control-plane
  // lane label and the inspector's caveat already say - so the relay lives on
  // the edge instead, and the width goes to the path.
  if (!originIsControl && isFront && entryHop) {
    placed.push({
      col: Col.Relay,
      row: 0,
      node: {
        id: `n:${refId(entryHop.resource)}`,
        kind: `${(entryHop.resource?.kind || 'ENTRY').toUpperCase()} · LISTENER`,
        name: entryHop.resource?.name ?? 'entry',
        sub: (entryHop.config?.addresses ?? []).join(', ') || (entryHop.config?.hostnames ?? []).join(', ') || 'entry point',
        tone: hopTone(entryHop),
        ref: entryHop.resource,
        hop: entryHop,
        lane: 'data',
      },
    })
  }

  placed.push({
    col: Col.Subject,
    row: 0,
    node: {
      id: `n:${subjectId}`,
      kind: `${(trace.subject.kind || 'SERVICE').toUpperCase()}${route?.target ? ' · PORT' : ''}`,
      name: `${trace.subject.name}${route?.target ? ` ${route.target}` : ''}`,
      sub: subjectHop?.config?.clusterIP
        ? `ClusterIP ${subjectHop.config.clusterIP}`
        : subjectHop?.config?.serviceType || trace.subject.namespace || '',
      tone: hopTone(subjectHop),
      ref: trace.subject,
      hop: subjectHop,
      lane: 'data',
    },
  })

  const roster = podsHop?.config?.pods ?? []
  const total = podsHop?.config?.podTotal ?? roster.length
  const ready = typeof podsHop?.meta?.ready === 'number' ? (podsHop.meta.ready as number) : roster.filter((p) => p.ready).length
  const selected = typeof podsHop?.meta?.selected === 'number' ? (podsHop.meta.selected as number) : total
  const publishNotReady = !!podsHop?.meta?.publishNotReadyAddresses
  const aggregated = roster.length > POD_DETAIL_MAX || total > roster.length
  const anomalies = podsHop ? populationAnomalies(podsHop, roster, total) : []

  const deliveryBlocked = (route ? routeMark(route, { stale, running }) : 'untested') === 'failed'
  const podRows: PodRow[] = []
  if (podsHop) {
    const probes = podsHop.probes ?? []
    for (const p of roster.slice(0, POD_ROW_MAX)) {
      const mine = probesForPod(p, probes).filter((x) => !x.skipped)
      const failed = mine.find((x) => !x.ok || x.tone === 'unhealthy')
      let mark: Mark
      let detail: string
      if (!p.ready) {
        // Excluded is not failed: the dataplane never routed here, so there is
        // no result about this endpoint's ability to serve.
        mark = 'excluded'
        detail = 'NotReady — never routed'
      } else if (failed) {
        // An endpoint's OWN failure outranks any upstream verdict. When the
        // route is unreachable *because* these endpoints refused, they are the
        // failure - calling them "blocked" would hide the actual fault.
        mark = 'failed'
        detail = failed.detail || failed.error || 'refused'
      } else if (mine.length === 0 && deliveryBlocked) {
        // No result AND an upstream failure that explains why it never ran.
        mark = 'blocked'
        detail = 'not reached — failed earlier'
      } else if (mine.length === 0) {
        mark = 'untested'
        detail = 'not probed'
      } else {
        const slowest = mine.filter(isSlow).sort((a, b) => (b.latencyNs ?? 0) - (a.latencyNs ?? 0))[0]
        mark = slowest ? 'slow' : 'proved'
        const best = mine.find((x) => x.layer === 'http') ?? mine[0]
        detail = slowest ? `slow · ${formatLatency(slowest.latencyNs)}` : best?.detail || 'reached'
      }
      podRows.push({ name: p.name, mark, detail, ref: { kind: 'Pod', name: p.name, namespace: trace.subject.namespace } })
    }

    placed.push({
      col: Col.Endpoints,
      row: 0,
      node: {
        id: 'n:endpoints',
        kind: aggregated ? 'ENDPOINT POPULATION' : 'ENDPOINT SELECTION',
        name: `${ready} eligible endpoint${ready === 1 ? '' : 's'}`,
        // publishNotReadyAddresses makes `ready` a PUBLISHED count, not a
        // readiness count - saying "N of M ready" there would be false.
        sub: publishNotReady ? `${selected} selected · published regardless of readiness` : `from EndpointSlices · ${selected} selected`,
        tone: hopTone(podsHop),
        hop: podsHop,
        anomalies,
        podRows,
        moreRows: Math.max(0, roster.length - POD_ROW_MAX),
        lane: 'data',
      },
    })
  }

  // ---- resolve geometry ----
  const usedCols = [...new Set(placed.map((p) => p.col))].sort((a, b) => a - b)
  const colX = new Map<number, number>()
  const colW = new Map<number, number>()
  let x = 0
  for (const c of usedCols) {
    const w = COL_WIDTH[c] ?? 200
    colW.set(c, w)
    colX.set(c, x)
    x += w + GUTTER
  }

  const heightOf = (p: Placed) => estHeight(p.node)

  // Control-plane row sits above the dataplane band; both are packed to their
  // own content so neither reserves space it does not use.
  const controlPlaced = placed.filter((p) => p.node.lane === 'control')
  const dataPlaced = placed.filter((p) => p.node.lane === 'data')
  const controlH = controlPlaced.reduce((m, p) => Math.max(m, heightOf(p)), 0)
  const controlTop = controlPlaced.length > 0 ? LANE_PAD.top : 0
  const dataTop = controlPlaced.length > 0 ? controlTop + controlH + LANE_PAD.bottom + LANE_GAP + LANE_PAD.top : LANE_PAD.top

  const nodes: GraphNode[] = []
  const pos = new Map<string, GraphNode>()

  for (const p of controlPlaced) {
    const w = colW.get(p.col)!
    const h = heightOf(p)
    const n: GraphNode = { ...p.node, x: colX.get(p.col)!, y: controlTop, w, h }
    nodes.push(n)
    pos.set(n.id, n)
  }

  // Within the dataplane, each column stacks its own rows. Columns are then
  // vertically centred against the tallest column so the spine reads straight.
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
    const colH = colHeights.get(c)!
    let y = dataTop + (dataH - colH) / 2
    for (const p of list.sort((a, b) => a.row - b.row)) {
      const w = colW.get(c)!
      const h = heightOf(p)
      const n: GraphNode = { ...p.node, x: colX.get(c)!, y, w, h }
      nodes.push(n)
      pos.set(n.id, n)
      y += h + ROW_GAP
    }
  }

  // ---- edges ----
  const edges: GraphEdge[] = []
  const brackets: { d: string }[] = []

  const crossesLanes = new Set<string>()

  /** Connects two placed nodes right-edge to left-edge, with the pill parked in
   *  the gutter between their columns - which is why it can never overlap a box. */
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
      title: label.length > PILL_MAX_CHARS ? label : undefined,
      px: (x1 + x2) / 2,
      py: (y1 + y2) / 2,
    })
  }

  const originNodeId = `origin:${origin.id}`
  const entryMark: Mark = route ? routeMark(route, { stale, running }) : 'untested'
  const originBlocked = !!origin.unavailable && origin.mark === 'blocked'

  if (originIsControl) {
    // A clean relay can never read as `proved`: it bypassed the dataplane.
    connect(
      'e:origin-subject',
      originNodeId,
      `n:${subjectId}`,
      originBlocked ? 'blocked' : entryMark === 'proved' ? 'proxied' : entryMark,
      originBlocked ? origin.unavailable! : route?.evidence || 'relayed, bypassing the dataplane',
    )
  } else if (isFront && entryHop) {
    const entryNodeId = `n:${refId(entryHop.resource)}`
    connect('e:origin-entry', originNodeId, entryNodeId, entryMark, route?.evidence || 'entry point')
    connect('e:entry-subject', entryNodeId, `n:${subjectId}`, entryMark === 'failed' ? 'blocked' : entryMark, route?.target ? `backendRef · ${route.target}` : 'backendRef')
  } else {
    connect('e:origin-subject', originNodeId, `n:${subjectId}`, originBlocked ? 'blocked' : entryMark, originBlocked ? origin.unavailable! : route?.evidence || 'request to the Service')
  }

  if (podsHop) {
    // Membership is control-plane intent - the Service selector plus slice
    // contents. No packet traverses it, so it is always drawn as config.
    connect('e:subject-endpoints', `n:${subjectId}`, 'n:endpoints', 'config', 'endpoint selection (config)')

  }

  // ---- lane boxes: bound only their own nodes ----
  const boxFor = (list: GraphNode[]): LaneBox | undefined => {
    if (list.length === 0) return undefined
    const x0 = Math.min(...list.map((n) => n.x)) - LANE_PAD.x
    const x1 = Math.max(...list.map((n) => n.x + n.w)) + LANE_PAD.x
    const y0 = Math.min(...list.map((n) => n.y)) - LANE_PAD.top
    const y1 = Math.max(...list.map((n) => n.y + n.h)) + LANE_PAD.bottom
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }
  const laneControl = boxFor(nodes.filter((n) => n.lane === 'control'))
  const laneData = boxFor(nodes.filter((n) => n.lane === 'data'))

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
