import type { Trace, RouteResult, ResourceRef } from './types'
import type { Mark, SevTone } from './reachMarks'
import { routeMark, routeChip, routeTone } from './reachMarks'
import type { Origin, OriginId } from './reachOrigins'
import { strongestGap, actionableGap } from './reachOrigins'
import type { GraphNode, GraphEdge } from './reachGraphModel'

export type InspectorAction = 'run-in-cluster' | 'refresh' | 'open-resource' | 'copy-command'

export interface InspectorCTA {
  text: string
  primary?: boolean
  action?: InspectorAction
  ref?: ResourceRef
  command?: string
  /** Set when the CTA describes something Radar cannot do - rendered inert. */
  disabledReason?: string
}

export interface Inspector {
  chipTone: SevTone
  chipText: string
  title: string
  body: string
  scopeHeader: string
  scope: { k: string; v: string }[]
  evidence: { mark: Mark; text: string }[]
  /** The caveats. Never optional in spirit: an empty list is a claim that the
   *  evidence is complete, so it is only ever empty when that is true. */
  notProve: string[]
  next: {
    header: string
    body: string
    blocked?: string
    ctas: InspectorCTA[]
  }
}

/** Selection is an id: `origin:<id>`, `n:<nodeId>`, `e:<edgeId>`, or none. */
export type Selection = string | undefined

const NOT_DATAPLANE = 'Nothing about the normal network path. Kubernetes relayed this for us, so routing, network policy and the mesh were all skipped.'
const SYNTHETIC_IDENTITY =
  'That your app can reach it. This test ran as Radar, not as your application, and anything that checks who is calling may answer differently.'

function originScope(o: Origin, trace: Trace): { k: string; v: string }[] {
  const runsIn: Record<OriginId, string> = {
    incluster: `a Pod in ${trace.subject.namespace || 'the cluster'}`,
    apiserver: 'the kube-apiserver process',
    local: 'your workstation (outside the cluster)',
    caller: 'the application workload’s own Pod',
    external: 'a client on the public internet',
  }
  return [
    { k: 'ORIGIN', v: o.name },
    { k: 'RUNS IN', v: runsIn[o.id] },
    { k: 'IDENTITY', v: o.identity },
    { k: 'MECHANISM', v: o.mech },
    {
      k: 'CALLER',
      v:
        o.kind === 'synthetic'
          ? 'synthetic approximation — not the real caller'
          : o.kind === 'real-caller'
            ? 'the actual application caller'
            : o.kind === 'relayed'
              ? 'not a caller — a relay'
              : 'a real client, but not the application workload',
    },
  ]
}

/**
 * The next-step prompt.
 *
 * Driven by the strongest gap Radar can CLOSE, not the strongest gap that
 * exists. The unreachable ceiling (a real-caller test Radar cannot run) is
 * stated underneath as a caveat instead of being offered as an action - a
 * button that can never be pressed is not a next step.
 */
function gapNext(origins: Origin[], current: Origin, namespace?: string): Inspector['next'] {
  const actionable = actionableGap(origins)
  const ceiling = strongestGap(origins)
  // Named only when it is genuinely out of reach, so it reads as a limit on the
  // evidence rather than as a suggestion.
  const ceilingNote = ceiling?.unsupported ? `Even then, ${ceiling.name.toLowerCase()} stays untested — ${ceiling.unavailable}` : undefined

  const denied = origins.find((o) => o.mark === 'denied')
  if (!actionable && denied) {
    const ns = namespace || '<namespace>'
    return {
      header: 'ASK FOR THIS PERMISSION',
      // The permission is NAMED, and the command is one that actually runs.
      // The button previously carried no command at all, so the only control on
      // screen in the state where the user is most stuck did nothing.
      body: `Running an in-cluster probe needs \`create\` on \`jobs\` in ${ns}. Grant it, or run the check from a workload you already control.`,
      blocked: denied.unavailable,
      ctas: [{ text: 'Copy the permission check', action: 'copy-command', command: `kubectl auth can-i create jobs -n ${ns}` }],
    }
  }
  if (!actionable || actionable.id === current.id) {
    return {
      header: 'NO STRONGER TEST AVAILABLE',
      body: 'Every origin Radar can use has been tried for this scenario. Re-run only to refresh how current the evidence is.',
      blocked: ceilingNote,
      ctas: [{ text: '⟳ Re-run', action: 'refresh' }],
    }
  }
  return {
    header: 'NEXT STRONGEST TEST',
    body: `${actionable.name} has not been used for this scenario, and is the strongest evidence Radar can still collect.`,
    blocked: ceilingNote,
    ctas:
      actionable.id === 'incluster'
        ? [{ text: '⚗ Run in-cluster probe', primary: true, action: 'run-in-cluster' }]
        : [{ text: '⟳ Re-run', action: 'refresh' }],
  }
}

