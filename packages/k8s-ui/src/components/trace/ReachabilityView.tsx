import { useMemo, useState } from 'react'
import type { Trace, RouteResult } from './types'
import { ReachActions, JustTestedNote, CopyableCommand, type TracePanelProps } from './TracePanel'
import { AlertBanner } from '../ui/drawer-components'
import { ReachabilityGraph, TinyTag } from './ReachabilityGraph'
import { buildGraph } from './reachGraphModel'
import { buildOrigins, defaultOrigin, type Origin, type OriginId } from './reachOrigins'
import { buildInspector, buildVerdict, type Inspector, type InspectorCTA, type Selection } from './reachInspector'
import { markStyle, glyphStyle, scenariosFor, routeTone, routeChip, SEV_COLOR, SEV_BADGE, type SevTone, type Scenario } from './reachMarks'
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
  const { trace, running, stale, onNavigateToResource, onRunInCluster, inClusterAllowed, onRefresh, testedAt, runNonce } = props

  // Scenarios group routes that agree in every respect - a Gateway route with
  // three hostnames and one backend is one situation, not three.
  const scenarios = useMemo(() => scenariosFor(trace.routes ?? [], trace.notTested ?? []), [trace])
  // Keyed by identity, never by position: the strip is sorted worst-first, so a
  // re-run that changes an outcome re-sorts it and a stored index would silently
  // move the user to a different path.
  const [scenarioKey, setScenarioKey] = useState<string | null>(null)
  const scenario = scenarios.find((s) => s.key === scenarioKey) ?? scenarios[0]
  const route: RouteResult | undefined = scenario?.primary

  const origins = useMemo(
    () => buildOrigins(trace, { inClusterAllowed, inClusterRunning: running, stale }),
    [trace, inClusterAllowed, running, stale],
  )
  const [originId, setOriginId] = useState<OriginId | null>(null)
  const origin = origins.find((o) => o.id === (originId ?? defaultOrigin(origins))) ?? origins[0]

  const [selection, setSelection] = useState<Selection>(undefined)

  const model = useMemo(() => buildGraph({ trace, route, origin, stale, running }), [trace, route, origin, stale, running])
  const inspector = useMemo(
    () => buildInspector(selection, { trace, route, origin, origins, nodes: model.nodes, edges: model.edges, stale, running }),
    [selection, trace, route, origin, origins, model, stale, running],
  )
  const verdict = useMemo(() => buildVerdict(trace, route, origins, { stale, running }), [trace, route, origins, stale, running])

  const onCTA = (cta: InspectorCTA) => {
    if (cta.disabledReason) return
    if (cta.action === 'run-in-cluster') onRunInCluster?.()
    else if (cta.action === 'refresh') onRefresh?.()
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
      <div className="grid min-h-0 flex-1 items-stretch grid-cols-[minmax(200px,232px)_minmax(0,1fr)] xl:grid-cols-[minmax(232px,258px)_minmax(0,1fr)_minmax(310px,23%)]">
        {/* Picking a vantage re-routes the graph and returns the inspector to
            the PATH result from there. It used to select the origin itself,
            which answered "define this vantage" when the user asked "show me
            the result from it" - and, for an unusable vantage, replaced a
            working graph with a blocked one. The origin's own detail is still
            one click away on its capsule in the graph. */}
        <div className="min-h-0 overflow-y-auto border-r border-theme-border">
          <OriginRail origins={origins} active={origin?.id} onPick={(id) => { setOriginId(id); setSelection(undefined) }} />
        </div>
        <div className="min-h-0 min-w-0">
          <ReachabilityGraph model={model} selected={selection} onSelect={setSelection} />
        </div>
        <div className="col-span-2 min-h-0 overflow-y-auto border-t border-theme-border xl:col-span-1 xl:border-t-0">
          <InspectorPanel inspector={inspector} onCTA={onCTA} />
        </div>
      </div>

      <CoverageFooter trace={trace} testedAt={testedAt} stale={stale} />
    </div>
  )
}

