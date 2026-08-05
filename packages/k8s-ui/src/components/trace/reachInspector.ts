import type { Trace, RouteResult, ResourceRef } from './types'
import type { Mark, SevTone } from './reachMarks'
import { routeMark, routeChip, routeTone, routeAsSeenFrom, routeForOrigin } from './reachMarks'
import type { Origin, OriginId } from './reachOrigins'
import { strongestGap, actionableGap } from './reachOrigins'
import { originProducedEvidence, type GraphNode } from './reachGraphModel'

// 'run-probes' re-runs the reachability probes. It is deliberately NOT
// 'refresh': the panel that offers it promises fresh evidence, and a static
// refetch collects none.
export type InspectorAction = 'run-in-cluster' | 'run-probes' | 'open-resource' | 'copy-command'

export interface InspectorCTA {
  text: string
  primary?: boolean
  action?: InspectorAction
  ref?: ResourceRef
  command?: string
  /** Set when the CTA describes something Radar cannot do - rendered inert. */
  disabledReason?: string
}

/** Only nodes are selectable now. Edges carry no segment-local evidence, so
 *  clicking one could only ever repeat the path result - see `Sidebar`. */
export type Selection = string | undefined

/**
 * What the sidebar shows.
 *
 * `path` is ALWAYS present: whether traffic got through, from where, with what
 * caveats, and what to do next. That question must never require a click - it
 * is the reason the tab exists. `resource` is ADDITIVE, appearing when a node
 * is selected, and never replaces the diagnosis.
 */
export interface Sidebar {
  path: {
    chipTone: SevTone
    chipText: string
    title: string
    /** The concrete path under test. Always visible: it was inside the collapsed
     *  details, so the panel described a result without ever naming what was
     *  requested. */
    request?: string
    body: string
    scope: { k: string; v: string }[]
    evidence: { mark: Mark; text: string }[]
    notProve: string[]
    next: { header: string; body: string; blocked?: string; ctas: InspectorCTA[] }
  }
  resource?: {
    kind: string
    name: string
    chipTone: SevTone
    chipText: string
    body: string
    facts: { k: string; v: string }[]
    rows?: { mark: Mark; name: string; detail: string }[]
    moreRows?: number
    anomalies?: { mark: Mark; text: string }[]
    notProve: string[]
    openRef?: ResourceRef
  }
}

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
    { k: 'TESTED FROM', v: o.name },
    { k: 'RUNS IN', v: runsIn[o.id] },
    { k: 'IDENTITY', v: o.identity },
    { k: 'MECHANISM', v: o.mech },
  ]
}

/**
 * The next-step prompt, driven by the strongest gap Radar can CLOSE. The
 * unreachable ceiling is stated underneath as a caveat instead of being offered
 * as an action - a button that can never be pressed is not a next step.
 */