interface Ctx {
  trace: Trace
  route?: RouteResult
  origin: Origin
  origins: Origin[]
  nodes: GraphNode[]
  edges: GraphEdge[]
  stale?: boolean
  running?: boolean
}

function originInspector(o: Origin, ctx: Ctx): Inspector {
  const bodies: Record<OriginId, string> = {
    incluster:
      'A short-lived probe Pod created by Radar. It exercises the real dataplane — kube-proxy, NetworkPolicy, the mesh — but with a synthetic identity. It is not the application caller.',
    apiserver:
      'Requests are relayed by the kube-apiserver. This origin lives in the control-plane lane: it never traverses kube-proxy, NetworkPolicy or the mesh.',
    local:
      'Radar runs on your workstation. Its network position is unknown — it may be a VPN or a private LAN — so results from here are never reported as coming from the internet.',
    caller: 'The real application workload, with its own ServiceAccount, namespace and sidecar. This would be the strongest possible evidence.',
    external: 'A genuine request from outside the cluster. This is the only origin that could prove the front door end to end.',
  }
  return {
    chipTone: o.kind === 'synthetic' ? 'degraded' : o.kind === 'relayed' ? 'info' : o.unsupported ? 'unknown' : 'healthy',
    chipText: o.kindTag,
    title: o.name,
    body: o.unavailable ? `${bodies[o.id]}\n\n${o.unavailable}` : bodies[o.id],
    scopeHeader: 'ORIGIN IDENTITY',
    scope: originScope(o, ctx.trace),
    evidence: [{ mark: o.mark, text: o.unavailable ? 'this origin produced no evidence' : 'this origin’s latest result for the selected scenario' }],
    notProve: o.kind === 'synthetic' ? [SYNTHETIC_IDENTITY] : o.kind === 'relayed' ? [NOT_DATAPLANE] : [],
    next: gapNext(ctx.origins, o, ctx.trace.subject.namespace),
  }
}

