import { useMemo, useState } from 'react'
import type { Trace, RouteResult, ResourceRef } from './types'
import { ReachActions, JustTestedNote, CopyableCommand, type TracePanelProps } from './TracePanel'
import { AlertBanner } from '../ui/drawer-components'
import { ReachabilityGraph, TinyTag, MarkGlyph } from './ReachabilityGraph'
import { Tooltip } from '../ui/Tooltip'
import { buildGraph, originProducedEvidence } from './reachGraphModel'
import { buildOrigins, defaultOrigin, type Origin, type OriginId } from './reachOrigins'
import { buildSidebar, buildVerdict, type Sidebar, type InspectorCTA, type Selection } from './reachInspector'
import { markStyle, glyphStyle, markHelp, scenariosFor, routeTone, routeChip, SEV_COLOR, SEV_BADGE, type Scenario } from './reachMarks'
import { DEV_STATES, devTrace, type DevState } from './reachFixtures'

export { podReach, podProbeKey } from './podReach'

/**
 * ReachabilityView — the Reachability tab body.
 *
 * The organising idea is that a reachability result is meaningless without its
 * vantage. So the view is built around two selections the operator makes
 * explicitly: WHICH scenario (a port, a route, a front door) and FROM WHICH
 * ORIGIN. Everything else — the graph, the verdict, the inspector — is a
 * function of that pair, and changing the origin genuinely re-routes the graph
 * rather than relabelling it.
 *
 * Node dots carry resource health; edges carry path truth. Those are never
 * merged: a healthy resource behind a failed hop stays healthy and the hop
 * stays red.
 */
export function ReachabilityView(props: TracePanelProps) {
  const {
    trace: liveTrace,
    isLoading,
    error,
    inClusterError,
    inClusterPartial,
    inClusterFallback,
    inClusterEvidenceOnly,
    inClusterEvidenceNote,
    probeError,
    onRunProbes,
    onRefresh,
    clusterChangedSinceTest,
  } = props

  // Dev-only: drive the view from fixtures so the empty / failing / sampled /
  // denied states are reachable without a cluster shaped like each one.
  const devEnabled = !!import.meta.env?.DEV
  const [devState, setDevState] = useState<DevState | null>(null)
  const trace = devState ? devTrace(devState) : liveTrace
  const running = devState === 'running' || !!props.inClusterRunning
  const stale = devState === 'stale' || !!clusterChangedSinceTest
  const inClusterAllowed = devState === 'rbac' ? false : props.inClusterAllowed

  if (isLoading && !trace) {
    return <div className="p-4 text-sm text-theme-text-tertiary">Loading reachability…</div>
  }
  if (error && !trace) {
    return (
      <div className="p-1">
        <AlertBanner variant="error" title="Couldn’t load reachability" message={error.message}>
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              className="mt-2 rounded border border-theme-border bg-theme-surface px-2 py-1 text-xs text-theme-text-primary transition-colors hover:bg-theme-hover"
            >
              Retry
            </button>
          )}
        </AlertBanner>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {devEnabled && <DevStateBar state={devState} onPick={setDevState} />}

      {probeError && (
        <AlertBanner variant="error" title="Reachability test failed" message={probeError.message}>
          {onRunProbes && (
            <button
              type="button"
              onClick={onRunProbes}
              className="mt-2 rounded border border-theme-border bg-theme-surface px-2 py-1 text-xs text-theme-text-primary transition-colors hover:bg-theme-hover"
            >
              Try again
            </button>
          )}
        </AlertBanner>
      )}
      {/* "Couldn't run" is only honest when NOTHING ran. A run whose trailing
          routes hit the pod cap / time budget still folded results into the
          merged trace - title that "partially completed", or the banner lies
          over live results. */}
      {inClusterError && (
        <AlertBanner
          variant="warning"
          title={inClusterPartial ? 'In-cluster test partially completed' : "In-cluster test couldn't run"}
          message={inClusterError}
        >
          {inClusterFallback && (
            <div className="mt-2">
              <CopyableCommand command={inClusterFallback} />
            </div>
          )}
        </AlertBanner>
      )}
      {!inClusterError && inClusterEvidenceOnly && (
        <AlertBanner
          variant="info"
          title="In-cluster test ran as evidence only - route outcomes unchanged"
          message={inClusterEvidenceNote || 'The in-cluster probe produced evidence but nothing that changes a declared route outcome.'}
        >
          {inClusterFallback && (
            <div className="mt-2">
              <CopyableCommand command={inClusterFallback} />
            </div>
          )}
        </AlertBanner>
      )}

      {trace ? (
        <ReachabilityBoard {...props} trace={trace} running={running} stale={stale} inClusterAllowed={inClusterAllowed} />
      ) : (
        <div className="p-4 text-sm text-theme-text-tertiary">No reachability data.</div>
      )}
    </div>
  )
}