function gapNext(origins: Origin[], current: Origin, namespace?: string, multiPath?: boolean): Sidebar['path']['next'] {
  const actionable = actionableGap(origins)
  const ceiling = strongestGap(origins)
  const ceilingNote = ceiling?.unsupported ? `Even then, ${ceiling.name.toLowerCase()} stays untested — ${ceiling.unavailable}` : undefined
  const denied = origins.find((o) => o.mark === 'denied')
  // A run is never scoped to the selected path - the server tests every declared
  // path in one pass. Saying so here stops the picker above from reading as a
  // filter on what the button will do.
  const allPaths = multiPath ? ' The test covers every path on this resource, not only this one.' : ''

  if (!actionable && denied) {
    const ns = namespace || '<namespace>'
    return {
      header: 'ASK FOR THIS PERMISSION',
      body: `Running an in-cluster test needs \`create\` on \`jobs\` in ${ns}. Grant it, or run the check from a workload you already control.`,
      blocked: denied.unavailable,
      ctas: [{ text: 'Copy the permission check', action: 'copy-command', command: `kubectl auth can-i create jobs -n ${ns}` }],
    }
  }
  if (actionable && actionable.id === current.id) {
    // You are looking at the vantage that is itself the gap.
    return {
      header: 'RUN THIS NEXT',
      body: `Nothing has been tested from ${actionable.name} yet, and it is the strongest evidence Radar can still collect.${allPaths}`,
      blocked: ceilingNote,
      ctas:
        actionable.id === 'incluster'
          ? [{ text: '⚗ Run in-cluster test', primary: true, action: 'run-in-cluster' }]
          : [{ text: '⟳ Re-run', action: 'run-probes' }],
    }
  }
  if (!actionable) {
    return {
      header: 'NO STRONGER TEST AVAILABLE',
      // actionableGap stops at anything weaker than an already-proven origin, so
      // weaker vantages CAN remain unused - claiming everything had been tried
      // was false and discouraged useful comparison checks.
      body: `Radar already has the strongest evidence it can collect for this path. Weaker vantages stay available as comparison checks.${allPaths}`,
      blocked: ceilingNote,
      ctas: [{ text: '⟳ Re-run', action: 'run-probes' }],
    }
  }
  return {
    header: 'RUN THIS NEXT',
    body: `${actionable.name} has not been used for this path, and is the strongest evidence Radar can still collect.${allPaths}`,
    blocked: ceilingNote,
    ctas:
      actionable.id === 'incluster'
        ? [{ text: '⚗ Run in-cluster test', primary: true, action: 'run-in-cluster' }]
        : [{ text: '⟳ Re-run', action: 'run-probes' }],
  }
}

interface Ctx {
  trace: Trace
  route?: RouteResult
  origin: Origin
  origins: Origin[]
  nodes: GraphNode[]
  stale?: boolean
  running?: boolean
  /** More than one scenario is on screen, so scope has to be stated explicitly. */
  multiPath?: boolean
  /** The HTTP path the run requests, as chosen in "what to test". */
  httpPath?: string
}

