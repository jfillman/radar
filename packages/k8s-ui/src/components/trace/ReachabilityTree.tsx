import { reachVerdict } from './reachVerdict'
import { CoverageSection, CoverageSummary, CoverageSkipRow, PathSection, ReachActions, JustTestedNote, VerdictCaveat, RequestIndicator, inClusterEligible, type TracePanelProps } from './TracePanel'
import { ReachabilityExplainer } from './ReachabilityExplainer'
import { StatusDot } from '../ui/status-tone'

/**
 * ReachabilityTree is the redesigned full-screen "Tree" view. Verdict-first — the
 * honest reachVerdict line, NEVER a ⚠ on a success — then, when probed, a plain
 * "what this test checked / what it did NOT confirm" explainer and a compact coverage
 * counts strip. THEN the persistent path (PathSection): it is ALWAYS rendered, config
 * and all, so running the test ENRICHES the picture instead of replacing it — each
 * hop's live probe outcome layers inline (HopRow already reads hop.probes). "Not
 * tested" routes stay visible; the per-route matrix + in-cluster re-test move into an
 * opt-in disclosure so they never hide the path. The Diagram view is the sibling.
 */
export function ReachabilityTree(props: TracePanelProps) {
  const { trace, onRunProbes, probeRequested, inClusterRunner, probed, onRunInCluster, inClusterRunning, inClusterAllowed, runNonce } = props
  if (!trace) {
    return <div className="text-sm text-theme-text-tertiary p-4">No reachability data.</div>
  }
  const v = reachVerdict(trace, probed)
  const diag = trace.diagnosis
  // Show the cause+command whenever the VERDICT is bad — not just when the static
  // trace.verdict is, since live coverage can fail routes while the static verdict
  // still reads healthy.
  const broken = v.tone === 'unhealthy' || v.tone === 'degraded'
  const showExpandable = !!trace.coverage && (trace.routes ?? []).some((r) => r.confidence === 'indirect' || inClusterEligible(r))
  const inClusterTested = [...(trace.downstream ?? []), ...(trace.upstreams ?? [])].some((h) => (h.probes ?? []).some((p) => p.vantage === 'in-cluster'))
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-theme-border bg-theme-surface px-3 py-2">
        <div className="flex items-start gap-2 min-w-0">
          <span className="mt-0.5 shrink-0"><StatusDot tone={v.tone} size="sm" /></span>
          <div className="min-w-0">
            <div className="text-sm font-medium text-theme-text-primary">
              {v.icon ? v.icon + ' ' : ''}{v.text}
              <JustTestedNote nonce={runNonce} />
            </div>
            <VerdictCaveat caveat={v.caveat} detail={v.detail} />
            {probed && <RequestIndicator path={props.probePath} />}
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
          probePath={props.probePath}
          onApplyProbePath={props.onApplyProbePath}
        />
      </div>
      {/* Plain-language "what was tested / what was NOT confirmed" — first-class, not a
          footnote. Renders nothing until probed. */}
      <ReachabilityExplainer trace={trace} probed={probed} inClusterRunning={inClusterRunning} probePath={props.probePath} />
      {broken && diag && (diag.summary || diag.nextAction || diag.command) && (
        <div className="rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm">
          {/* Don't restate the situation the verdict already shows — lead with the FIX. */}
          {diag.summary && diag.summary !== v.text && <div className="text-theme-text-primary">{diag.summary}</div>}
          {diag.nextAction && <div className="text-theme-text-secondary">→ {diag.nextAction}</div>}
          {diag.command && (
            <code className="mt-1.5 block break-all rounded bg-theme-base px-2 py-1 text-[11px] font-mono text-theme-text-secondary">{diag.command}</code>
          )}
        </div>
      )}
      {/* Compact coverage counts — only when there are enough routes to actually
          summarize. A "1 reached" strip just restates the verdict, so hide it small. */}
      {trace.coverage && (trace.routes?.length ?? 0) > 1 && <CoverageSummary coverage={trace.coverage} routes={trace.routes ?? []} />}
      {/* The persistent path — config pills + per-hop static findings + (when probed)
          each hop's live probe outcome inline. Always shown; Run enriches, never hides. */}
      <PathSection trace={trace} onNavigate={props.onNavigateToResource} />
      {/* "Not tested" routes stay visible — we won't claim these pass or fail. */}
      {(trace.notTested?.length ?? 0) > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-[11px] uppercase tracking-wide text-theme-text-tertiary">Not tested — we won’t say these pass or fail</div>
          {trace.notTested!.map((s, i) => (
            <CoverageSkipRow key={(s.route ?? '') + ':' + i} skip={s} />
          ))}
        </div>
      )}
      {/* Per-route matrix + in-cluster re-test: opt-in, so it never replaces the path. */}
      {showExpandable && (
        <details className="text-[11px]">
          <summary className="cursor-pointer select-none text-theme-text-secondary hover:text-theme-text-primary">Per-route detail and in-cluster re-test</summary>
          <div className="mt-2">
            <CoverageSection trace={trace} runner={inClusterRunner} />
          </div>
        </details>
      )}
      <div className="text-[11px] text-theme-text-tertiary border-t border-theme-border pt-2">
        {trace.coverage
          ? 'Built from declared config + live probes. NetworkPolicy enforcement isn’t tested — a policy could still drop traffic the probes can’t see.'
          : 'Static analysis of the declared config. Run the test to add the live-traffic layer.'}
      </div>
    </div>
  )
}