function nodeInspector(node: GraphNode, ctx: Ctx): Inspector {
  if (node.id === 'n:endpoints') {
    const hop = node.hop
    const roster = hop?.config?.pods ?? []
    const total = hop?.config?.podTotal ?? roster.length
    const ready = typeof hop?.meta?.ready === 'number' ? (hop.meta.ready as number) : roster.filter((p) => p.ready).length
    const selected = typeof hop?.meta?.selected === 'number' ? (hop.meta.selected as number) : total
    // Same rule as the graph: with publishNotReadyAddresses the dataplane routes
    // to not-ready Pods, so none of them is excluded from routing.
    const publishNotReady = !!hop?.meta?.publishNotReadyAddresses
    const notReady = publishNotReady ? [] : roster.filter((p) => !p.ready)
    const omitted = total - roster.length
    const notProve: string[] = []
    if (omitted > 0) notProve.push(`The ${omitted} endpoints that were not probed. Unprobed is not proven.`)
    if (notReady.length > 0)
      notProve.push(`The ${notReady.length} excluded NotReady endpoint${notReady.length > 1 ? 's' : ''} — no traffic was routed there, so nothing was tested.`)
    return {
      chipTone: node.tone,
      chipText: 'backends',
      title: `${ready} of ${selected} Pods taking traffic`,
      body: 'The Pods behind this Service. Kubernetes only sends traffic to the ones that are ready — the rest are selected but sitting out.',
      scopeHeader: 'BACKENDS',
      scope: [
        { k: 'SELECTED', v: `${selected} Pods match the selector` },
        { k: 'TAKING TRAFFIC', v: `${ready}` },
        {
          k: 'SITTING OUT',
          v: publishNotReady
            ? 'none — this Service sends traffic to not-ready Pods too'
            : notReady.length > 0
              ? `${notReady.length} not ready, so nothing is sent to them`
              : 'none',
        },
        { k: 'PROBED', v: omitted > 0 ? `${roster.length} of ${total} (sampled)` : `${roster.length}` },
      ],
      evidence: [
        { mark: 'config', text: 'membership read from EndpointSlices' },
        ...(node.anomalies ?? []),
      ],
      notProve,
      next:
        notReady.length > 0
          ? {
              header: 'READINESS, NOT REACHABILITY',
              body: 'An excluded Pod is a coverage problem, not a path failure. Reachability cannot test an endpoint the dataplane refuses to route to — inspect its readiness probe.',
              ctas: [{ text: 'Open the NotReady Pod', primary: true, action: 'open-resource', ref: notReady[0] ? { kind: 'Pod', name: notReady[0].name, namespace: ctx.trace.subject.namespace } : undefined }],
            }
          : gapNext(ctx.origins, ctx.origin),
    }
  }

  // A NotReady pod: excluded, never tested. The distinction from "failed" is the
  // whole point of this panel.
  if (node.dim && node.ref?.kind === 'Pod') {
    return {
      chipTone: 'unknown',
      chipText: 'excluded from routing',
      title: node.name,
      body: 'Selected by the Service but NotReady, so it is not an eligible endpoint. No traffic was routed to it — this is a readiness gap, not a failed path.',
      scopeHeader: 'WHY EXCLUDED',
      scope: [
        { k: 'STATUS', v: node.sub },
        { k: 'ELIGIBLE', v: 'no — omitted from the EndpointSlice' },
        { k: 'PROBED', v: 'never — the dataplane routes nothing here' },
      ],
      evidence: [{ mark: 'excluded', text: 'omitted from endpoint membership' }],
      notProve: ['That this Pod would fail if it became Ready — it has not been tested.'],
      next: {
        header: 'NEXT INVESTIGATION',
        body: 'Inspect the failing readiness probe on this Pod.',
        ctas: [{ text: 'Open Pod', primary: true, action: 'open-resource', ref: node.ref }],
      },
    }
  }

  const findings = node.hop?.findings ?? []
  return {
    chipTone: node.tone,
    chipText: 'resource health only',
    title: `${node.kind.split(' · ')[0]} ${node.name}`,
    body: 'The dot shows whether this resource itself is healthy. It says nothing about whether traffic got here — click a line to see what actually happened.',
    scopeHeader: 'HEALTH IS NOT REACHABILITY',
    scope: [
      { k: 'HEALTH', v: 'from the resource’s own status' },
      { k: 'TRAFFIC', v: 'shown on the lines, not the boxes' },
      ...(node.sub ? [{ k: 'DETAIL', v: node.sub }] : []),
    ],
    evidence:
      findings.length > 0
        ? findings.map((f) => ({ mark: (f.severity === 'critical' ? 'failed' : 'config') as Mark, text: f.cause || f.message }))
        : [{ mark: 'config' as Mark, text: 'health is derived from resource status, not from traffic' }],
    notProve: ['That any request reached this resource.'],
    next: {
      header: 'READ THE EDGES',
      body: 'Click any labelled connection to see its origin, mechanism, evidence and caveats.',
      ctas: [],
    },
  }
}