/** The persistent diagnosis: did traffic get through, from where, and what next. */
function pathSection(ctx: Ctx): Sidebar['path'] {
  const { trace, route, origin, origins } = ctx
  // The route outcome is merged across origins. Without this gate the panel
  // rendered another vantage's success under the selected vantage's name - a
  // permanently unavailable origin could read "a real request went through"
  // while the graph beside it said "not routable". Same lie the graph already
  // guards against, in the surface users actually read.
  // This origin's OWN result when the producer sent one; the coarse
  // "did this origin produce anything" gate only remains as the fallback.
  const own = routeForOrigin(route, origin.id)
  const asSeen = routeAsSeenFrom(route, origin.id)
  const hasEvidence = own !== undefined || originProducedEvidence(origin)
  const mark: Mark = hasEvidence ? (asSeen ? routeMark(asSeen, { stale: ctx.stale, running: ctx.running }) : 'untested') : origin.mark

  const notProve: string[] = []
  if (origin.kind === 'synthetic') notProve.push(SYNTHETIC_IDENTITY)
  if (origin.kind === 'relayed') notProve.push(NOT_DATAPLANE)
  const hasFrontDoor = (trace.upstreams ?? []).length > 0
  const external = origins.find((o) => o.id === 'external')
  if (hasFrontDoor && external?.unsupported && origin.id !== 'external') {
    notProve.push('That people on the internet can reach it — no request has come in from outside.')
  }

  const evidence: { mark: Mark; text: string }[] = []
  const seen = new Set<string>()
  const add = (m: Mark, text: string) => {
    const key = text.trim().toLowerCase()
    if (!key || seen.has(key)) return
    seen.add(key)
    evidence.push({ mark: m, text })
  }
  if (hasEvidence && asSeen?.evidence) add(mark, asSeen.evidence)
  for (const f of hasEvidence ? route?.localization ?? [] : []) {
    const layer = f.layer.toUpperCase()
    const detail = f.detail?.trim()
    const body = !detail ? layer : detail.toUpperCase().startsWith(layer) ? detail : `${layer} · ${detail}`
    add(f.ok ? 'proxied' : 'failed', `${body} — checked directly, past the entry point`)
  }
  if (evidence.length === 0) {
    add(
      mark,
      origin.unsupported
        ? 'Radar cannot test from here, so nothing has been learned this way'
        : origin.mark === 'denied'
          ? 'not permitted to run this test'
          : 'no test has been run from here',
    )
  }

  const failed = mark === 'failed'
  const diagnosis = trace.diagnosis
  const body = !hasEvidence
    ? origin.unavailable || 'Nothing has been tested from here, so this says nothing about whether traffic gets through.'
    : failed
    ? 'This is the first confirmed failure. Everything after it was never tried, so there is nothing to report past this point.'
    : mark === 'proved'
      ? 'A real request went through and the target answered.'
      : mark === 'proxied'
        ? 'Kubernetes relayed a request and the target answered — which shows something is serving, not that the normal path works.'
        : mark === 'untested'
          ? 'Nothing has been tried from here yet. Configuration may look right, but that is intent, not proof.'
          : mark === 'stale'
            ? 'This result predates a change to the cluster, so it is set aside rather than trusted.'
            : mark === 'running'
              ? 'A test is running. Earlier results stay until new ones replace them.'
              : 'The target answered, but not with what was asked for.'

  return {
    chipTone: asSeen ? routeTone(asSeen, { stale: ctx.stale, running: ctx.running }) : 'unknown',
    chipText: asSeen ? routeChip(asSeen, { stale: ctx.stale, running: ctx.running }) : 'not tested',
    title: `${origin.name} → ${route?.target || trace.subject.name}`,
    request: route ? `${route.route}${ctx.httpPath && ctx.httpPath !== '/' ? ` · HTTP path ${ctx.httpPath}` : ''}` : undefined,
    body,
    scope: [...originScope(origin, trace), ...(route ? [{ k: 'PATH', v: route.route }] : [])],
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
        : gapNext(origins, origin, trace.subject.namespace, ctx.multiPath),
  }
}