// ---------------------------------------------------------------- scenarios

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
      <div className="flex flex-none items-center py-2 pl-4.5 pr-3 text-[9.5px] font-bold tracking-[0.07em] text-theme-text-tertiary">PATHS DIFFER</div>
      <div className="flex min-w-0 flex-1 overflow-x-auto">
        {scenarios.map((s) => {
          const tone = routeTone(s.primary, { stale, running })
          const active = s.key === activeKey
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => onPick(s.key)}
              title={s.hosts.length > 1 ? s.hosts.join('\n') : undefined}
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
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-[14.5px] font-semibold text-theme-text-primary">{verdict.title}</span>
          <span className={`badge-sm whitespace-nowrap ${SEV_BADGE[verdict.tone]}`}>{verdict.chipText}</span>
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

function OriginRail({ origins, active, onPick }: { origins: Origin[]; active?: OriginId; onPick: (id: OriginId) => void }) {
  return (
    <div className="bg-theme-surface py-2.5">
      <div className="px-3 pb-1 text-[9.5px] font-bold tracking-[0.07em] text-theme-text-tertiary">TESTED FROM</div>
      <div className="px-3 pb-2 text-[10.5px] leading-snug text-theme-text-tertiary">
        Each of these is a different way to reach the resource. Pick one to see what it found.
      </div>
      {origins.map((o) => {
        const sel = o.id === active
        const m = markStyle(o.mark)
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
              <span style={glyphStyle(o.mark)} title={o.mark}>
                {m.glyph}
              </span>
            </div>
            {/* Deliberately terse. The mechanism, identity and the reason an
                origin is unusable all render in the inspector the moment it is
                selected - repeating them here made the rail taller than the
                graph and pushed the path off the pane. */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <TinyTag text={o.kindTag} tone={o.kind === 'synthetic' ? 'var(--color-warning-dark)' : o.kind === 'relayed' ? 'var(--color-info)' : 'var(--color-success-dark)'} />
              <TinyTag text={o.lane === 'dataplane' ? 'DATAPLANE' : 'CONTROL PLANE'} tone={o.lane === 'dataplane' ? 'var(--accent-text)' : 'var(--color-info)'} />
              {/* That an origin cannot be used stays visible at a glance -
                  hiding it entirely would make synthetic evidence look
                  complete. The why is one click away. */}
              {o.unavailable && <span className="text-[9px] text-theme-text-tertiary" title={o.unavailable}>⊘ unavailable</span>}
            </div>
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- inspector

function InspectorPanel({ inspector, onCTA }: { inspector: Inspector; onCTA: (c: InspectorCTA) => void }) {
  const [scopeOpen, setScopeOpen] = useState(false)
  return (
    <div className="flex h-full flex-col gap-2.5 bg-theme-surface px-3.5 py-3 xl:border-l xl:border-theme-border">
      <div>
        <div className="flex items-center gap-2">
          <span className="text-[9.5px] font-bold tracking-[0.07em] text-theme-text-tertiary">SELECTED</span>
          <div className="flex-1" />
          <span className={`badge-sm whitespace-nowrap ${SEV_BADGE[inspector.chipTone as SevTone]}`}>{inspector.chipText}</span>
        </div>
        <div className="mt-1.5 font-mono text-[12.5px] font-semibold leading-snug text-theme-text-primary">{inspector.title}</div>
        <div className="mt-1 whitespace-pre-line text-[11.5px] leading-relaxed text-theme-text-secondary text-pretty">{inspector.body}</div>
      </div>

      {/* Collapsed by default. The scope is reference detail; leaving it open
          pushed the evidence and the caveats - the parts that change a
          decision - below the fold. */}
      {inspector.scope.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setScopeOpen((v) => !v)}
            className="flex w-full items-center gap-1.5 text-[9.5px] font-bold tracking-[0.07em] text-theme-text-tertiary hover:text-theme-text-secondary"
          >
            <span>{inspector.scopeHeader}</span>
            <span className="flex-1 text-right font-normal tracking-normal">
              {inspector.scope.length} field{inspector.scope.length === 1 ? '' : 's'}
            </span>
            <span>{scopeOpen ? '⌄' : '›'}</span>
          </button>
          {scopeOpen &&
            inspector.scope.map((p, i) => (
              <div key={i} className="mt-0.5 flex gap-2 border-b border-theme-border-subtle py-0.5">
                <span className="w-[70px] flex-none pt-0.5 text-[9px] font-bold tracking-[0.04em] text-theme-text-tertiary">{p.k}</span>
                <span className="flex-1 break-words font-mono text-[10px] leading-snug text-theme-text-secondary">{p.v}</span>
              </div>
            ))}
        </div>
      )}

      {inspector.evidence.length > 0 && (
        <div>
          <div className="mb-1 text-[9.5px] font-bold tracking-[0.07em] text-theme-text-tertiary">EVIDENCE</div>
          {inspector.evidence.map((e, i) => (
            <div key={i} className="mb-1 flex items-baseline gap-1.5">
              <span style={glyphStyle(e.mark)}>{markStyle(e.mark).glyph}</span>
              <span className="text-[11px] leading-snug text-theme-text-secondary">{e.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* The caveats are the point of the panel: what the evidence does NOT
          establish is what stops a green result being over-read. */}
      {inspector.notProve.length > 0 && (
        <div
          className="rounded-md px-2.5 py-2"
          style={{ border: '1px solid var(--color-warning)', background: 'color-mix(in srgb, var(--color-warning) 10%, transparent)' }}
        >
          <div className="text-[9.5px] font-bold tracking-[0.05em]" style={{ color: 'var(--color-warning-dark)' }}>
            WHAT THIS DOES NOT PROVE
          </div>
          {inspector.notProve.map((n, i) => (
            <div key={i} className="mt-1 text-[10.5px] leading-snug text-theme-text-secondary">
              ▲ {n}
            </div>
          ))}
        </div>
      )}

      <div className="rounded-md px-2.5 py-2.5" style={{ border: '1px solid var(--accent)', background: 'var(--accent-muted)' }}>
        <div className="text-[9.5px] font-bold tracking-[0.05em]" style={{ color: 'var(--accent-text)' }}>
          {inspector.next.header}
        </div>
        <div className="mt-1 text-[11.5px] leading-snug text-theme-text-secondary text-pretty">{inspector.next.body}</div>
        {inspector.next.blocked && (
          <div className="mt-1.5 text-[10.5px] leading-snug" style={{ color: 'var(--color-warning-dark)' }}>
            ⊘ {inspector.next.blocked}
          </div>
        )}
        {inspector.next.ctas.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {inspector.next.ctas.map((c, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onCTA(c)}
                disabled={!!c.disabledReason}
                title={c.disabledReason}
                className={
                  c.primary && !c.disabledReason
                    ? 'btn-brand cursor-pointer whitespace-nowrap rounded-md px-2.5 py-1.5 text-[11px] font-semibold'
                    : 'cursor-pointer whitespace-nowrap rounded-md border border-theme-border bg-theme-base px-2.5 py-1.5 text-[11px] font-semibold text-theme-text-secondary disabled:cursor-not-allowed disabled:opacity-60'
                }
              >
                {c.text}
              </button>
            ))}
          </div>
        )}
      </div>
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
  const coverageText = c
    ? `tested ${c.tested} · passed ${c.passed} · failed ${c.failed}${c.skipped ? ` · skipped ${c.skipped}` : ''}${realGaps.length ? ` · ${realGaps.length} not tested` : ''}`
    : 'no coverage data'
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-t border-theme-border bg-theme-surface px-5 py-2 text-[11px] text-theme-text-tertiary">
      <span className="text-[9.5px] font-bold tracking-[0.07em]">COVERAGE</span>
      <span className="font-mono text-theme-text-secondary">{coverageText}</span>
      <span className="text-theme-border">|</span>
      <span className="text-[9.5px] font-bold tracking-[0.07em]">FRESHNESS</span>
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