interface BoardProps extends TracePanelProps {
  trace: Trace
  running: boolean
  stale: boolean
}

function ReachabilityBoard(props: BoardProps) {
  const { trace, running, stale, onNavigateToResource, onRunInCluster, onRunProbes, inClusterAllowed, testedAt, runNonce } = props

  // Scenarios group routes that agree in every respect - a Gateway route with
  // three hostnames and one backend is one situation, not three.
  const scenarios = useMemo(() => scenariosFor(trace.routes ?? [], trace.notTested ?? [], trace.upstreams ?? []), [trace])
  // Keyed by identity, never by position: the strip is sorted worst-first, so a
  // re-run that changes an outcome re-sorts it and a stored index would silently
  // move the user to a different path.
  const [scenarioKey, setScenarioKey] = useState<string | null>(null)
  const scenario = scenarios.find((s) => s.key === scenarioKey) ?? scenarios[0]
  const route: RouteResult | undefined = scenario?.primary

  const origins = useMemo(
    () => buildOrigins(trace, { inClusterAllowed, inClusterRunning: running, stale, route }),
    [trace, inClusterAllowed, running, stale, route],
  )
  const [originId, setOriginId] = useState<OriginId | null>(null)
  const origin = origins.find((o) => o.id === (originId ?? defaultOrigin(origins))) ?? origins[0]

  const [selection, setSelection] = useState<Selection>(undefined)

  const model = useMemo(() => buildGraph({ trace, route, origin, stale, running }), [trace, route, origin, stale, running])
  const multiPath = scenarios.length > 1
  const sidebar = useMemo(
    () => buildSidebar(selection, { trace, route, origin, origins, nodes: model.nodes, stale, running, multiPath, httpPath: props.probePath }),
    [selection, trace, route, origin, origins, model, stale, running, multiPath, props.probePath],
  )
  const verdict = useMemo(
    () => buildVerdict(trace, route, origins, { stale, running, originId: origin?.id, originName: origin?.name, pathLabel: multiPath ? scenario?.primary.target || scenario?.label : undefined }),
    [trace, route, origins, stale, running, multiPath, scenario, origin],
  )

  const onCTA = (cta: InspectorCTA) => {
    if (cta.disabledReason) return
    if (cta.action === 'run-in-cluster') onRunInCluster?.()
    // onRefresh refetches the STATIC trace and collects no evidence - wrong for a
    // CTA whose own copy offers to go and test something.
    else if (cta.action === 'run-probes') onRunProbes?.()
    else if (cta.action === 'open-resource' && cta.ref) onNavigateToResource?.(cta.ref)
    else if (cta.action === 'copy-command' && cta.command) void navigator.clipboard?.writeText(cta.command)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-theme-border bg-theme-surface">
      {/* Only worth choosing between when the paths actually disagree. With one
          distinct outcome the verdict already speaks for the whole resource, and
          a one-tab picker would just be a step before reading anything. */}
      {scenarios.length > 1 && (
        <ScenarioStrip scenarios={scenarios} activeKey={scenario?.key} onPick={(k) => { setScenarioKey(k); setSelection(undefined) }} stale={stale} running={running} />
      )}

      <VerdictBand verdict={verdict} runNonce={runNonce} actions={<ReachActions {...props} inClusterTested={origins.some((o) => o.id === 'incluster' && o.mark !== 'untested')} />} />

      {/* Three columns once there is room for them. The graph is the navigation
          surface and the inspector the reading surface, so keeping them side by
          side preserves the click-an-edge-then-read loop; below xl the inspector
          wraps to its own full-width row rather than being clipped. */}
      {/* The board fills the pane. Each column scrolls on its own so a long
          origin list or inspector never pushes the graph out of view. */}
      {/* Always three columns. Below xl the inspector used to wrap onto its own
          full-width row UNDER the graph, which split one diagnosis into two
          stacked, separately-scrolling regions and left neither enough room.
          Narrow widths tighten the two rails instead - they are a picker and a
          reading column, and both compress better than the path does. */}
      <div className="grid min-h-0 flex-1 items-stretch grid-cols-[minmax(168px,186px)_minmax(0,1fr)_minmax(248px,278px)] xl:grid-cols-[minmax(196px,210px)_minmax(0,1fr)_minmax(290px,21%)]">
        {/* Picking a vantage re-routes the graph and returns the inspector to
            the PATH result from there. It used to select the origin itself,
            which answered "define this vantage" when the user asked "show me
            the result from it" - and, for an unusable vantage, replaced a
            working graph with a blocked one. The origin's own detail is still
            one click away on its capsule in the graph. */}
        <div className="min-h-0 overflow-y-auto border-r border-theme-border [scrollbar-gutter:stable]">
          <OriginRail origins={origins} active={origin?.id} onPick={(id) => { setOriginId(id); setSelection(undefined) }} />
        </div>
        <div className="min-h-0 min-w-0">
          <ReachabilityGraph model={model} selected={selection} onSelect={setSelection} />
        </div>
        <div className="min-h-0 overflow-y-auto [scrollbar-gutter:stable]">
          <InspectorPanel sidebar={sidebar} onCTA={onCTA} onOpen={(r) => onNavigateToResource?.(r)} />
        </div>
      </div>

      <CoverageFooter trace={trace} testedAt={testedAt} stale={stale} />
    </div>
  )
}