/** The additive detail for a selected node. Never replaces the diagnosis. */
function resourceSection(node: GraphNode): Sidebar['resource'] {
  const hop = node.hop
  const findings = hop?.findings ?? []

  if (node.podRows) {
    const roster = hop?.config?.pods ?? []
    const total = hop?.config?.podTotal ?? roster.length
    const ready = typeof hop?.meta?.ready === 'number' ? (hop.meta.ready as number) : roster.filter((p) => p.ready).length
    const selected = typeof hop?.meta?.selected === 'number' ? (hop.meta.selected as number) : total
    const publishNotReady = !!hop?.meta?.publishNotReadyAddresses
    const notReady = publishNotReady ? [] : roster.filter((p) => !p.ready)
    const omitted = total - roster.length
    const notProve: string[] = []
    if (omitted > 0) notProve.push(`The ${omitted} Pods that were not tested. Untested is not proven.`)
    if (notReady.length > 0) notProve.push(`The ${notReady.length} not-ready Pod${notReady.length > 1 ? 's' : ''} — nothing was sent to them, so nothing was learned.`)
    return {
      kind: 'PODS',
      name: `${ready} of ${selected} eligible`,
      chipTone: node.tone,
      chipText: 'backends',
      body: publishNotReady
        ? 'The Pods behind this Service. This Service is set to send traffic to Pods even before they report ready.'
        : 'The Pods behind this Service. Kubernetes only sends traffic to the ones that report ready.',
      facts: [
        { k: 'MATCHING PODS', v: `${selected}` },
        // Derived from readiness, NOT from observed delivery - "taking traffic"
        // claimed evidence we do not have.
        { k: 'ELIGIBLE', v: `${ready}` },
        {
          k: 'SITTING OUT',
          v: publishNotReady ? 'none — not-ready Pods get traffic too' : notReady.length > 0 ? `${notReady.length} not ready` : 'none',
        },
      ],
      rows: node.podRows,
      moreRows: node.moreRows,
      anomalies: node.anomalies,
      notProve,
    }
  }

  const c = hop?.config
  const facts: { k: string; v: string }[] = []
  if (c?.clusterIP) facts.push({ k: 'CLUSTER IP', v: c.clusterIP })
  if (c?.serviceType) facts.push({ k: 'TYPE', v: c.serviceType })
  if (c?.ports?.length) facts.push({ k: 'PORTS', v: c.ports.map((x) => `${x.port}→${x.targetPort ?? x.port}`).join(', ') })
  if (c?.addresses?.length) facts.push({ k: 'ADDRESS', v: c.addresses.join(', ') })
  if (c?.hostnames?.length) facts.push({ k: 'HOSTS', v: c.hostnames.join(', ') })
  if (c?.selector) facts.push({ k: 'SELECTOR', v: Object.entries(c.selector).map(([k, v]) => `${k}=${v}`).join(', ') })
  if (node.ref?.namespace) facts.push({ k: 'NAMESPACE', v: node.ref.namespace })

  return {
    kind: node.kind,
    name: node.name,
    chipTone: node.tone,
    chipText: node.dim ? 'not on this path' : '',
    body: node.dim
      ? 'This entry point is attached to the resource but does not serve the host being tested.'
      : findings.length > 0
        ? findings[0].cause || findings[0].message
        : 'Configuration and health of this resource.',
    facts,
    notProve: [],
    openRef: node.ref,
  }
}

/**
 * Builds the sidebar. The diagnosis is always computed; a node selection only
 * appends to it.
 */
export function buildSidebar(sel: Selection, ctx: Ctx): Sidebar {
  const path = pathSection(ctx)
  const node = sel ? ctx.nodes.find((n) => n.id === sel && !n.isOrigin) : undefined
  return { path, resource: node ? resourceSection(node) : undefined }
}

/** The headline verdict band. Derived from the selected scenario, never from an
 *  aggregate that could hide a failing route behind passing siblings. */
const VERDICT_TONE: Record<string, SevTone> = { healthy: 'healthy', degraded: 'degraded', broken: 'unhealthy', unknown: 'unknown' }

export function buildVerdict(
  trace: Trace,
  route: RouteResult | undefined,
  origins: Origin[],
  opts: { stale?: boolean; running?: boolean; pathLabel?: string } = {},
): {
  tone: SevTone
  chipText: string
  /** Set when the resource has more than one path, so the reader can tell the
   *  route-scoped badge apart from the resource-wide headline beside it. */
  chipScope?: string
  scopeLabel?: string
  title: string
  problem?: string
  body: string
  facts: { k: string; v: string }[]
} {
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
    // Title, problem and coverage describe the WHOLE resource; tone and chip
    // follow the selected path. With several paths on screen that difference is
    // invisible unless each side says which scope it speaks for.
    chipScope: opts.pathLabel,
    scopeLabel: opts.pathLabel ? 'THIS RESOURCE' : undefined,
    // A stale screen previously led with the old headline ("Reachable...") and
    // then said underneath that the result was excluded. That is a contradiction,
    // not an exclusion.
    title: opts.stale
      ? 'This result is out of date — re-test'
      : trace.headline || route?.route || `Reachability · ${trace.subject.name}`,
    // The diagnosis is a named fault with a culprit and a next action - it
    // answers "why not", where the headline only says how much was tested. It
    // is called out rather than rendered as body prose, which made the more
    // important fact read as an explanation of the less important one.
    problem: trace.diagnosis?.summary,
    body: trace.diagnosis ? '' : trace.reason || '',
    facts,
  }
}