function edgeInspector(edge: GraphEdge, ctx: Ctx): Inspector {
  const { route, origin, trace } = ctx
  const mark = edge.mark

  if (edge.id === 'e:subject-endpoints') {
    return {
      chipTone: 'info',
      chipText: 'config relationship',
      title: 'Which Pods this Service selects',
      body: 'Configuration, not traffic — drawn dotted for that reason. The Service’s selector decides which Pods are eligible. Nothing travels along this line.',
      scopeHeader: 'SELECTOR',
      scope: [
        { k: 'SELECTOR', v: Object.entries(trace.downstream?.find((h) => h.config?.selector)?.config?.selector ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') || '—' },
        { k: 'MEMBERSHIP', v: 'from EndpointSlices, control plane' },
      ],
      evidence: [{ mark: 'config', text: 'membership is intent, not observed traffic' }],
      notProve: ['That kube-proxy actually delivered a request to any endpoint — read the delivery edges below it.'],
      next: gapNext(ctx.origins, origin, ctx.trace.subject.namespace),
    }
  }

  if (mark === 'excluded') {
    return {
      chipTone: 'unknown',
      chipText: 'not in the path',
      // edge.label is truncated to fit the graph pill - never a heading.
      title: `${origin.name} → ${route?.target || trace.subject.name}`,
      body: 'This endpoint is excluded from routing because it is NotReady. The dataplane never sent it traffic, so there is no result — excluded is not failed.',
      scopeHeader: 'SCOPE',
      scope: [{ k: 'ORIGIN', v: origin.name }, { k: 'SCENARIO', v: route?.route ?? '—' }],
      evidence: [{ mark: 'excluded', text: 'not an eligible endpoint at test time' }],
      notProve: ['Anything about this endpoint’s ability to serve — it was never in the path.'],
      next: { header: 'NEXT INVESTIGATION', body: 'Fix or inspect readiness, then re-run to include it in coverage.', ctas: [] },
    }
  }

  if (mark === 'blocked') {
    return {
      chipTone: 'unknown',
      chipText: 'not tested',
      title: `${origin.name} → ${route?.target || trace.subject.name}`,
      body: origin.unavailable
        ? origin.unavailable
        : 'This segment never ran because an earlier segment failed. It is not a second failure — nothing was learned here at all.',
      scopeHeader: 'SCOPE',
      scope: [{ k: 'ORIGIN', v: origin.name }, { k: 'SCENARIO', v: route?.route ?? '—' }],
      evidence: [{ mark: 'blocked', text: 'never executed' }],
      notProve: ['Anything about this segment — it was not exercised.'],
      next: gapNext(ctx.origins, origin, ctx.trace.subject.namespace),
    }
  }

  const baseScope = [
    { k: 'ORIGIN', v: `${origin.name}${origin.kind === 'synthetic' ? ' (synthetic)' : ''}` },
    { k: 'IDENTITY', v: origin.identity },
    { k: 'MECHANISM', v: origin.mech },
    ...(route ? [{ k: 'SCENARIO', v: route.route }] : []),
    ...(route?.target ? [{ k: 'DEST', v: route.target }] : []),
  ]

  const notProve: string[] = []
  if (origin.kind === 'synthetic') notProve.push(SYNTHETIC_IDENTITY)
  if (origin.kind === 'relayed') notProve.push(NOT_DATAPLANE)
  // Only meaningful when the resource actually HAS a front door. The external
  // origin is always unsupported, so an ungated check appended this caveat to
  // every resource - including plain ClusterIP Services with no entry point,
  // where it is simply untrue and dilutes the caveats that matter.
  const hasFrontDoor = (ctx.trace.upstreams ?? []).length > 0
  const externalOrigin = ctx.origins.find((o) => o.id === 'external')
  if (hasFrontDoor && externalOrigin?.unsupported && origin.id !== 'external') {
    notProve.push('That external clients can reach it — no request has entered through the front door.')
  }

  const evidence: { mark: Mark; text: string }[] = []
  const seen = new Set<string>()
  const addEvidence = (m: Mark, text: string) => {
    const key = text.trim().toLowerCase()
    if (!key || seen.has(key)) return
    seen.add(key)
    evidence.push({ mark: m, text })
  }
  if (route?.evidence) addEvidence(mark, route.evidence)
  for (const f of route?.localization ?? []) {
    // The detail usually already names the layer ("HTTP 404 · reached"), so
    // prefixing it produced "HTTP · HTTP 404". And the same fact can appear
    // more than once, which rendered as identical repeated lines.
    const layer = f.layer.toUpperCase()
    const detail = f.detail?.trim()
    const body = !detail ? layer : detail.toUpperCase().startsWith(layer) ? detail : `${layer} · ${detail}`
    addEvidence(f.ok ? 'proxied' : 'failed', `${body} — checked directly, past the entry point`)
  }
  if (evidence.length === 0) addEvidence(mark, edge.title ?? edge.label)

  const failed = mark === 'failed'
  const diagnosis = trace.diagnosis

  return {
    chipTone: route ? routeTone(route, { stale: ctx.stale, running: ctx.running }) : 'unknown',
    chipText: route ? routeChip(route, { stale: ctx.stale, running: ctx.running }) : 'not tested',
    title: `${origin.name} → ${route?.target || trace.subject.name}`,
    body: failed
      ? 'This is the first confirmed failure on the path. Everything after it was blocked, not tested — a blocked segment is an absence of evidence, not a second fault.'
      : mark === 'proved'
        ? 'A real request traversed the dataplane and the target answered. This is observed evidence, scoped to the identity that sent it.'
        : mark === 'proxied'
          ? 'The apiserver relayed a request and the target answered. That proves a serving process exists — it does not prove a normal in-cluster caller can reach it.'
          : mark === 'untested'
            ? 'No origin has exercised this segment. Configuration may predict it, but configuration is intent, not proof.'
            : mark === 'stale'
              ? 'This result predates a change to the cluster, so it is greyed and excluded from the verdict rather than carried forward.'
              : mark === 'running'
                ? 'A test is in flight. Previous marks stay visible until new evidence replaces them — nothing turns green optimistically.'
                : 'The target answered, but not with what was asked for. Reaching a server is weaker evidence than verifying the response.',
    scopeHeader: 'TEST SCOPE',
    scope: baseScope,
    evidence,
    notProve,
    next:
      failed && diagnosis
        ? {
            header: 'LIKELY CAUSE',
            body: diagnosis.summary + (diagnosis.nextAction ? ` ${diagnosis.nextAction}` : ''),
            ctas: [
              ...(diagnosis.culpritResource ? [{ text: 'Open the culprit', primary: true, action: 'open-resource' as InspectorAction, ref: diagnosis.culpritResource }] : []),
              ...(diagnosis.command ? [{ text: 'Copy the command', action: 'copy-command' as InspectorAction, command: diagnosis.command }] : []),
            ],
          }
        : gapNext(ctx.origins, origin),
  }
}

/** Builds the inspector for the current selection, defaulting to the entry edge -
 *  the segment that answers "did the request get in at all". */
export function buildInspector(sel: Selection, ctx: Ctx): Inspector {
  if (sel?.startsWith('origin:')) {
    const o = ctx.origins.find((x) => `origin:${x.id}` === sel)
    if (o) return originInspector(o, ctx)
  }
  if (sel?.startsWith('n:')) {
    const n = ctx.nodes.find((x) => x.id === sel)
    if (n) return nodeInspector(n, ctx)
  }
  const edge = (sel?.startsWith('e:') ? ctx.edges.find((x) => x.id === sel) : undefined) ?? ctx.edges[0]
  if (edge) return edgeInspector(edge, ctx)
  return originInspector(ctx.origin, ctx)
}

/** The headline verdict band. Derived from the selected scenario, never from an
 *  aggregate that could hide a failing route behind passing siblings. */
const VERDICT_TONE: Record<string, SevTone> = { healthy: 'healthy', degraded: 'degraded', broken: 'unhealthy', unknown: 'unknown' }

export function buildVerdict(
  trace: Trace,
  route: RouteResult | undefined,
  origins: Origin[],
  opts: { stale?: boolean; running?: boolean } = {},
): { tone: SevTone; chipText: string; title: string; problem?: string; body: string; facts: { k: string; v: string }[] } {
  const used = origins.filter((o) => !['untested', 'blocked', 'denied'].includes(o.mark))
  // The headline gap names what can still be DONE. Naming the permanently
  // unavailable real-caller test here made every resource carry the same
  // un-actionable line; that ceiling belongs in the inspector's caveats.
  const actionable = actionableGap(origins)
  const denied = origins.find((o) => o.mark === 'denied')
  // With no route there is nothing to derive a tone from, but the backend has
  // still reached a verdict (e.g. a config fault found without probing). Falling
  // through to 'unknown' showed a grey dot on a resource the tracer called
  // degraded.
  const tone: SevTone = opts.running ? 'info' : route ? routeTone(route, opts) : VERDICT_TONE[trace.verdict] ?? 'unknown'
  const mark = route ? routeMark(route, opts) : 'untested'
  const facts = [
    { k: 'origins:', v: used.length > 0 ? used.map((o) => o.name).join(' · ') : 'none used yet' },
    { k: 'proven to:', v: mark === 'proved' ? route?.target || 'the backend' : mark === 'proxied' ? 'a serving process exists' : 'nothing' },
    { k: 'first failure:', v: mark === 'failed' ? trace.diagnosis?.summary || route?.target || 'the backend' : 'none' },
    {
      k: 'next:',
      v: actionable ? `test from ${actionable.name}` : denied ? 'blocked by RBAC — grant or delegate' : 'nothing stronger Radar can run',
    },
  ]
  return {
    tone,
    chipText: opts.running ? 'testing' : route ? routeChip(route, opts) : 'not tested',
    title: trace.headline || route?.route || `Reachability · ${trace.subject.name}`,
    // The diagnosis is a named fault with a culprit and a next action - it
    // answers "why not", where the headline only says how much was tested. It
    // is called out rather than rendered as body prose, which made the more
    // important fact read as an explanation of the less important one.
    problem: trace.diagnosis?.summary,
    body: trace.diagnosis ? '' : trace.reason || 'Select an origin, or any connection in the graph, to read what was actually tested.',
    facts,
  }
}