// ---------------------------------------------------------------- scenarios

/** The hostnames folded into one tab. Only a hover when there is more than one -
 *  a single host is already the tab's own label. */
function TabTooltip({ hosts, children }: { hosts: string[]; children: React.ReactNode }) {
  if (hosts.length < 2) return <>{children}</>
  return (
    <Tooltip
      content={
        <span className="flex flex-col gap-0.5">
          <span className="font-semibold">Same result on {hosts.length} hostnames</span>
          {hosts.map((h) => (
            <span key={h} className="font-mono">
              {h}
            </span>
          ))}
        </span>
      }
      wrapperClassName="flex-none cursor-help"
    >
      {children}
    </Tooltip>
  )
}

function ScenarioStrip({
  scenarios,
  activeKey,
  onPick,
  stale,
  running,
}: {
  scenarios: Scenario[]
  activeKey?: string
  onPick: (key: string) => void
  stale: boolean
  running: boolean
}) {
  return (
    <div className="flex items-stretch border-b border-theme-border bg-theme-elevated">
      <div className="flex flex-none items-center py-2 pl-4.5 pr-3 text-[9.5px] font-bold tracking-[0.07em] text-theme-text-tertiary">PATH</div>
      <div className="flex min-w-0 flex-1 overflow-x-auto">
        {scenarios.map((s) => {
          const tone = routeTone(s.primary, { stale, running })
          const active = s.key === activeKey
          return (
            <TabTooltip hosts={s.hosts} key={s.key}>
            <button
              type="button"
              onClick={() => onPick(s.key)}
              className="flex-none cursor-pointer border-r border-theme-border-subtle px-3.5 py-1.5 text-left"
              style={{
                background: active ? 'var(--bg-surface)' : 'transparent',
                boxShadow: active ? 'inset 0 -2px 0 var(--accent)' : 'none',
              }}
            >
              <div className="flex items-center gap-1.5">
                <span className="inline-block shrink-0 rounded-full" style={{ width: 8, height: 8, background: SEV_COLOR[tone] }} />
                <span className="max-w-[280px] truncate font-mono text-xs font-semibold text-theme-text-primary">{s.label}</span>
                <span className={`badge-sm shrink-0 whitespace-nowrap ${SEV_BADGE[tone]}`}>{routeChip(s.primary, { stale, running })}</span>
              </div>
              {s.sub && <div className="mt-0.5 truncate text-[10.5px] text-theme-text-tertiary">{s.sub}</div>}
            </button>
            </TabTooltip>
          )
        })}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ verdict

function VerdictBand({
  verdict,
  actions,
  runNonce,
}: {
  verdict: ReturnType<typeof buildVerdict>
  actions: React.ReactNode
  runNonce?: number
}) {
  const c = SEV_COLOR[verdict.tone]
  return (
    <div className="flex items-start gap-3 border-b border-theme-border px-5 py-3">
      <span
        className="mt-1 shrink-0 rounded-full"
        style={{ width: 12, height: 12, background: c, boxShadow: `0 0 0 4px color-mix(in srgb, ${c} 15%, transparent)` }}
      />
      <div className="min-w-0 flex-1">
        {/* The headline covers the whole resource while the badge follows the
            selected path. Unlabelled, the two read as one claim. */}
        {verdict.scopeLabel && (
          <div className="mb-0.5 text-[9.5px] font-bold tracking-[0.07em] text-theme-text-tertiary">{verdict.scopeLabel}</div>
        )}
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-[14.5px] font-semibold text-theme-text-primary">{verdict.title}</span>
          <span className={`badge-sm whitespace-nowrap ${SEV_BADGE[verdict.tone]}`}>{verdict.chipText}</span>
          {verdict.chipScope && (
            <span className="truncate font-mono text-[10.5px] text-theme-text-tertiary">{verdict.chipScope}</span>
          )}
          <JustTestedNote nonce={runNonce} />
        </div>
        {verdict.problem && (
          <div
            className="mt-1.5 flex max-w-[92ch] items-start gap-1.5 rounded-md px-2 py-1.5 text-xs leading-relaxed text-pretty"
            style={{ border: '1px solid var(--color-warning)', background: 'color-mix(in srgb, var(--color-warning) 10%, transparent)' }}
          >
            <span className="shrink-0" style={{ color: 'var(--color-warning-dark)' }}>▲</span>
            <span className="text-theme-text-primary">{verdict.problem}</span>
          </div>
        )}
        {verdict.body && <div className="mt-1 max-w-[76ch] text-xs leading-relaxed text-theme-text-secondary text-pretty">{verdict.body}</div>}
        <div className="mt-1.5 flex flex-wrap gap-x-3.5 gap-y-1 text-[11px] text-theme-text-tertiary">
          {verdict.facts.map((f) => (
            <span key={f.k}>
              <b className="font-semibold text-theme-text-secondary">{f.k}</b> {f.v}
            </span>
          ))}
        </div>
      </div>
      <div className="flex flex-none gap-2">{actions}</div>
    </div>
  )
}

// ------------------------------------------------------------------ origins

/** Hover-level decoder for the identity tags, which had none anywhere. */
const KIND_TAG_HELP: Record<string, string> = {
  synthetic: 'Radar’s own test client — not your application, so anything that checks who is calling may answer differently.',
  'real-client': 'A real client, but not your application.',
  'real-caller': 'Your application itself, with its own identity.',
  relayed: 'Not a caller at all — Kubernetes passes the request along on our behalf.',
}

function OriginRail({ origins, active, onPick }: { origins: Origin[]; active?: OriginId; onPick: (id: OriginId) => void }) {
  return (
    <div className="bg-theme-surface py-2.5">
      <div className="px-3 pb-1 text-[9.5px] font-bold tracking-[0.07em] text-theme-text-tertiary">TESTED FROM</div>
      <Tooltip
        content="Each row is a different way to reach this resource. Picking one shows what that test found — and what it cannot tell you."
        wrapperClassName="block cursor-help px-3 pb-2"
      >
        <span className="text-[10.5px] leading-snug text-theme-text-tertiary">Pick one to see what it found.</span>
      </Tooltip>
      {/* Vantages Radar can never run are NOT offered as choices. What they
          would have proven still is - as a statement below - so the coverage
          gap stays visible without spending two of five rows on controls that
          can only ever be clicked to be told "no". */}
      {origins
        .filter((o) => !o.unsupported)
        .map((o) => {
        const sel = o.id === active
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onPick(o.id)}
            className="mx-2 mb-1.5 block w-[calc(100%-16px)] cursor-pointer rounded-[20px] px-2.5 py-2 text-left"
            style={{
              border: `1px ${sel ? 'solid var(--accent)' : 'dashed var(--border-default)'}`,
              background: sel ? 'var(--selection-bg)' : 'var(--bg-base)',
              opacity: o.unsupported ? 0.72 : 1,
            }}
          >
            <div className="flex items-center gap-1.5">
              <span className="flex-none text-xs" style={{ color: sel ? 'var(--accent-text)' : 'var(--text-tertiary)' }}>
                {o.glyph}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-theme-text-primary">{o.name}</span>
              <MarkGlyph mark={o.mark} />
            </div>
            {/* Deliberately terse. The mechanism, identity and the reason an
                origin is unusable all render in the inspector the moment it is
                selected - repeating them here made the rail taller than the
                graph and pushed the path off the pane. */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <TinyTag
                text={o.kindTag}
                tone={o.kind === 'synthetic' ? 'var(--color-warning-dark)' : o.kind === 'relayed' ? 'var(--color-info)' : 'var(--color-success-dark)'}
                title={KIND_TAG_HELP[o.kind]}
              />
              <TinyTag
                text={o.lane === 'dataplane' ? 'CLUSTER NETWORK' : 'NOT THE CLUSTER NETWORK'}
                tone={o.lane === 'dataplane' ? 'var(--accent-text)' : 'var(--color-info)'}
                title={
                  o.lane === 'dataplane'
                    ? 'Runs from a Pod in the cluster, so the request goes through the cluster’s routing, network policy and mesh. It dials the backend directly, so it cannot show whether the front door works.'
                    : 'Does not traverse kube-proxy, NetworkPolicy or the mesh. A dial from your machine uses your own network; a relayed request is carried by the Kubernetes control plane, which reaches the target from inside but not over the path real traffic takes.'
                }
              />
              {/* An origin that already produced evidence is not "unavailable" -
                  it just can't be run again. Showing both at once had the rail
                  denying a result the graph beside it was displaying. */}
              {o.unavailable && (
                <Tooltip content={o.unavailable} wrapperClassName="cursor-help">
                  <span className="text-[9px] text-theme-text-tertiary">
                    {originProducedEvidence(o) ? '⊘ can’t run again' : '⊘ unavailable'}
                  </span>
                </Tooltip>
              )}
            </div>
          </button>
        )
      })}
      <UntestableNote origins={origins} />
    </div>
  )
}

/** The vantages Radar cannot run, stated rather than offered. These are the
 *  biggest holes in the evidence, so they must stay on screen - but as a limit
 *  on the claim, not as buttons that refuse. */
function UntestableNote({ origins }: { origins: Origin[] }) {
  const out = origins.filter((o) => o.unsupported)
  if (out.length === 0) return null
  return (
    <div className="mx-2 mt-2 border-t border-theme-border pt-2">
      <div className="text-[9.5px] font-bold tracking-[0.07em] text-theme-text-tertiary">NEVER TESTED</div>
      {out.map((o) => (
        <Tooltip key={o.id} content={o.unavailable ?? ''} wrapperClassName="mt-1 block cursor-help">
          <span className="text-[10px] leading-snug text-theme-text-tertiary">
            {o.glyph} {o.name}
          </span>
        </Tooltip>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- inspector

function Caveats({ items }: { items: string[] }) {
  if (items.length === 0) return null
  // Quieter than a fault: these are limits on the claim, not problems with the
  // cluster. Giving them the same amber box trained people to skip amber boxes.
  return (
    <div className="border-l-2 border-theme-border pl-2.5">
      <div className="text-[9.5px] font-bold tracking-[0.07em] text-theme-text-tertiary">WHAT THIS DOESN’T PROVE</div>
      {items.map((n, i) => (
        <div key={i} className="mt-1 text-[10.5px] leading-snug text-theme-text-tertiary">
          {n}
        </div>
      ))}
    </div>
  )
}

function InspectorPanel({ sidebar, onCTA, onOpen }: { sidebar: Sidebar; onCTA: (c: InspectorCTA) => void; onOpen: (r: ResourceRef) => void }) {
  const [scopeOpen, setScopeOpen] = useState(false)
  const { path, resource } = sidebar
  return (
    <div className="flex h-full flex-col gap-3 bg-theme-surface px-3.5 py-3 border-l border-theme-border">
      {/* The diagnosis is ALWAYS here. Whether traffic got through must never
          require a click - it is the question the tab exists to answer. */}
      <div>
        <div className="flex items-center gap-2">
          <span className="text-[9.5px] font-bold tracking-[0.07em] text-theme-text-tertiary">THIS PATH</span>
          <div className="flex-1" />
          <span className={`badge-sm whitespace-nowrap ${SEV_BADGE[path.chipTone]}`}>{path.chipText}</span>
        </div>
        <div className="mt-1.5 font-mono text-[12.5px] font-semibold leading-snug text-theme-text-primary">{path.title}</div>
        {path.request && (
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="flex-none text-[9px] font-bold tracking-[0.04em] text-theme-text-tertiary">ASKED FOR</span>
            <span className="min-w-0 flex-1 break-words font-mono text-[10.5px] text-theme-text-secondary">{path.request}</span>
          </div>
        )}
        <div className="mt-1 text-[11.5px] leading-relaxed text-theme-text-secondary text-pretty">{path.body}</div>
      </div>

      {path.scope.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setScopeOpen((v) => !v)}
            className="flex w-full items-center gap-1.5 text-[9.5px] font-bold tracking-[0.07em] text-theme-text-tertiary hover:text-theme-text-secondary"
          >
            <span>TEST DETAILS</span>
            <span className="flex-1 text-right font-normal tracking-normal">{path.scope.length}</span>
            <span>{scopeOpen ? '⌄' : '›'}</span>
          </button>
          {scopeOpen &&
            path.scope.map((p, i) => (
              <div key={i} className="mt-0.5 flex gap-2 border-b border-theme-border-subtle py-0.5">
                <span className="w-[86px] flex-none pt-0.5 text-[9px] font-bold tracking-[0.04em] text-theme-text-tertiary">{p.k}</span>
                <span className="flex-1 break-words font-mono text-[10px] leading-snug text-theme-text-secondary">{p.v}</span>
              </div>
            ))}
        </div>
      )}

      {path.evidence.length > 0 && (
        <div>
          <div className="mb-1 text-[9.5px] font-bold tracking-[0.07em] text-theme-text-tertiary">WHAT WE SAW</div>
          {path.evidence.map((e, i) => (
            <div key={i} className="mb-1 flex items-baseline gap-1.5">
              <MarkGlyph mark={e.mark} />
              <span className="text-[11px] leading-snug text-theme-text-secondary">{e.text}</span>
            </div>
          ))}
        </div>
      )}

      <Caveats items={path.notProve} />

      <div className="rounded-md px-2.5 py-2.5" style={{ border: '1px solid var(--accent)', background: 'var(--accent-muted)' }}>
        <div className="text-[9.5px] font-bold tracking-[0.05em]" style={{ color: 'var(--accent-text)' }}>
          {path.next.header}
        </div>
        <div className="mt-1 text-[11.5px] leading-snug text-theme-text-secondary text-pretty">{path.next.body}</div>
        {path.next.blocked && <div className="mt-1.5 text-[10.5px] leading-snug text-theme-text-tertiary">{path.next.blocked}</div>}
        {path.next.ctas.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {path.next.ctas.map((c, i) => (
              <Tooltip key={i} content={c.disabledReason ?? ''} wrapperClassName="cursor-help">
              <button
                type="button"
                onClick={() => onCTA(c)}
                disabled={!!c.disabledReason}
                className={
                  c.primary && !c.disabledReason
                    ? 'btn-brand cursor-pointer whitespace-nowrap rounded-md px-2.5 py-1.5 text-[11px] font-semibold'
                    : 'cursor-pointer whitespace-nowrap rounded-md border border-theme-border bg-theme-base px-2.5 py-1.5 text-[11px] font-semibold text-theme-text-secondary disabled:cursor-not-allowed disabled:opacity-60'
                }
              >
                {c.text}
              </button>
              </Tooltip>
            ))}
          </div>
        )}
      </div>

      {/* Additive: a selected node appends its own detail below the diagnosis
          rather than replacing it. */}
      {resource && (
        <div className="border-t border-theme-border pt-3">
          <div className="flex items-center gap-2">
            <span className="text-[9.5px] font-bold tracking-[0.07em] text-theme-text-tertiary">{resource.kind}</span>
            <div className="flex-1" />
            <span className={`badge-sm whitespace-nowrap ${SEV_BADGE[resource.chipTone]}`}>{resource.chipText}</span>
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-semibold text-theme-text-primary">{resource.name}</span>
            {resource.openRef?.name && (
              <button type="button" onClick={() => onOpen(resource.openRef!)} className="shrink-0 text-[11px] text-accent-text hover:underline">
                Open ↗
              </button>
            )}
          </div>
          <div className="mt-1 text-[11.5px] leading-relaxed text-theme-text-secondary text-pretty">{resource.body}</div>
          {resource.facts.map((f, i) => (
            <div key={i} className="mt-0.5 flex gap-2 border-b border-theme-border-subtle py-0.5">
              <span className="w-[86px] flex-none pt-0.5 text-[9px] font-bold tracking-[0.04em] text-theme-text-tertiary">{f.k}</span>
              <span className="flex-1 break-words font-mono text-[10px] leading-snug text-theme-text-secondary">{f.v}</span>
            </div>
          ))}
          {resource.anomalies && resource.anomalies.length > 0 && (
            <div className="mt-2">
              {resource.anomalies.map((a, i) => (
                <div key={i} className="mb-1 flex items-baseline gap-1.5">
                  <span style={glyphStyle(a.mark)}>{markStyle(a.mark).glyph}</span>
                  <span className="text-[10.5px] leading-snug text-theme-text-secondary">{a.text}</span>
                </div>
              ))}
            </div>
          )}
          {resource.rows && resource.rows.length > 0 && (
            <div className="mt-2 flex flex-col gap-0.5">
              {resource.rows.map((r) => (
                <Tooltip
                  key={r.name}
                  content={
                    <>
                      <span className="font-mono font-semibold">{r.name}</span>
                      <span className="text-theme-text-tertiary"> — {r.detail} · {markHelp(r.mark)}</span>
                    </>
                  }
                  wrapperClassName="w-full cursor-help"
                >
                  <div className="flex w-full items-baseline gap-1.5">
                    <span style={glyphStyle(r.mark)}>{markStyle(r.mark).glyph}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-theme-text-secondary">{r.name}</span>
                    <span className="shrink-0 text-[9.5px] text-theme-text-tertiary">{r.detail}</span>
                  </div>
                </Tooltip>
              ))}
              {!!resource.moreRows && <div className="text-[9.5px] text-theme-text-tertiary">+{resource.moreRows} more not shown</div>}
            </div>
          )}
          <div className="mt-2">
            <Caveats items={resource.notProve} />
          </div>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------- footer

function CoverageFooter({ trace, testedAt, stale }: { trace: Trace; testedAt?: Date; stale: boolean }) {
  const c = trace.coverage
  const skips = trace.notTested ?? []
  // Only skips that actually cost coverage belong in the headline count - a
  // benign skip loses nothing and padding the number would overstate the gap.
  const realGaps = skips.filter((s) => s.reasonClass !== 'benign')
  // "skipped N · M not tested" read as one thing counted twice. They are
  // different levels: attempts made, versus paths with no evidence at all.
  const attempts = c && c.tested > 0 ? `${c.passed} got through · ${c.failed} failed${c.skipped ? ` · ${c.skipped} couldn’t be tried` : ''}` : ''
  // Derived breaks were never dialled, so they are counted apart from attempts -
  // folding them in reported requests that failed when none were sent.
  const derived = c?.derived ? `${c.derived} broken without testing` : ''
  const gaps = realGaps.length ? `${realGaps.length} path${realGaps.length === 1 ? '' : 's'} with no evidence` : ''
  const coverageText = c ? [attempts, derived, gaps].filter(Boolean).join('  ·  ') || 'nothing tested yet' : 'nothing tested yet'
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-t border-theme-border bg-theme-surface px-5 py-2 text-[11px] text-theme-text-tertiary">
      <span className="text-[9.5px] font-bold tracking-[0.07em]">WHAT WAS TESTED</span>
      <span className="font-mono text-theme-text-secondary">{coverageText}</span>
      <span className="text-theme-border">|</span>
      <span className="text-[9.5px] font-bold tracking-[0.07em]">WHEN</span>
      <span className="font-mono" style={{ color: stale ? 'var(--color-warning-dark)' : 'var(--text-secondary)' }}>
        {stale
          ? 'cluster state changed since this test — results excluded from the verdict'
          : testedAt
            ? `observed ${testedAt.toLocaleTimeString()}`
            : 'no test has been run'}
      </span>
    </div>
  )
}

// -------------------------------------------------------------------- dev

function DevStateBar({ state, onPick }: { state: DevState | null; onPick: (s: DevState | null) => void }) {
  const chip = (active: boolean) =>
    `cursor-pointer whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
      active ? 'border-accent bg-accent-muted text-accent-text' : 'border-theme-border bg-theme-surface text-theme-text-secondary'
    }`
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] font-bold tracking-[0.08em] text-theme-text-tertiary">DEV STATE</span>
      <button type="button" onClick={() => onPick(null)} className={chip(state === null)}>
        live
      </button>
      {DEV_STATES.map((s) => (
        <button key={s.id} type="button" onClick={() => onPick(s.id)} className={chip(state === s.id)}>
          {s.label}
        </button>
      ))}
    </div>
  )
}
