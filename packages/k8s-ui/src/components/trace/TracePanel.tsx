import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { clsx } from 'clsx'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  ShieldAlert,
  Network,
  Loader2,
  Info,
  RefreshCw,
  MoreHorizontal,
  Pencil,
} from 'lucide-react'
import { Tooltip } from '../ui/Tooltip'
import type { Trace, Hop, Finding, FindingSeverity, Verdict, HopConfig, ProbeResult, ProbeVantage, ResourceRef, RouteResult, RouteSkip, Coverage } from './types'
import { collapseSkipRows } from './probe-display'
import { AlertBanner } from '../ui/drawer-components'
import { Badge } from '../ui/Badge'
import { StatusDot, type StatusTone } from '../ui/status-tone'
import { ConfirmDialog } from '../ui/ConfirmDialog'

export interface TracePanelProps {
  trace: Trace | undefined
  isLoading?: boolean
  error?: Error | null
  /** A reachability-probe run that failed. Rendered inline (NOT as a
   *  full-panel error) so the valid static trace stays visible — the user
   *  clicked "run test", it failed, and they see why instead of nothing. */
  probeError?: Error | null
  /** Optional: parent-provided refetch action surfaced when the trace verdict
   *  is unknown — gives the operator a way to retry after RBAC/cache changes
   *  without forcing a drawer close+reopen. */
  onRefresh?: () => void
  /** True when the next refetch should request reachability probes. The
   *  parent passes back the resulting Trace via the trace prop. Probes are
   *  one-shot — the parent should reset this to false after results arrive. */
  probeRequested?: boolean
  /** Callback when the operator asks for a reachability test. The parent
   *  is expected to set probeRequested=true and trigger a refetch; results
   *  flow back through `trace.downstream[].probes`. */
  onRunProbes?: () => void
  /** True once a probe run has COMPLETED (the parent holds a probed trace),
   *  even if that probe found nothing testable (e.g. an ExternalName, or every
   *  route skipped from this vantage). Lets the view distinguish "not yet
   *  probed" from "probed, no result" so clicking Run is never a silent no-op. */
  probed?: boolean
  /** When provided, the resource label on each hop becomes clickable and
   *  invokes this with the hop's ResourceRef so the host can open the
   *  resource's detail view. Hops without a routable name (collections like
   *  the Pods fan-out) stay non-clickable. Without this prop, hop rows are
   *  inert text and the only interaction is the expand chevron. */
  onNavigateToResource?: (ref: ResourceRef) => void
  /** When provided, routes that could only be reached indirectly (via the API
   *  proxy) or that failed gain a "Test from inside the cluster" affordance that
   *  runs a real-dataplane probe Job. The host wires these to the backend. */
  inClusterRunner?: InClusterRunner
  /** One-click "test every path from inside the cluster" — runs the in-cluster
   *  probe for the whole subject and merges the real-traffic results back into the
   *  trace, filling the matrix's "Real in-cluster traffic" column + upgrading the
   *  verdict. Shown only when the in-cluster test is actually permitted. */
  onRunInCluster?: () => void
  inClusterRunning?: boolean
  inClusterAllowed?: boolean
  /** Set when the in-cluster test couldn't produce a result (e.g. a cold-start
   *  timeout) — surfaced so the click is never a silent no-op. */
  inClusterError?: string
  /** The HTTP path the probes request (default "/"); shown as the tested-request
   *  indicator. onApplyProbePath sets a new path and re-runs. */
  probePath?: string
  onApplyProbePath?: (path: string) => void
  /** Bumped by the host every time a test run COMPLETES — drives the transient
   *  "updated just now" confirmation so an identical-looking result still reads as fresh. */
  runNonce?: number
}

/** Whether an in-cluster reachability test can run for this caller, and the
 *  cluster + namespace the probe pod would be created in (the safety rail). */
export interface InClusterCapability {
  allowed: boolean
  reason?: string
  cluster?: string
  namespace: string
}
/** Result of running the in-cluster probe: real-dataplane probe results, or a
 *  copyable fallback command when it couldn't run. */
export interface InClusterRunResult {
  results?: ProbeResult[]
  fallbackCommand?: string
  error?: string
}
export interface InClusterRunner {
  capability: () => Promise<InClusterCapability>
  run: (req: { target: string; host?: string; scheme?: string; path?: string; layers?: string }) => Promise<InClusterRunResult>
}

/**
 * TracePanel renders the path-shaped diagnosis for one network entry kind.
 *
 * Layout invariant — top to bottom mirrors traffic direction:
 *   1) Verdict banner (the one-sentence answer)
 *   2) Upstreams (parallel hops INTO the subject — judged independently)
 *   3) Subject + Downstream chain (where BrokenAt applies)
 *
 * The hop rail (dots + connector line) is the visual spine; the rail color at
 * each dot mirrors that hop's worst finding. The first critical Downstream
 * hop gets a heavier ring + a left-edge accent so the eye lands on the break
 * before reading the message.
 */
export function TracePanel({ trace, isLoading, error, probeError, onRefresh, probeRequested, onRunProbes, onNavigateToResource, inClusterRunner }: TracePanelProps) {
  // All hooks must run unconditionally before any early return —
  // React's Rules of Hooks require a stable hook-call count between
  // renders, so a conditional return above any hook produces the
  // "Rendered more hooks than during the previous render" crash on
  // the very next render that picks a different branch. Derive
  // against possibly-undefined trace upfront; the early returns sit
  // below the hook block.
  const containerRef = useRef<HTMLDivElement | null>(null)
  const upstreams = useMemo(
    () => (trace?.upstreams ?? []).map(normalizeHopFindings),
    [trace],
  )
  const downstream = useMemo(
    () => (trace?.downstream ?? []).map(normalizeHopFindings),
    [trace],
  )
  const feasibility = useMemo(
    () => probeFeasibility([...upstreams, ...downstream]),
    [upstreams, downstream],
  )
  // jumpToBroken locates the broken hop's DOM node within the panel
  // and scrolls + pulses it. Scoping the query to containerRef avoids
  // matching another panel's broken hop when multiple TracePanels are
  // mounted (e.g. dock + drawer). The data-broken-target attribute is
  // set on whichever HopRow is currently rendered as broken; the
  // attribute moves automatically when brokenAt changes.
  const jumpToBroken = useCallback(() => {
    const root = containerRef.current
    if (!root) return
    const el = root.querySelector<HTMLElement>('[data-broken-target="true"]')
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('trace-broken-pulse')
    window.setTimeout(() => el.classList.remove('trace-broken-pulse'), 1200)
  }, [])
  if (isLoading && !trace) {
    return <PanelMessage tone="muted" message="Loading trace…" />
  }
  if (error && !trace) {
    return <PanelMessage tone="error" message={`Failed to load trace: ${error.message}`} onAction={onRefresh} actionLabel="Retry" />
  }
  if (!trace) {
    return <PanelMessage tone="muted" message="No trace data available." />
  }
  const hasPath = downstream.length > 0 || upstreams.length > 0
  // probesPresent gates the Reachability section header text ("Results
  // shown beneath each hop" vs "Run reachability test") — true once the
  // operator has triggered probes, even if every row came back skipped.
  // liveEvidence gates the verdict banner's qualifier — it requires at
  // least one non-skipped probe result, since skipped rows carry no
  // evidence and would let "Configuration looks healthy" overclaim in
  // the laptop default scenario where every probe skips for lack of
  // proxy RBAC.
  const probesPresent = hasAnyProbes(trace)
  const liveEvidence = hasRealProbes(trace)
  // Layout is padding-free; the consumer (Diagnose tab or drawer
  // Section) owns the outer spacing so we don't double-pad when nested
  // inside a Radar Section component.
  // A broken verdict always carries a brokenAt anchor. A degraded verdict
  // often does not: a single-chain warning, an upstream-only warning, or a
  // probe-induced 5xx leave brokenAt at -1, which would render an amber banner
  // with no highlighted row and no "show me" — the operator can't find the hop
  // the verdict is about. Fall back to the first hop carrying the degrade
  // signal so a degraded path is always navigable to its cause.
  const focusAt = trace.brokenAt >= 0 ? trace.brokenAt : degradeFocusIndex(downstream, trace.verdict)
  const focusHop = focusAt >= 0 && focusAt < downstream.length ? downstream[focusAt] : undefined
  return (
    <div ref={containerRef} className="flex flex-col gap-3">
      <VerdictBanner verdict={trace.verdict} reason={trace.reason} brokenHop={focusHop} unknownClass={trace.unknownClass} liveEvidence={liveEvidence} coverage={trace.coverage} headline={trace.headline} routes={trace.routes} onRefresh={onRefresh} onJumpToBroken={focusHop && focusHop.resource.name ? jumpToBroken : undefined} />
      {probesPresent && <ProbeOriginNote origin={probeOrigin(trace)} live={liveEvidence} />}
      {onRunProbes && hasPath && (
        <ReachabilitySection
          feasibility={feasibility}
          probesPresent={probesPresent}
          liveEvidence={liveEvidence}
          isLoading={Boolean(isLoading)}
          requested={Boolean(probeRequested)}
          onRun={onRunProbes}
        />
      )}
      {probeError && (
        <AlertBanner
          variant="error"
          title="Reachability test failed"
          message={probeError.message}
        >
          {onRunProbes && (
            <button
              type="button"
              onClick={onRunProbes}
              className="mt-2 text-xs px-2 py-1 rounded border border-current/30 hover:bg-current/10 transition-colors"
            >
              Try again
            </button>
          )}
        </AlertBanner>
      )}
      <CoverageSection trace={trace} runner={inClusterRunner} />
      <PathSection trace={trace} onNavigate={onNavigateToResource} />
      {trace.truncated && (
        <p className="text-xs text-theme-text-tertiary">
          Some attached routes were omitted to bound the trace response.
        </p>
      )}
      <ZeroConfigDisclaimer />
    </div>
  )
}

/**
 * PathSection renders the STATIC path topology — upstream entries + the
 * downstream Service→Pods chain — with each hop's config (ports, port→targetPort,
 * readiness, selector, ingress rules/backends) and its static findings. It needs
 * NO probes: it is the config / static-analysis layer the Reachability tab always
 * shows. Probing adds the live overlay (CoverageSection) on top of this same path.
 */
export function PathSection({ trace, onNavigate }: { trace: Trace; onNavigate?: (ref: ResourceRef) => void }) {
  const upstreams = (trace.upstreams ?? []).map(normalizeHopFindings)
  const downstream = (trace.downstream ?? []).map(normalizeHopFindings)
  if (upstreams.length === 0 && downstream.length === 0) return null
  const focusAt = trace.brokenAt >= 0 ? trace.brokenAt : degradeFocusIndex(downstream, trace.verdict)
  return (
    <>
      {upstreams.length > 0 && <UpstreamsBlock upstreams={upstreams} onNavigate={onNavigate} />}
      {downstream.length > 0 && (
        <DownstreamBlock subject={trace.subject} downstream={downstream} brokenAt={trace.brokenAt} focusAt={focusAt} onNavigate={onNavigate} />
      )}
    </>
  )
}

function hasAnyProbes(trace: Trace): boolean {
  return (
    trace.downstream.some((h) => (h.probes?.length ?? 0) > 0) ||
    trace.upstreams.some((h) => (h.probes?.length ?? 0) > 0)
  )
}

// hasRealProbes reports whether at least one non-skipped probe result
// landed on the trace. Skipped rows carry no live evidence and so
// shouldn't count toward "probes ran" for trust-calibration purposes:
// the healthy banner qualifier needs to distinguish "probes confirmed
// the path" from "probes were requested but all skipped" (which is
// epistemically the same as no probing at all).
export function hasRealProbes(trace: Trace): boolean {
  const real = (h: Hop) => (h.probes ?? []).some((p) => !p.skipped)
  return trace.downstream.some(real) || trace.upstreams.some(real)
}


// probeOrigin reports where the live probes physically ran from. Every probe
// in a run shares one vantage, so the first non-skipped result is
// authoritative. The user needs this to read a verdict honestly: "broken"
// from a laptop can just mean "your machine can't reach it" while in-cluster
// traffic is fine (split-horizon DNS, internal-only Ingress).
export function probeOrigin(trace: Trace): ProbeVantage | undefined {
  // Skipped probes still carry the vantage they were attempted from, so an
  // all-skipped run (e.g. a laptop probing a non-HTTP Service) still shows
  // where it was attempted instead of hiding origin entirely.
  for (const h of [...trace.downstream, ...trace.upstreams]) {
    for (const p of h.probes ?? []) {
      if (p.vantage) return p.vantage
    }
  }
  return undefined
}

// ProbeOriginNote states where probes ran and what that does NOT prove. It is
// always visible alongside the verdict (not buried in a row) so the operator
// never reads "broken"/"verified" as absolute truth about in-cluster traffic.
function ProbeOriginNote({ origin, live }: { origin?: ProbeVantage; live?: boolean }) {
  if (!origin) return null
  const local = origin === 'local'
  const where = local ? 'your machine (out-of-cluster)' : 'Radar, in-cluster'
  // When every probe skipped there's no live evidence to caveat — just say
  // where it was attempted and that nothing completed, so the user doesn't
  // read the static verdict as probe-confirmed.
  if (!live) {
    return (
      <p className="text-[11px] text-theme-text-tertiary flex items-start gap-1.5 -mt-1">
        <Network className="w-3 h-3 mt-0.5 shrink-0" />
        <span>Attempted from <span className="text-theme-text-secondary">{where}</span> — no live probe completed (all checks skipped). The verdict reflects declared config only.</span>
      </p>
    )
  }
  // Keep the caveat NEUTRAL and verdict-independent: a failure can have many
  // causes (5xx reached, missing backend, no endpoints) and is NOT always "your
  // machine can't reach it" — asserting that would mislead. The per-probe rows
  // and the verdict reason carry the actual cause; this line only frames the
  // probe's vantage and what it inherently can't speak for.
  const caveat = local
    ? 'Reflects what your machine can reach, not in-cluster workload-to-workload traffic.'
    : 'The probe source is Radar, not your client workload, so NetworkPolicy may differ.'
  return (
    <p className="text-[11px] text-theme-text-tertiary flex items-start gap-1.5 -mt-1">
      <Network className="w-3 h-3 mt-0.5 shrink-0" />
      <span>Probed from <span className="text-theme-text-secondary">{where}</span>. {caveat}</span>
    </p>
  )
}

function normalizeHopFindings(hop: Hop): Hop {
  return hop.findings ? hop : { ...hop, findings: [] }
}

// Verdict banner — delegates to the shared AlertBanner so the trace surface
// matches the rest of Radar (Helm, GitOps, renderers all use AlertBanner).
// The verdict→variant mapping keeps the operator's color vocabulary stable
// across surfaces.

// Canonical label for the apiserver-proxy path — used everywhere so the chip,
// the probe-row path tag, and tooltips never drift into "via API" / "via
// Kubernetes API" variants. Short form in rendered copy; tooltips spell out
// "Kubernetes API server proxy".
const API_PROXY_LABEL = 'via API server'

const VERDICT_TITLE: Record<Verdict, string> = {
  healthy: 'Traffic path looks healthy',
  degraded: 'Traffic path is degraded',
  broken: 'Traffic path is broken',
  unknown: "Traffic path can't be verified",
}

const VERDICT_TITLE_BY_DESIGN = 'Auto-verification not applicable for this kind'

// Default variant per verdict. The unknown case is overridden at render
// time by unknownClass: by-design unknowns render as informational
// rather than warning since nothing is broken — the shape just isn't
// auto-verifiable (ExternalName, selectorless, manually-managed
// endpoints).
const VERDICT_VARIANT: Record<Verdict, 'success' | 'warning' | 'error' | 'info'> = {
  healthy: 'success',
  degraded: 'warning',
  broken: 'error',
  unknown: 'warning',
}

// worseBannerVariant returns the more-alarming of two banner tones (error >
// warning > info > success). Used to floor a probe-derived tone at the static
// verdict so a config-only degrade still colors the banner.
const BANNER_TONE_RANK: Record<'success' | 'warning' | 'error' | 'info', number> = { success: 0, info: 1, warning: 2, error: 3 }
function worseBannerVariant(a: 'success' | 'warning' | 'error' | 'info', b: 'success' | 'warning' | 'error' | 'info'): 'success' | 'warning' | 'error' | 'info' {
  return BANNER_TONE_RANK[a] >= BANNER_TONE_RANK[b] ? a : b
}

const VERDICT_ICON: Record<Verdict, React.ComponentType<{ className?: string }>> = {
  healthy: CheckCircle2,
  degraded: AlertTriangle,
  broken: ShieldAlert,
  unknown: AlertTriangle,
}

type AlertTone = 'success' | 'warning' | 'error' | 'info'

const ALERT_ICON: Record<AlertTone, React.ComponentType<{ className?: string }>> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  error: ShieldAlert,
  // info is the calm "reached / not yet tested" state, not an alarm - match
  // TraceSummary's info icon so the same state reads the same on both surfaces.
  info: Info,
}

// coverageBannerTone derives the SINGLE banner tone from what we actually
// tested — never the legacy verdict word, which can over-claim a confident
// "healthy" on apiserver-only evidence. Honesty rules: indirect-only and
// zero-tested are never green (the real-traffic path was not confirmed);
// not-tested is never red.
export function coverageBannerTone(coverage: Coverage, routes: RouteResult[]): AlertTone {
  if (coverage.tested === 0) return 'info' // nothing actively tested
  if (coverage.passed === 0 && coverage.failed > 0) {
    // Red ONLY when something is genuinely unreachable. Failures that still
    // REACHED the server are amber, not red — a 5xx (degraded: traffic passed,
    // the app errored) or an intentional scale-to-0 (benign dormancy) — which
    // keeps the banner consistent with the degraded verdict.
    const hardUnreach = routes.filter((r) => r.outcome === 'unreachable' && !r.benign)
    // An apiserver-proxy-only (indirect) failure must NEVER set a red headline —
    // the real path was never tested (mirrors reachVerdict's onlyIndirectUnreach).
    // When every unreachable route is indirect, warn, don't condemn.
    const anyRealUnreach = hardUnreach.some((r) => r.confidence !== 'indirect')
    if (hardUnreach.length > 0) return anyRealUnreach ? 'error' : 'warning'
    return 'warning'
  }
  if (coverage.failed > 0) return 'warning' // some reachable, some not
  // Every tested route passed — green ONLY if a real-traffic path was VERIFIED.
  // A route that only 'reached' a server (3xx/4xx, route not verified) is not
  // confirmation; including it would overclaim a green headline while the coverage
  // strip below stays neutral. Matches routeTone/CoverageSummary/probeChipFor.
  const realPass = routes.some((r) => r.confidence === 'real' && r.outcome === 'verified')
  return realPass ? 'success' : 'info'
}

export function VerdictBanner({ verdict, reason, brokenHop, unknownClass, liveEvidence, coverage, headline, routes, onRefresh, onJumpToBroken }: { verdict: Verdict; reason?: string; brokenHop?: Hop; unknownClass?: 'by-design' | 'investigate'; liveEvidence?: boolean; coverage?: Coverage; headline?: string; routes?: RouteResult[]; onRefresh?: () => void; onJumpToBroken?: () => void }) {
  // Coverage-honest banner: when active probing produced a coverage projection,
  // the coverage headline is THE single status surface, its tone derived from
  // what we actually tested — not the legacy verdict word (which can show a
  // confident "healthy" beside an honest "reached via management API"). Static-
  // only / config-shape traces (no coverage) fall through to the legacy banner.
  if (coverage && headline) {
    // The probe-coverage tone can only see what it probed. A static degrade/break
    // the probe can't observe — a missing TLS secret, a pending LoadBalancer, any
    // config-only finding — would otherwise let a backend the probe reached paint
    // a green "healthy" over a real problem. Floor the tone at the static verdict
    // so degraded/broken always colors the banner (never downgrades; healthy and
    // by-design `unknown` keep the probe tone).
    const probeVariant = coverageBannerTone(coverage, routes ?? [])
    const variant = (verdict === 'degraded' || verdict === 'broken')
      ? worseBannerVariant(probeVariant, VERDICT_VARIANT[verdict])
      : probeVariant
    const showJump = Boolean(onJumpToBroken && coverage.failed > 0 && brokenHop && brokenHop.resource.name)
    return (
      <AlertBanner variant={variant} icon={ALERT_ICON[variant]} title={headline}>
        {showJump && (
          <button type="button" onClick={onJumpToBroken} className="mt-2 mr-2 text-xs px-2 py-1 rounded border border-current/30 hover:bg-current/10 transition-colors">
            Show me
          </button>
        )}
        {onRefresh && variant === 'info' && (
          <button type="button" onClick={onRefresh} className="mt-2 text-xs px-2 py-1 rounded border border-current/30 hover:bg-current/10 transition-colors">
            Run reachability test
          </button>
        )}
      </AlertBanner>
    )
  }
  // When a single hop is the locus of the break/degrade, name it in the
  // banner title — a generic "Traffic path is degraded" leaves the
  // operator without a starting point. Synthetic collection hops (Pods,
  // Routes) carry an empty Resource.Name; skip the rewrite for those
  // since "Pods is broken" is grammatically off and the row below
  // already carries the same identity.
  let title = VERDICT_TITLE[verdict]
  let variant = VERDICT_VARIANT[verdict]
  let icon = VERDICT_ICON[verdict]
  // When a specific reason is set (a multi-route partial break, or an upstream
  // break), it is the authoritative honest sentence — keep the generic
  // "Traffic path is degraded" title and let the reason carry the specifics.
  // Rewriting the title to "${brokenHop} is degraded" would be wrong: in a
  // partial break the highlighted hop is the BROKEN backend, not a degraded
  // one, and the path (not the resource) is what's degraded.
  if (brokenHop && brokenHop.resource.name && verdict === 'broken' && !reason) {
    const ref = brokenHop.resource
    title = `${ref.kind} ${ref.name} is broken - traffic can't pass`
  } else if (brokenHop && brokenHop.resource.name && verdict === 'degraded' && !reason) {
    const ref = brokenHop.resource
    title = `${ref.kind} ${ref.name} is degraded`
  } else if (verdict === 'healthy' && !liveEvidence) {
    // Without at least one non-skipped probe, the green check claims
    // "fine, look elsewhere" on the strength of static config alone.
    // Qualify the banner so the operator knows probing would tighten
    // the conclusion. Skipped probe rows do not satisfy liveEvidence:
    // they're epistemically the same as not having probed.
    title = 'Configuration looks healthy - run the reachability test to confirm traffic actually flows'
  } else if (verdict === 'healthy' && reason) {
    // Lead the title with the concrete state the probe established, not a
    // hedge: the server was reached (or verified via the API proxy) but the
    // exact route wasn't confirmed end-to-end (3xx/4xx, port-only, or
    // proxy-only). The reason carries the specific caveat as the message below.
    title = reason.startsWith('verified') ? 'Reachable - verified via API server' : 'Reachable - server reached'
  }
  if (verdict === 'unknown' && unknownClass === 'by-design') {
    // Steady-state unverifiable shapes (selectorless, ExternalName) read
    // as informational, not investigate. Switch to a calm info banner
    // so housekeeping browsers don't see false alarms on every such
    // Service.
    title = VERDICT_TITLE_BY_DESIGN
    variant = 'info'
    icon = CheckCircle2
  }
  return (
    <AlertBanner
      variant={variant}
      icon={icon}
      title={title}
      message={reason}
    >
      {onJumpToBroken && (verdict === 'broken' || verdict === 'degraded') && brokenHop && brokenHop.resource.name && (
        <button
          type="button"
          onClick={onJumpToBroken}
          className="mt-2 mr-2 text-xs px-2 py-1 rounded border border-current/30 hover:bg-current/10 transition-colors"
        >
          Show me
        </button>
      )}
      {onRefresh && verdict === 'unknown' && unknownClass !== 'by-design' && (
        <button
          type="button"
          onClick={onRefresh}
          className="mt-2 text-xs px-2 py-1 rounded border border-current/30 hover:bg-current/10 transition-colors"
        >
          Refresh
        </button>
      )}
    </AlertBanner>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Coverage — the per-intended-route truth (what we tested vs couldn't)
// ────────────────────────────────────────────────────────────────────────────

// routeOutcomeLabel: the honest per-route label. An INDIRECT route (reached only
// via the apiserver proxy) is NEVER "verified" — the real-traffic path was not
// confirmed. Exported for unit testing.
export function routeOutcomeLabel(r: RouteResult): string {
  if (r.benign) return 'scaled to 0' // unreachable by design, not an outage
  if (r.confidence === 'indirect') {
    // A proxy-only unreachable never tested the real path — carry the same
    // qualifier the Go singleRouteHeadline does, don't bare-condemn it.
    if (r.outcome === 'unreachable') return 'unreachable via API server (real path not confirmed)'
    // A proxy-observed 5xx still reached an erroring app — say so, don't flatten it
    // to a calm "reached" that hides the failure and contradicts the amber dot.
    if (r.outcome === 'server-error') return 'server error'
    return 'reached'
  }
  switch (r.outcome) {
    case 'verified': return 'verified'
    case 'reached': return 'reached · route not verified'
    case 'server-error': return 'server error'
    case 'unreachable': return 'unreachable'
    default: return 'not tested'
  }
}

// routeTone maps a route outcome onto the shared StatusTone. An indirect success
// is neutral (reachable, but not proven via real traffic), never green.
export function routeTone(r: RouteResult): StatusTone {
  if (r.benign) return 'degraded' // amber — deliberate dormancy, not red
  switch (r.outcome) {
    case 'verified': return r.confidence === 'indirect' ? 'neutral' : 'healthy'
    case 'reached': return 'neutral'
    case 'server-error': return 'degraded'
    // A proxy-only (indirect) unreachable never tested the real path — neutral,
    // never red (mirrors reachVerdict onlyIndirectUnreach + the verified case above).
    case 'unreachable': return r.confidence === 'indirect' ? 'unknown' : 'unhealthy'
    default: return 'unknown'
  }
}

function routeBadgeSeverity(r: RouteResult): 'error' | 'warning' | 'info' | 'success' | 'neutral' {
  if (r.benign) return 'warning' // amber, not red
  if (r.confidence === 'indirect') {
    // A proxy-only unreachable never tested the real path — info/neutral, not red.
    if (r.outcome === 'unreachable') return 'info'
    if (r.outcome === 'server-error') return 'warning' // amber, matches routeTone's degraded dot
    return 'info'
  }
  switch (r.outcome) {
    case 'verified': return 'success'
    case 'reached': return 'info'
    case 'server-error': return 'warning'
    case 'unreachable': return 'error'
    default: return 'neutral'
  }
}

// outcomeRank sorts the matrix failures-first. Exported for the test.
export function routeOutcomeRank(o: RouteResult['outcome']): number {
  switch (o) {
    case 'unreachable': return 0
    case 'server-error': return 1
    case 'reached': return 2
    case 'verified': return 3
    default: return 4
  }
}

// CoverageSection renders the coverage-honest read: the single headline, then the
// per-intended-route matrix (tested, failures-first) and the routes we couldn't
// test (reason + copyable command). Localization facts show as muted "checked
// behind it" sub-lines — never labelled "localization" in the UI.
type RouteTestState =
  | { state: 'running' }
  | { state: 'done'; results: ProbeResult[] }
  | { state: 'error'; error?: string; fallbackCommand?: string }

// Session-scoped "don't ask again" for the in-cluster test consent. Module-level
// so it survives route remounts within a session but resets on reload.
let sessionSkipInClusterConsent = false

// inClusterOutcome reduces real-dataplane probe results to a route label/tone.
// A 2xx HERE is real-traffic verified — the payoff over the indirect API-proxy read.
export function inClusterOutcome(results: ProbeResult[]): { label: string; tone: StatusTone; severity: 'error' | 'warning' | 'info' | 'success' | 'neutral' } {
  // A SKIPPED probe has ok=false but is NOT a failure — classifying it would
  // false-condemn a port that actually connected. Drop skips first so a skipped
  // HTTP probe falls through to the TCP "port reachable" / "tested" branches.
  const real = results.filter((r) => !r.skipped)
  const http = real.find((r) => r.layer === 'http')
  if (http) {
    if (http.ok && http.tone === 'healthy') return { label: 'verified', tone: 'healthy', severity: 'success' }
    if (http.ok && http.tone === 'reached') return { label: 'reached', tone: 'neutral', severity: 'info' }
    if (http.ok && http.tone === 'degraded') return { label: 'server error', tone: 'degraded', severity: 'warning' }
    if (!http.ok) return { label: 'unreachable', tone: 'unhealthy', severity: 'error' }
  }
  const tcp = real.find((r) => r.layer === 'tcp')
  if (tcp) return tcp.ok ? { label: 'port reachable', tone: 'healthy', severity: 'success' } : { label: 'unreachable', tone: 'unhealthy', severity: 'error' }
  return { label: 'tested', tone: 'neutral', severity: 'neutral' }
}

// inClusterEligible: an indirect (API-proxy-only) or failed route is worth
// confirming from inside the cluster. A real-traffic verified route already is.
export function inClusterEligible(r: RouteResult): boolean {
  return !r.benign && (r.confidence === 'indirect' || r.outcome === 'unreachable' || r.outcome === 'server-error')
}

export interface InClusterTestRequest { scheme: string; host: string; path: string }

function InClusterAffordance({ route, cap, test, onTest }: { route: RouteResult; cap?: InClusterCapability; test?: RouteTestState; onTest: (req: InClusterTestRequest) => void }) {
  const guess = route.inClusterRequest
  const [scheme, setScheme] = useState(guess?.scheme || 'http')
  const [host, setHost] = useState(guess?.host || '')
  const [path, setPath] = useState(guess?.path || '/')

  if (test?.state === 'done') {
    const o = inClusterOutcome(test.results)
    const detail = test.results.find((r) => r.layer === 'http')?.detail || test.results.find((r) => r.detail)?.detail || ''
    return (
      <div className="mt-1 flex items-center gap-1.5 flex-wrap text-[11px]">
        <span className="shrink-0" aria-hidden><StatusDot tone={o.tone} size="sm" /></span>
        <span className="text-theme-text-secondary">from inside, {scheme} {host || route.target}{path}:</span>
        <Badge severity={o.severity} size="sm">{o.label}</Badge>
        {detail && <span className="text-theme-text-tertiary break-words">{detail}</span>}
      </div>
    )
  }
  if (test?.state === 'running') {
    return <div className="mt-1 text-[11px] text-theme-text-tertiary italic">creating probe… running… (testing from inside the cluster)</div>
  }
  if (test?.state === 'error') {
    return (
      <div className="mt-1 text-[11px]">
        <div className="text-amber-600 dark:text-amber-400 break-words">Couldn't test from inside: {test.error}</div>
        {test.fallbackCommand && <CopyableCommand command={test.fallbackCommand} />}
      </div>
    )
  }
  if (cap === undefined) return null // capability still loading
  if (!cap.allowed) {
    return <div className="mt-1 text-[11px] text-theme-text-tertiary">Can't test from inside: {cap.reason || 'no permission to create a probe pod here'}</div>
  }
  const inputCls = 'px-1 py-0.5 rounded border border-theme-border bg-theme-base text-theme-text-primary text-[11px]'
  return (
    <div className="mt-1 flex items-center gap-1 flex-wrap text-[11px]">
      <span className="text-theme-text-tertiary">test from inside:</span>
      <select aria-label="scheme" value={scheme} onChange={(e) => setScheme(e.target.value)} className={inputCls}>
        <option value="http">http</option>
        <option value="https">https</option>
      </select>
      <input aria-label="host" value={host} onChange={(e) => setHost(e.target.value)} placeholder={route.target || 'host'} size={Math.max(8, host.length)} className={`${inputCls} font-mono`} />
      <input aria-label="path" value={path} onChange={(e) => setPath(e.target.value)} size={Math.max(4, path.length)} className={`${inputCls} font-mono`} />
      <button type="button" onClick={() => onTest({ scheme, host, path })} className="px-2 py-0.5 rounded border border-current/30 text-theme-text-secondary hover:bg-theme-hover transition-colors">
        ▶ Test
      </button>
      {guess?.pathGuessed && <span className="text-theme-text-tertiary italic" title="The route path is a pattern (regex/wildcard) — this is a guessed concrete path. Edit it to match a real request.">guessed path</span>}
    </div>
  )
}

// inClusterDialTarget rewrites a "name:port" (or bare "name") target to its
// cluster-FQDN form "name.ns.svc:port" when the backend is in a DIFFERENT
// namespace than the subject — so the throwaway probe pod resolves the intended
// Service rather than a same-named one in its own namespace. Mirrors the Go
// fqdnDialTarget; same-namespace targets pass through unchanged.
function inClusterDialTarget(target: string, targetNamespace?: string, subjectNamespace?: string): string {
  if (!targetNamespace || targetNamespace === subjectNamespace) return target
  const [name, port] = target.split(':')
  const fqdn = `${name}.${targetNamespace}.svc`
  return port ? `${fqdn}:${port}` : fqdn
}

export function CoverageSection({ trace, runner, collapseHealthy }: { trace: Trace; runner?: InClusterRunner; collapseHealthy?: boolean }) {
  const routes = trace.routes ?? []
  const notTested = trace.notTested ?? []
  const subjectKey = `${trace.subject.kind}/${trace.subject.namespace ?? ''}/${trace.subject.name}`
  const [cap, setCap] = useState<InClusterCapability | undefined>(undefined)
  const [tests, setTests] = useState<Record<string, RouteTestState>>({})
  const [consent, setConsent] = useState<{ route: RouteResult; key: string; req: InClusterTestRequest } | null>(null)
  const [dontAsk, setDontAsk] = useState(false)

  // This component isn't remounted when navigating between resources, so an
  // in-cluster result keyed only by route could render against a different
  // subject's matching route. Reset on subject change so results never leak.
  useEffect(() => {
    setTests({})
    setConsent(null)
  }, [subjectKey])

  useEffect(() => {
    if (!runner) return
    let alive = true
    runner.capability()
      .then((c) => { if (alive) setCap(c) })
      .catch(() => { if (alive) setCap({ allowed: false, namespace: '' }) })
    return () => { alive = false }
  }, [runner])

  const doRun = useCallback((r: RouteResult, k: string, req: InClusterTestRequest) => {
    if (!runner) return
    setTests((s) => ({ ...s, [k]: { state: 'running' } }))
    // For a cross-namespace backend (Gateway API backendRef into another namespace)
    // the bare "name:port" resolves in the probe pod's OWN namespace → wrong Service
    // or NXDOMAIN. Dial an FQDN (name.ns.svc:port) so it resolves the intended
    // Service regardless of the host guess (which the user can clear). Mirrors the
    // Go fqdnDialTarget.
    const dialTarget = inClusterDialTarget(r.target || r.route, r.targetNamespace, trace.subject.namespace)
    runner.run({ target: dialTarget, scheme: req.scheme, host: req.host || undefined, path: req.path })
      .then((res) => setTests((s) => ({ ...s, [k]: res.results && res.results.length ? { state: 'done', results: res.results! } : { state: 'error', error: res.error, fallbackCommand: res.fallbackCommand } })))
      .catch((e: unknown) => setTests((s) => ({ ...s, [k]: { state: 'error', error: e instanceof Error ? e.message : String(e) } })))
  }, [runner, trace.subject.namespace])

  if (routes.length === 0 && notTested.length === 0) return null
  const sorted = [...routes].sort((a, b) => routeOutcomeRank(a.outcome) - routeOutcomeRank(b.outcome))
  const keyFor = (r: RouteResult, i: number) => subjectKey + '|' + r.route + ':' + (r.target ?? '') + ':' + i
  const onTest = (r: RouteResult, k: string, req: InClusterTestRequest) => {
    if (sessionSkipInClusterConsent) doRun(r, k, req)
    else { setDontAsk(false); setConsent({ route: r, key: k, req }) }
  }

  const renderRow = (r: RouteResult, i: number) => {
    const k = keyFor(r, i)
    return (
      <div key={k} className="flex items-start gap-2 text-sm">
        <span className="mt-1 shrink-0" aria-hidden><StatusDot tone={routeTone(r)} size="sm" /></span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-mono break-all text-theme-text-primary">{r.route}</span>
            {r.target && <span className="text-theme-text-tertiary break-all">→ {r.target}</span>}
            <Badge severity={routeBadgeSeverity(r)} size="sm">{routeOutcomeLabel(r)}</Badge>
            {r.confidence === 'indirect' && (
              <Tooltip content={<span className="block max-w-xs leading-snug">Reached through the Kubernetes API server proxy - proves a pod answers, not that in-cluster workload-to-pod traffic takes this path</span>} position="bottom">
                <Badge severity="info" size="sm">from Radar</Badge>
              </Tooltip>
            )}
          </div>
          {r.evidence && <div className="text-[11px] text-theme-text-tertiary break-words">{r.evidence}</div>}
          {(r.localization ?? []).map((f, j) => (
            <div key={j} className="text-[11px] text-theme-text-tertiary break-words">
              ↳ behind it: {f.layer?.toUpperCase()} {f.target} {f.ok ? 'ok' : 'failed'}{f.detail ? ' · ' + f.detail : ''}
            </div>
          ))}
          {runner && inClusterEligible(r) && <InClusterAffordance route={r} cap={cap} test={tests[k]} onTest={(req) => onTest(r, k, req)} />}
        </div>
      </div>
    )
  }

  // collapseHealthy (the Tree redesign): lead with the breaks, fold reachable
  // routes behind a "N routes reachable" disclosure so a glance shows the problem.
  const isOpen = (r: RouteResult) => !r.benign && (r.outcome === 'unreachable' || r.outcome === 'server-error')
  const openRows = sorted.filter(isOpen)
  const foldedRows = sorted.filter((r) => !isOpen(r))

  return (
    <section>
      <SectionHeader title="Reachability" subtitle="What we tested, and what we couldn't" />
      {sorted.length > 0 && (collapseHealthy ? (
        <div className="flex flex-col gap-1.5">
          {openRows.map((r) => renderRow(r, sorted.indexOf(r)))}
          {foldedRows.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer select-none text-theme-text-secondary hover:text-theme-text-primary">
                {foldedRows.length} route{foldedRows.length === 1 ? '' : 's'} reachable
              </summary>
              <div className="flex flex-col gap-1.5 mt-1.5">
                {foldedRows.map((r) => renderRow(r, sorted.indexOf(r)))}
              </div>
            </details>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {sorted.map((r, i) => renderRow(r, i))}
        </div>
      ))}
      {notTested.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="text-[11px] uppercase tracking-wide text-theme-text-tertiary">Not tested — we won't say these pass or fail</div>
          {notTested.map((s, i) => (
            <CoverageSkipRow key={(s.route ?? '') + ':' + i} skip={s} />
          ))}
        </div>
      )}
      {consent && (
        <ConfirmDialog
          open
          variant="warning"
          title="Test from inside the cluster"
          message={`Radar will run a short-lived probe pod in namespace "${cap?.namespace || consent.route.route}"${cap?.cluster ? ` on cluster "${cap.cluster}"` : ''}, as you — then delete it (~5s).`}
          details="The pod is non-root, has no privileges and no service-account token. It runs `radar probe` against this route over the real in-cluster network path, then self-destructs."
          confirmLabel="Run"
          cancelLabel="Cancel"
          onClose={() => setConsent(null)}
          onConfirm={() => { if (dontAsk) sessionSkipInClusterConsent = true; const c = consent; setConsent(null); if (c) doRun(c.route, c.key, c.req) }}
        >
          <label className="flex items-center gap-2 text-xs text-theme-text-secondary mt-2 cursor-pointer">
            <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
            Don't ask again this session
          </label>
        </ConfirmDialog>
      )}
    </section>
  )
}

// CoverageSummary is the compact, ALWAYS-VISIBLE counts strip that sits ABOVE the
// persistent path. It states the verified / reached-via-proxy / failed / not-tested
// tallies in one line so a glance gives the headline, while the path below keeps every
// hop's config + live probe outcome inline. It renders no per-route rows and collapses
// nothing, so the path is always visible rather than hidden behind a fold.
// JustTestedNote shows a brief "✓ updated just now" next to the verdict whenever a
// test completes, giving closure even when the result is identical to the prior run (a
// fast probe otherwise looks like nothing happened, since only the button moved). Driven
// by a run nonce the host bumps on every completed run, so it fires even with no value change.
function useFreshFlag(nonce?: number): boolean {
  const [fresh, setFresh] = useState(false)
  const prev = useRef<number | undefined>(nonce)
  useEffect(() => {
    if (prev.current !== undefined && nonce !== prev.current) {
      setFresh(true)
      const t = setTimeout(() => setFresh(false), 2600)
      prev.current = nonce
      return () => clearTimeout(t)
    }
    prev.current = nonce
  }, [nonce])
  return fresh
}
export function JustTestedNote({ nonce }: { nonce?: number }) {
  const fresh = useFreshFlag(nonce)
  if (!fresh) return null
  return (
    <span className="ml-2 inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium text-accent-text" style={{ backgroundColor: 'var(--accent-muted)' }}>
      ✓ updated just now
    </span>
  )
}

// ReachActions is the verdict card's action area: the primary "Run reachability
// test" (proxy/laptop vantage) plus, once allowed, the secondary "Test inside the
// cluster" (real pod-to-pod) — one grouped control instead of two split corners.
// Uses the design-system button classes (.btn-brand / .btn-brand-muted).
// VerdictCaveat renders the verdict's muted second line: a short one-liner on
// screen, with the full explanation tucked into the project Tooltip behind an
// info icon — so a long "why + how to fix" never bloats the banner into a wall
// of text. Shared by the Diagram + Tree banners so they stay in parity.
export function VerdictCaveat({ caveat, detail }: { caveat?: string; detail?: string }) {
  if (!caveat) return null
  return (
    <div className="text-xs text-theme-text-tertiary mt-0.5 flex items-start gap-1">
      <span className="min-w-0">{caveat}</span>
      {detail ? (
        <Tooltip content={<span className="block max-w-xs leading-snug">{detail}</span>} position="bottom">
          <Info className="w-3.5 h-3.5 mt-px shrink-0 cursor-help text-theme-text-tertiary hover:text-theme-text-secondary" aria-label="More detail" />
        </Tooltip>
      ) : null}
    </div>
  )
}

// RequestIndicator names the exact HTTP request the probes made — shown in the
// verdict bar (always visible after a run) so the operator knows what was tested. A
// pencil toggles an inline editor so the path is changeable in place (no digging
// through the ⋯ menu); Enter or blur applies + re-runs, Escape cancels. Default GET /.
export function RequestIndicator({ path, onApplyProbePath }: { path?: string; onApplyProbePath?: (p: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(path ?? '/')
  useEffect(() => { setDraft(path ?? '/') }, [path])
  const apply = () => {
    const t = draft.trim()
    onApplyProbePath?.(!t ? '/' : t.startsWith('/') ? t : '/' + t)
    setEditing(false)
  }
  if (editing) {
    return (
      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-theme-text-tertiary">
        <span>tested with <span className="font-mono text-theme-text-secondary">GET</span></span>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') apply(); else if (e.key === 'Escape') { setDraft(path ?? '/'); setEditing(false) } }}
          onBlur={apply}
          placeholder="/"
          className="w-36 rounded border border-theme-border bg-theme-base px-1.5 py-0.5 font-mono text-[11px] text-theme-text-primary"
        />
        <span>↵ applies · esc cancels</span>
      </div>
    )
  }
  return (
    <div className="mt-1 flex items-center gap-1 text-[11px] text-theme-text-tertiary">
      <span>tested with <span className="font-mono text-theme-text-secondary">GET {path || '/'}</span></span>
      {onApplyProbePath && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Edit the request path"
          aria-label="Edit the request path"
          className="rounded p-0.5 text-theme-text-tertiary transition-colors hover:bg-theme-hover hover:text-theme-text-secondary"
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}

// ProbeOptionsMenu is the "⋯ more options" overflow next to the run buttons —
// keeps the verdict bar clean and gives a home for power options. Today its one
// item is "Customize what we test…", which opens a small form to change the HTTP
// path the probes request (default "/"). Applies to BOTH tests.
function ProbeOptionsMenu({ probePath, onApplyProbePath }: { probePath?: string; onApplyProbePath?: (p: string) => void }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(probePath ?? '/')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { setDraft(probePath ?? '/') }, [probePath])
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setEditing(false) } }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  if (!onApplyProbePath) return null
  const apply = () => {
    const t = draft.trim()
    onApplyProbePath(!t ? '/' : t.startsWith('/') ? t : '/' + t)
    setOpen(false); setEditing(false)
  }
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} title="More options" aria-label="More options" className="btn-brand-muted px-1.5 py-1 text-xs">
        <MoreHorizontal className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 mt-1 z-20 w-72 rounded-lg border border-theme-border bg-theme-surface shadow-theme-lg p-1 text-xs">
          {!editing ? (
            <button type="button" onClick={() => setEditing(true)} className="w-full text-left px-2 py-1.5 rounded hover:bg-theme-hover flex items-center gap-2 text-theme-text-primary">
              <Pencil className="w-3.5 h-3.5 shrink-0" /> Customize what we test…
            </button>
          ) : (
            <div className="p-1.5 flex flex-col gap-2">
              <div className="text-[10px] uppercase tracking-wide text-theme-text-tertiary">What to test</div>
              <label className="text-theme-text-secondary">HTTP path to request</label>
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') apply(); if (e.key === 'Escape') { setOpen(false); setEditing(false) } }}
                placeholder="/"
                className="px-2 py-1 rounded border border-theme-border bg-theme-base font-mono text-theme-text-primary"
              />
              <div className="text-[11px] text-theme-text-tertiary">Method GET. Applies to the reachability + in-cluster test.</div>
              <div className="flex items-center justify-between pt-0.5">
                <button type="button" onClick={() => setDraft('/')} className="text-theme-text-tertiary hover:text-theme-text-primary">Reset to /</button>
                <button type="button" onClick={apply} className="btn-brand px-2.5 py-1 inline-flex items-center gap-1.5"><RefreshCw className="w-3 h-3" /> Apply &amp; run</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ReachActions({ onRunProbes, probeRequested, probed, onRunInCluster, inClusterRunning, inClusterAllowed, inClusterTested, probePath, onApplyProbePath }: {
  onRunProbes?: () => void
  probeRequested?: boolean
  // probed/inClusterTested: each test has already produced a result, so its
  // button is a RE-RUN — labeled and iconed accordingly. The control set itself
  // never changes (consistency): both tests stay available to re-run whenever
  // they apply. They auto-run on load, so they're almost always re-runs.
  probed?: boolean
  onRunInCluster?: () => void
  inClusterRunning?: boolean
  inClusterAllowed?: boolean
  inClusterTested?: boolean
  probePath?: string
  onApplyProbePath?: (p: string) => void
}) {
  // The in-cluster test stays available whenever the cluster allows it — NEVER
  // gated on the verdict. Hiding it after it succeeds (when the verdict turns
  // healthy) is exactly when an operator wants to re-run it after a change.
  const showInCluster = !!(inClusterAllowed && onRunInCluster)
  if (!onRunProbes && !showInCluster) return null
  return (
    <div className="flex shrink-0 items-center gap-2">
      {/* Secondary: the in-cluster Job (real pod-to-pod traffic) — a real button
          (it mutates: spawns a Job), clearly subordinate to the primary, with an
          in-cluster glyph so it's distinguishable without hover. */}
      {showInCluster && (
        <button
          type="button"
          onClick={onRunInCluster}
          disabled={inClusterRunning}
          title="Run the probe from a short-lived Job INSIDE the cluster — real pod-to-pod traffic — to confirm the in-cluster data path"
          className="btn-brand-muted px-2.5 py-1 text-xs inline-flex items-center gap-1.5"
        >
          {inClusterRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Network className="w-3 h-3" />}
          {inClusterRunning ? 'Running in-cluster test…' : inClusterTested ? 'Re-run in-cluster' : 'Test in-cluster'}
        </button>
      )}
      {/* Primary: the reachability test. The refresh icon signals it's
          re-runnable (it auto-ran on load), so re-running reads as a refresh. */}
      {onRunProbes && (
        <button type="button" onClick={onRunProbes} disabled={probeRequested} className="btn-brand px-2.5 py-1 text-xs inline-flex items-center gap-1.5">
          {probeRequested ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          {probeRequested ? 'Testing…' : probed ? 'Re-run reachability test' : 'Run reachability test'}
        </button>
      )}
      {/* Overflow: customize what we test (path), room for more options later. */}
      <ProbeOptionsMenu probePath={probePath} onApplyProbePath={onApplyProbePath} />
    </div>
  )
}

export function CoverageSummary({ coverage, routes }: { coverage: Coverage; routes: RouteResult[] }) {
  // "verified" is reserved for a real-traffic VERIFIED route — never a mere "reached"
  // (server answered, exact route unproven) and never an indirect proxy result.
  const verified = routes.filter((r) => r.outcome === 'verified' && r.confidence === 'real').length
  const reached = routes.filter((r) => r.outcome === 'reached' && r.confidence === 'real').length
  // Reached via the proxy only — and ONLY count a positive outcome here, so an
  // indirect server-error isn't double-claimed as both "reached" and "failed".
  const viaProxy = routes.filter((r) => r.confidence === 'indirect' && (r.outcome === 'verified' || r.outcome === 'reached')).length
  // Split coverage.failed by KIND so the strip mirrors coverageBannerTone instead
  // of reddening everything: only a true (non-benign) unreachable is red; a 5xx
  // reached an erroring app (amber) and a benign scale-to-0 is deliberate dormancy
  // (amber). Lumping all into a red "failed" would false-condemn 5xx/dormancy.
  // Only a REAL-path unreachable is red. An apiserver-proxy-only (indirect)
  // unreachable never tested the real path, so it must not redden the count —
  // mirror coverageBannerTone's hardUnreach split (and every sibling helper that
  // treats indirect unreachable as non-red). Surface it as a neutral line instead.
  const unreachable = routes.filter((r) => r.outcome === 'unreachable' && !r.benign && r.confidence !== 'indirect').length
  const unreachIndirect = routes.filter((r) => r.outcome === 'unreachable' && !r.benign && r.confidence === 'indirect').length
  const serverError = routes.filter((r) => r.outcome === 'server-error').length
  const dormant = routes.filter((r) => r.benign).length
  const notTested = coverage.skipped
  const parts: { tone: StatusTone; text: string }[] = []
  if (verified) parts.push({ tone: 'healthy', text: `${verified} verified` })
  // A "reached" is server-answered but route-unverified — neutral, not green ✓
  // (green here overclaims verification; reserve healthy for 'verified').
  if (reached) parts.push({ tone: 'neutral', text: `${reached} reached` })
  if (viaProxy) parts.push({ tone: 'neutral', text: `${viaProxy} reached via ${API_PROXY_LABEL}` })
  if (unreachable) parts.push({ tone: 'unhealthy', text: `${unreachable} unreachable` })
  if (unreachIndirect) parts.push({ tone: 'neutral', text: `${unreachIndirect} unreachable via ${API_PROXY_LABEL}` })
  if (serverError) parts.push({ tone: 'degraded', text: `${serverError} server error` })
  if (dormant) parts.push({ tone: 'degraded', text: `${dormant} scaled to 0` })
  if (notTested) parts.push({ tone: 'unknown', text: `${notTested} not tested` })
  if (parts.length === 0) return null
  return (
    <div className="flex items-center gap-x-3 gap-y-1 flex-wrap rounded-lg border border-theme-border bg-theme-surface px-3 py-1.5 text-xs">
      <span className="font-medium text-theme-text-secondary">Coverage</span>
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-1.5 text-theme-text-primary">
          <StatusDot tone={p.tone} size="sm" />{p.text}
        </span>
      ))}
    </div>
  )
}

export function CoverageSkipRow({ skip }: { skip: RouteSkip }) {
  return (
    <div className="text-[11px] text-theme-text-secondary">
      <div className="flex items-start gap-1.5">
        <span aria-hidden>~</span>
        <span className="break-words">
          {skip.route && <span className="font-mono">{skip.route} </span>}
          {skip.reason}
        </span>
      </div>
      {skip.command && <CopyableCommand command={skip.command} />}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Upstreams — parallel hops INTO the subject
// ────────────────────────────────────────────────────────────────────────────

function UpstreamsBlock({ upstreams, onNavigate }: { upstreams: Hop[]; onNavigate?: (ref: ResourceRef) => void }) {
  const label = upstreams.length === 1 ? '1 parallel entry, judged independently' : `${upstreams.length} parallel entries, each judged independently`
  return (
    <section>
      <SectionHeader title="Upstreams" subtitle={label} />
      <div className="flex flex-col gap-2">
        {upstreams.map((hop, i) => (
          <HopRow key={hopKey(hop, i)} hop={hop} broken={false} compact upstream onNavigate={onNavigate} />
        ))}
      </div>
    </section>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Downstream — chain from subject toward pods
// ────────────────────────────────────────────────────────────────────────────

// degradeFocusIndex finds the hop a degraded verdict is about when the server
// left no brokenAt anchor — single-chain warnings, upstream-only warnings, and
// probe-induced 5xx all surface as degraded without one. Returns the first hop
// carrying a warning/critical finding or a non-skipped degraded/unhealthy
// probe; -1 when nothing on the downstream path explains it (an upstream-only
// cause has no downstream row to point at).
function degradeFocusIndex(downstream: Hop[], verdict: Verdict): number {
  if (verdict !== 'degraded') return -1
  for (let i = 0; i < downstream.length; i++) {
    const hop = downstream[i]
    if (hop.findings.some((f) => f.severity === 'warning' || f.severity === 'critical')) return i
    if ((hop.probes ?? []).some((p) => !p.skipped && (p.tone === 'degraded' || (!p.ok && p.tone === 'unhealthy')))) return i
  }
  return -1
}

export interface BackendRouteInfo {
  /** Route identities (path, or host+path on a multi-host Ingress) that select
   *  this backend, so a multi-backend path can show WHICH route hits each hop. */
  tags: string[]
  /** The Ingress names this backend in a route but the Service doesn't exist —
   *  the broken route in a partial-break path. */
  missing: boolean
}

// backendRouteInfo maps a downstream backend hop to the route(s) that select it,
// reading the entry hop's rule list. The host is included only when the Ingress
// serves more than one host, so two routes sharing path "/" on different hosts
// stay distinguishable (api.example.com/ vs admin.example.com/).
export function backendRouteInfo(entry: Hop | undefined, hop: Hop): BackendRouteInfo {
  const name = hop.resource.name
  if (!entry || !name || !hop.edge.endsWith('->Service')) return { tags: [], missing: false }
  const namespace = hop.resource.namespace
  const rules = entry.config?.rules ?? []
  const multiHost = (entry.config?.hostnames?.length ?? 0) > 1
  const tags: string[] = []
  for (const rule of rules) {
    // Match name AND namespace (a backendRef's namespace defaults to the entry's),
    // mirroring the Go side (missingRefMatchesBackend). Name-only would attach a
    // route's tags — and the "missing" flag — to a same-named Service in a DIFFERENT
    // namespace, false-condemning the wrong backend on a multi-namespace route.
    if (!(rule.backends ?? []).some((b) => b.name === name && (b.namespace ?? entry.resource.namespace) === namespace)) continue
    const paths = rule.paths?.length ? rule.paths : ['/']
    const hosts = rule.hosts ?? []
    for (const path of paths) {
      if (multiHost && hosts.length > 0) {
        for (const host of hosts) tags.push(routeLabel(host, path))
      } else {
        tags.push(routeLabel('', path))
      }
    }
  }
  // A reachable Service always carries a resolved config; a config-less backend
  // hop is a Service the Ingress names but the cluster doesn't have. Only flag
  // it when a route actually points here, so a transient gap isn't called missing.
  const missing = !hop.config && tags.length > 0
  return { tags: [...new Set(tags)], missing }
}

function routeLabel(host: string, path: string): string {
  if (path === '(default backend)') return host ? `${host} (default backend)` : 'default backend'
  return host ? `${host}${path}` : path
}

function DownstreamBlock({ subject, downstream, brokenAt, focusAt, onNavigate }: { subject: { kind: string; name: string; namespace?: string }; downstream: Hop[]; brokenAt: number; focusAt: number; onNavigate?: (ref: ResourceRef) => void }) {
  return (
    <section>
      <SectionHeader
        title="Path"
        subtitle="Top-to-bottom is the direction traffic flows."
      />
      <div className="relative">
        {/* Spine — the visual continuity that says "these hops are one chain" */}
        <div className="absolute left-[14px] top-2 bottom-2 w-px bg-theme-border" aria-hidden />
        <div className="flex flex-col gap-2">
          {downstream.map((hop, i) => (
            <HopRow
              key={hopKey(hop, i)}
              hop={hop}
              broken={brokenAt === i}
              focus={focusAt === i}
              isSubject={i === 0 && hop.resource.kind === subject.kind && hop.resource.name === subject.name}
              routeInfo={backendRouteInfo(downstream[0], hop)}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Hop row — one resource along the path
// ────────────────────────────────────────────────────────────────────────────

// Code prefix the server stamps on a finding that describes a route OTHER than
// the one reaching the current subject — a sibling backend of a shared entry
// that doesn't exist. The server already excludes these from an upstream's
// verdict (nonMissingRefFindings); the UI must scope the upstream row to match.
// Kept in sync with the Go constant by TestMissingRefPrefixMirrored.
const MISSING_REF_CODE_PREFIX = 'missing_ref:'

function HopRow({ hop, broken, focus, compact, isSubject, upstream, routeInfo, onNavigate }: { hop: Hop; broken: boolean; focus?: boolean; compact?: boolean; isSubject?: boolean; upstream?: boolean; routeInfo?: BackendRouteInfo; onNavigate?: (ref: ResourceRef) => void }) {
  // On an upstream entry, a missing-backend finding is about a sibling route,
  // not the path that reaches this subject (the subject is itself a live
  // backend of that entry, so it demonstrably exists). Scope the row — dot,
  // chip, auto-expand, body — to the subject-relevant findings so a healthy
  // subject doesn't wear a red chip for an unrelated broken route; surface the
  // sibling break as a muted note instead. Downstream rows keep every finding.
  const otherRouteFindings = upstream ? hop.findings.filter((f) => f.code.startsWith(MISSING_REF_CODE_PREFIX)) : []
  const findings = upstream ? hop.findings.filter((f) => !f.code.startsWith(MISSING_REF_CODE_PREFIX)) : hop.findings
  // The server sorts findings worst-first, so the first finding's severity
  // is the row's overall severity. No need for a TS-side dupe of the
  // server's worst-severity walk.
  const worstSev: FindingSeverity | '' = findings.length > 0 ? findings[0].severity : ''
  // focus is the row the verdict points at (a broken anchor, or the degrade
  // cause when there's no broken anchor). Either way it opens by default and
  // becomes the scroll target so the conclusion is never hidden behind a
  // collapsed row.
  const shouldAutoExpand = broken || focus || worstSev === 'critical'
  const [expanded, setExpanded] = useState<boolean>(shouldAutoExpand)
  // When a probe run upgrades a hop to broken/critical, auto-expand it so
  // the new finding isn't hidden behind a collapsed row. We never auto-
  // collapse — once the user opens a hop, it stays open until they close it.
  useEffect(() => {
    if (shouldAutoExpand) setExpanded(true)
  }, [shouldAutoExpand])
  const toggle = useCallback(() => setExpanded((e) => !e), [])
  const hopMeta = hopMetaSummary(hop)
  const hasFindings = findings.length > 0
  // A hop is navigable when the host provided a callback AND the row points
  // at one identifiable resource that is NOT the subject (clicking the
  // subject would navigate to the page the user is already on). Collection
  // hops (Pods fan-out, attached routes) carry an empty name and stay
  // non-clickable — there's no single resource for the host to open.
  const navigable = Boolean(onNavigate && hop.resource.name && !isSubject)
  // Row body navigates when there's a routable target; otherwise it falls
  // back to toggling the findings panel so collection hops stay useful.
  // Chevron is always toggle so the two gestures don't overload.
  const primary = navigable
    ? () => onNavigate!(hop.resource)
    : hasFindings ? toggle : undefined
  return (
    <div
      className={clsx(
        'relative transition-colors',
        broken && 'bg-red-500/5 -mx-2 px-2 rounded-md',
      )}
      data-broken-target={broken || focus ? 'true' : undefined}
    >
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={primary}
          className={clsx(
            'flex-1 min-w-0 flex items-start gap-2.5 py-1.5 text-left',
            primary && 'hover:bg-theme-hover rounded-md -mx-1 px-1',
            !primary && 'cursor-default',
          )}
          aria-label={navigable ? `Open ${hop.resource.kind} ${hop.resource.name}` : undefined}
          aria-expanded={primary === toggle ? expanded : undefined}
        >
          <span className="mt-1 shrink-0" aria-hidden>
            <StatusDot tone={severityToTone(worstSev)} size="sm" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <Badge kind={hop.resource.kind} size="sm">{hop.resource.kind}</Badge>
              <span className={clsx(
                'text-sm font-medium break-all text-theme-text-primary',
                navigable && 'hover:underline',
              )}>
                {hop.resource.name || hopFallbackLabel(hop)}
              </span>
              {hop.resource.namespace && (
                <span className="text-[11px] text-theme-text-tertiary break-all">in {hop.resource.namespace}</span>
              )}
              <SeverityChip severity={worstSev} count={findings.length} probes={hop.probes} />
              {routeInfo?.tags.map((tag) => (
                <Badge key={tag} severity="neutral" size="sm" title={`Reached by Ingress route ${tag}`}>{tag}</Badge>
              ))}
              {routeInfo?.missing && (
                <Badge severity="warning" size="sm" title="An Ingress route names this Service, but it doesn't exist in the cluster">not found</Badge>
              )}
            </div>
            {!compact && (
              <>
                {(!isSubject || hopMeta) && (
                  <div className="text-[11px] text-theme-text-tertiary mt-0.5 flex items-center gap-1.5 flex-wrap">
                    <Network className="w-3 h-3" />
                    {!isSubject && <span>{prettyEdge(hop.edge, isSubject)}</span>}
                    {!isSubject && hopMeta && <span aria-hidden>·</span>}
                    {hopMeta && <span>{hopMeta}</span>}
                  </div>
                )}
                {hop.config && <ConfigPills config={hop.config} hopKind={hop.resource.kind} />}
              </>
            )}
          </div>
        </button>
        {hasFindings && navigable && (
          <button
            type="button"
            onClick={toggle}
            className="shrink-0 px-2.5 flex items-center text-theme-text-tertiary hover:bg-theme-hover hover:text-theme-text-primary rounded-r-md border-l border-theme-border"
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide findings' : 'Show findings'}
            title={expanded ? 'Hide findings' : 'Show findings'}
          >
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        )}
        {hasFindings && !navigable && (
          <span className="shrink-0 px-2.5 flex items-center text-theme-text-tertiary" aria-hidden>
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </span>
        )}
      </div>
      {expanded && findings.length > 0 && (
        <div className="border-t border-theme-border px-3 py-2 flex flex-col gap-2">
          {findings.map((f, i) => (
            <FindingRow key={f.code + ':' + i} finding={f} onNavigate={onNavigate} />
          ))}
        </div>
      )}
      {otherRouteFindings.length > 0 && (
        <div className="px-3 py-1.5 flex flex-col gap-1">
          {otherRouteFindings.map((f, i) => (
            <div key={f.code + ':' + i} className="text-[11px] text-theme-text-tertiary flex items-start gap-1.5">
              <span aria-hidden>↳</span>
              <span>Another route on this {hop.resource.kind} is broken: {f.message}</span>
            </div>
          ))}
        </div>
      )}
      {hop.probes && hop.probes.length > 0 && (
        <ProbeRows probes={hop.probes} />
      )}
    </div>
  )
}

// ProbeRows renders each probe result as an inline list row under the hop.
// The row carries everything an operator needs: severity dot, target,
// optional path label (when the probe traversed the API server, knowing
// that path is part of the answer), latency, status, and any error text.
// No diagram — the hop above is already the visual anchor.
function ProbeRows({ probes }: { probes: ProbeResult[] }) {
  // Failures first, then OK rows, then skipped — matches the operator's
  // scan priority. Same comparator the per-hop findings use. Skip rows
  // with identical (layer, path, reason) are collapsed into one row with
  // a count suffix so a 3-pod × 1-port Pods hop doesn't repeat the same
  // "non-HTTP port" line three times.
  const display = useMemo(() => {
    const sorted = [...probes].sort((a, b) => probeRank(a) - probeRank(b))
    return collapseSkipRows(sorted)
  }, [probes])
  return (
    <ul className="mt-2 pl-4 border-l border-theme-border ml-1 flex flex-col gap-1">
      {display.map((p, i) => <ProbeRow key={i} probe={p} />)}
    </ul>
  )
}

// probeRank orders probes for display: unreachable first (most actionable),
// then server-error (5xx), then reached-but-unverified (3xx/4xx), then
// verified, then skipped last. Falls back to the binary ok+skipped split when
// tone is unset.
function probeRank(p: ProbeResult): number {
  if (p.skipped) return 4
  if (p.tone === 'unhealthy' || !p.ok) return 0
  if (p.tone === 'degraded') return 1
  if (p.tone === 'reached') return 2
  return 3
}

// probeToneToStatus maps the probe's honest reachability tone onto the shared
// StatusTone vocabulary. 'reached' (3xx/4xx — got a server but didn't verify
// the route) renders as the calm 'neutral', never green-verified nor amber.
export function probeToneToStatus(p: ProbeResult): StatusTone {
  switch (p.tone) {
    case 'reached': return 'neutral'
    case 'healthy': return 'healthy'
    case 'degraded': return 'degraded'
    case 'unhealthy': return 'unhealthy'
    default: return p.skipped ? 'unknown' : p.ok ? 'healthy' : 'unhealthy'
  }
}

function ProbeRow({ probe }: { probe: ProbeResult }) {
  const tone: StatusTone = probeToneToStatus(probe)
  return (
    <li className="flex items-start gap-2 text-[11px]">
      <span className="mt-1 shrink-0" aria-hidden><StatusDot tone={tone} size="sm" /></span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 flex-wrap text-theme-text-primary">
          <span className="font-mono break-all">{probe.target || probe.layer.toUpperCase()}</span>
          {probePathLabel(probe) && (
            <span className="text-theme-text-tertiary">· {probePathLabel(probe)}</span>
          )}
          {typeof probe.latencyNs === 'number' && probe.latencyNs > 0 && !probe.skipped && (
            <span className="text-theme-text-tertiary">· {formatProbeLatency(probe.latencyNs)}</span>
          )}
          {probe.detail && !probe.skipped && (
            <span className="text-theme-text-tertiary break-words">· {probe.detail}</span>
          )}
        </div>
        {probe.skipped && probe.reason && (
          <div className="text-theme-text-tertiary italic break-words">skipped: {probe.reason}</div>
        )}
        {probe.command && (
          <>
            <div className="text-[11px] text-theme-text-secondary mt-0.5">Test it yourself — run:</div>
            <CopyableCommand command={probe.command} />
          </>
        )}
        {probe.error && !probe.skipped && (
          <div className="text-red-500 break-words">{probe.error}</div>
        )}
      </div>
    </li>
  )
}

// probePathLabel surfaces the path discriminator in operator language. The
// data path is the real workload route, so it gets a callout that names
// what a success there actually proves. The API path callout names what a
// success there does NOT prove, so the operator doesn't over-read the result.
function probePathLabel(p: ProbeResult): string {
  // The data path is "pod-to-pod" only when it ran from INSIDE the cluster; a laptop
  // dialing directly (e.g. an ExternalName host) is a direct external reach, NOT
  // in-cluster pod-to-pod — labeling it so would over-claim.
  if (p.path === 'data') return p.vantage === 'in-cluster' ? 'pod-to-pod path' : 'direct'
  // The apiserver-proxy vantage is already named on the hop's outcome chip
  // ("verified via API server"); repeating it on every probe row is noise. Keep the
  // row's load-bearing extras (latency + status) only.
  return ''
}

function formatProbeLatency(ns: number): string {
  const ms = ns / 1_000_000
  if (ms >= 100) return `${ms.toFixed(0)}ms`
  return `${ms.toFixed(1)}ms`
}

// ReachabilitySection is the operator's affordance for "send live traffic
// against the declared path and tell me what happened". It only renders
// the button when at least one hop has a probeable surface; for traces
// whose only hops are routes-without-addresses or headless services we
// explain why instead of pretending the button works. Feasibility is
// computed from each hop's HopConfig — see probeFeasibility().
function ReachabilitySection({
  feasibility,
  probesPresent,
  liveEvidence,
  isLoading,
  requested,
  onRun,
}: {
  feasibility: ProbeFeasibility
  probesPresent: boolean
  liveEvidence: boolean
  isLoading: boolean
  requested: boolean
  onRun: () => void
}) {
  const running = requested && !probesPresent && isLoading
  // A run completed but no probe landed live (every row skipped) — the laptop
  // default without services/proxy RBAC. The loud brand button over-promised;
  // downgrade it and point at the in-cluster test, which probes the real path.
  const limited = probesPresent && !liveEvidence && !running

  if (!feasibility.probeable && !probesPresent) {
    return (
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-medium text-theme-text-secondary">Reachability test</span>
        <span className="text-theme-text-tertiary">not applicable. {feasibility.reason}</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-theme-text-secondary">Reachability test</span>
      <span className="text-xs text-theme-text-tertiary flex-1 truncate">
        {limited
          ? 'Probes from here were limited — every check skipped. Use the in-cluster test for the real path.'
          : probesPresent
            ? 'Results shown beneath each hop.'
            : running
              ? 'Running…'
              : ''}
      </span>
      <button
        type="button"
        onClick={onRun}
        disabled={isLoading}
        className={clsx(
          'shrink-0 text-xs px-3 py-1 flex items-center gap-1.5',
          limited
            ? 'rounded border border-theme-border text-theme-text-secondary hover:bg-theme-hover transition-colors'
            : 'btn-brand',
          isLoading && 'opacity-50 cursor-not-allowed',
        )}
      >
        <span
          className={clsx(
            'w-1.5 h-1.5 rounded-full',
            running ? 'bg-amber-300 animate-pulse' : limited ? 'bg-theme-text-tertiary' : 'bg-white/80',
          )}
          aria-hidden
        />
        {limited ? 'Run again' : 'Run reachability test'}
      </button>
    </div>
  )
}

interface ProbeFeasibility {
  probeable: boolean
  reason: string
}

// probeFeasibility decides whether any hop in the trace has a surface a
// reachability probe could target. The logic mirrors the kinds runProbes
// supports, but stays in the UI so the server doesn't have to ship a
// prediction the UI is the only consumer of. Matches the hop kinds in
// internal/trace/probes.go probeHop().
function probeFeasibility(hops: Hop[]): ProbeFeasibility {
  let reason = 'no reachable surface declared for this resource.'
  for (const hop of hops) {
    const cfg = hop.config
    if (!cfg) continue
    switch (hop.resource.kind) {
      case 'Service':
        // Headless Services (clusterIP === 'None') still resolve probes via
        // the apiserver proxy when a client is available. The backend runs
        // the same ladder; the "headless" tag is informational, not a gate.
        if ((cfg.ports?.length ?? 0) > 0) return { probeable: true, reason: '' }
        break
      case 'Pods':
        if ((cfg.containerPorts?.length ?? 0) > 0 && ((cfg.podIPs?.length ?? 0) > 0 || (cfg.podNames?.length ?? 0) > 0)) {
          return { probeable: true, reason: '' }
        }
        if ((cfg.containerPorts?.length ?? 0) > 0) {
          reason = 'no ready pods to probe.'
        }
        break
      case 'Ingress':
        if ((cfg.hostnames?.length ?? 0) > 0) return { probeable: true, reason: '' }
        reason = 'this Ingress declares no hostnames; there\'s no target to probe.'
        break
      case 'Gateway':
        if ((cfg.addresses?.length ?? 0) > 0 && (cfg.listeners?.length ?? 0) > 0) {
          return { probeable: true, reason: '' }
        }
        if ((cfg.addresses?.length ?? 0) === 0) {
          reason = 'this Gateway has no programmed addresses yet; probes would have no target.'
        }
        break
      case 'HTTPRoute':
      case 'GRPCRoute':
        reason = 'routes have no own routable address; reachability lives on the parent Gateway and the backend Service.'
        break
    }
  }
  return { probeable: false, reason }
}

// ────────────────────────────────────────────────────────────────────────────
// Config pills — declared shape per hop (ports, hostnames, listeners)
// ────────────────────────────────────────────────────────────────────────────

/**
 * ConfigPills renders the hop's declared-config shape as a row of compact
 * pills. The rule of thumb: surface what the operator needs to *reason*
 * about traffic at this hop (ports, hostnames, listeners) without
 * duplicating data already in the resource's own page.
 *
 * Noise control:
 *   - Pills are filtered to ≤6 visible; the rest collapse into "+N more".
 *   - Long hostname lists collapse to first + count.
 *   - Selector is omitted from the pill strip (always available in the
 *     kubectl reproducer command instead).
 */
function ConfigPills({ config, hopKind }: { config: HopConfig; hopKind: string }) {
  const pills: { key: string; text: string; tone?: 'muted' | 'accent'; title?: string }[] = []

  if (config.serviceType && hopKind === 'Service') {
    pills.push({ key: 'svctype', text: config.serviceType, tone: 'accent' })
  }
  if (config.clusterIP && config.clusterIP !== '' && hopKind === 'Service') {
    if (config.clusterIP === 'None') {
      pills.push({ key: 'headless', text: 'headless', tone: 'muted' })
    }
  }

  for (const p of config.ports ?? []) {
    const label = p.name ? `${p.name} ` : ''
    const proto = p.protocol && p.protocol !== 'TCP' ? `/${p.protocol}` : ''
    pills.push({
      key: `port:${p.name || p.port}`,
      text: `${label}${p.port} → :${p.targetPort ?? p.port}${proto}`,
      title: `Service port ${p.port}${p.name ? ` (${p.name})` : ''} routes to targetPort ${p.targetPort ?? p.port}${proto}`,
    })
  }

  for (const cp of config.containerPorts ?? []) {
    const namePart = cp.name ? `${cp.name}:` : ''
    pills.push({
      key: `cp:${cp.container}:${cp.port}`,
      text: `${cp.container} ${namePart}${cp.port}`,
      tone: 'muted',
      title: `Container ${cp.container} exposes ${cp.name ? `named port "${cp.name}" → ` : ''}${cp.port}${cp.protocol ? '/' + cp.protocol : ''}`,
    })
  }

  for (const pr of config.probes ?? []) {
    if (!pr.port && !pr.path) continue
    const portPart = pr.port ? `:${pr.port}` : ''
    const pathPart = pr.path && pr.path !== '/' ? pr.path : ''
    pills.push({
      key: `probe:${pr.container}:${pr.type}`,
      text: `${pr.type === 'readiness' ? 'readiness' : 'liveness'} ${pr.scheme ?? 'HTTP'}${portPart}${pathPart}`,
      tone: 'muted',
      title: `${pr.container} ${pr.type} probe via ${pr.scheme ?? 'HTTP'}${portPart}${pathPart || ''}`,
    })
  }

  for (const host of config.hostnames ?? []) {
    pills.push({ key: `host:${host}`, text: host, tone: 'accent', title: `Hostname: ${host}` })
  }

  for (const l of config.listeners ?? []) {
    const proto = l.protocol ?? 'TCP'
    const host = l.hostname ? ` ${l.hostname}` : ''
    pills.push({
      key: `listener:${l.name || l.port}`,
      text: `${proto}:${l.port}${host}`,
      tone: 'accent',
      title: `Gateway listener${l.name ? ` "${l.name}"` : ''}: ${proto} on port ${l.port}${host}`,
    })
  }

  for (const addr of config.addresses ?? []) {
    pills.push({ key: `addr:${addr}`, text: `@${addr}`, tone: 'accent', title: 'Entry address — where clients connect to reach this' })
  }

  // Who serves this Ingress (the ingress controller) — a quiet muted pill on the
  // healthy path; the tooltip carries the gloss + shared-infra + readiness. A
  // controller PROBLEM (none/unready) comes through as a finding instead.
  if (config.servedBy) {
    pills.push({ key: 'servedby', text: config.servedBy, tone: 'muted', title: config.servedByTitle || config.servedBy })
  }

  // Route rules become a single compact "N paths → X backends" pill — the
  // detail expands into a per-rule list below (see ConfigRules).
  if (config.rules && config.rules.length > 0) {
    const total = config.rules.reduce((n, r) => n + (r.backends?.length ?? 0), 0)
    pills.push({
      key: 'rules',
      text: `${config.rules.length} rule${config.rules.length > 1 ? 's' : ''} → ${total} backend${total === 1 ? '' : 's'}`,
      tone: 'muted',
    })
  }

  if (pills.length === 0) return null

  const limit = 6
  const visible = pills.slice(0, limit)
  const overflow = pills.length - limit

  return (
    <div className="mt-1 flex items-center gap-1 flex-wrap">
      {visible.map((p) => (
        <Badge
          key={p.key}
          size="sm"
          severity={p.tone === 'accent' ? 'info' : 'neutral'}
          className="font-mono"
          title={p.title}
        >
          {p.text}
        </Badge>
      ))}
      {overflow > 0 && (
        <Badge size="sm" severity="neutral" title={`${overflow} additional details elided to keep the trace readable`}>
          +{overflow} more
        </Badge>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Finding row — single observation + copyable kubectl
// ────────────────────────────────────────────────────────────────────────────

// CopyableCommand renders a one-line command in a mono box with a copy
// button. Used both for finding reproducers and for the inline "fill the gap
// yourself" affordance when the tool honestly can't verify something (wildcard
// host, regex path): the worst acceptable case is handing the user exactly
// what to run.
function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = useCallback(() => {
    void navigator.clipboard.writeText(command)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [command])
  return (
    <div className="mt-1.5 flex items-center gap-2 bg-theme-base rounded px-2 py-1 font-mono text-[11px] text-theme-text-secondary group">
      <code className="flex-1 truncate" title={command}>{command}</code>
      <button
        type="button"
        onClick={onCopy}
        className="shrink-0 text-theme-text-tertiary hover:text-theme-text-primary"
        aria-label="Copy command"
        title={copied ? 'Copied!' : 'Copy'}
      >
        {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
      </button>
    </div>
  )
}

export function FindingRow({ finding, onNavigate }: { finding: Finding; onNavigate?: (ref: ResourceRef) => void }) {
  // When the detector parsed a domain-specific cause, lead with it — that's
  // the "why" the operator needs first. The raw detector message stays
  // visible below as secondary evidence. Without a parsed cause, message
  // is the primary line as before.
  const primary = finding.cause || finding.message
  const secondary = finding.cause && finding.message && finding.message !== finding.cause ? finding.message : ''
  // When the finding names a SPECIFIC culprit resource (e.g. the one crashing
  // Pod behind a Service's "0 ready" symptom), the operator's real next move is
  // to open that resource and read its logs/events — not to paste a describe.
  // Offer the click-through as the primary action; keep the command as the
  // terminal/CI fallback below it.
  const culprit = finding.resource?.name ? finding.resource : undefined
  return (
    <div className="flex gap-2.5 items-start">
      <span className="mt-1 shrink-0" aria-hidden><StatusDot tone={severityToTone(finding.severity)} size="sm" /></span>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-theme-text-primary">{primary}</div>
        {secondary && (
          <div className="text-[11px] text-theme-text-tertiary mt-0.5">{secondary}</div>
        )}
        {finding.chips && finding.chips.length > 0 && (
          <div className="mt-1 flex items-center gap-1 flex-wrap">
            {finding.chipsLabel && (
              <span className="text-[11px] text-theme-text-tertiary mr-0.5">{finding.chipsLabel}:</span>
            )}
            {finding.chips.map((c, i) => (
              <Badge
                key={i}
                size="sm"
                severity={c.tone === 'accent' ? 'info' : 'neutral'}
                title={c.title}
              >
                {c.text}
              </Badge>
            ))}
          </div>
        )}
        {finding.chipNotes?.map((n, i) => (
          <div key={i} className="text-[11px] text-theme-text-tertiary mt-0.5">{n}</div>
        ))}
        {finding.action && (
          <div className="text-[11px] text-theme-text-secondary mt-0.5">
            <span className="font-medium">Next step:</span> {finding.action}
          </div>
        )}
        {finding.remediation && !finding.action && (
          <div className="text-[11px] text-theme-text-tertiary mt-0.5">{finding.remediation}</div>
        )}
        {culprit && onNavigate && (
          <button
            type="button"
            onClick={() => onNavigate(culprit)}
            className="mt-1 inline-flex items-center gap-1 text-[11px] text-theme-accent hover:underline"
          >
            Open {culprit.kind} {culprit.name} ↗
          </button>
        )}
        {finding.command && <CopyableCommand command={finding.command} />}
      </div>
      {/* The finding code is a stable identifier for agents/MCP, not operator
          copy — rendering the raw truncated enum (e.g. "PROBLEM:COMPLETED")
          leaks internals and misleads (it read as "success" next to a critical).
          Keep it as a hover title only. */}
      <span className="shrink-0 w-0 overflow-hidden" title={`code: ${finding.code}`} aria-hidden />
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Small UI primitives — local, scoped to this panel
// ────────────────────────────────────────────────────────────────────────────

// SectionHeader is local for trace's flat top-level sections (Upstreams,
// Path). Matches the visual weight of `Section` titles elsewhere in the
// drawer (text-sm font-medium text-theme-text-secondary) without the
// collapsible affordance — the trace's sections always stay open.
function SectionHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <h3 className="text-sm font-medium text-theme-text-secondary">{title}</h3>
      {subtitle && <span className="text-xs text-theme-text-tertiary flex-1 truncate">{subtitle}</span>}
      {action}
    </div>
  )
}

// sampledFraction reads the "sampled N of M ready pods" skip row that the
// probe layer emits when the pod sample is truncated below the captured
// pool, returning (N, M) so the chip can label coverage honestly. The
// regex anchors on the full "ready pods" suffix so an unrelated skip
// such as "sampled 1 of 3 listeners" can't feed pod counts into a chip
// whose tooltip names pods.
function sampledFraction(probes?: ProbeResult[]): { sampled: number; total: number } | null {
  for (const p of probes ?? []) {
    if (!p.skipped || !p.reason) continue
    const m = /^sampled (\d+) of (\d+) ready pods/.exec(p.reason)
    if (m) return { sampled: Number(m[1]), total: Number(m[2]) }
  }
  return null
}

// probeChipFor builds the single most honest probe-state chip for a hop, or
// null when no live probe ran. The ordering is by actionability, and the
// labels never overclaim: only an all-2xx hop earns "verified"; a 3xx/4xx hop
// reached a server but did not verify the route, so it reads "reached"; a 5xx
// hop reads "server error" (reached, erroring — not unreachable); a transport
// failure reads "unreachable". apiserver-only success is labeled partial
// because the in-cluster data path was never exercised.
function probeChipFor(probes?: ProbeResult[]): React.ReactNode {
  const real = probes?.filter(p => !p.skipped) ?? []
  if (real.length === 0) return null
  const failed = real.filter(p => !p.ok || p.tone === 'unhealthy').length      // transport
  const serverErr = real.filter(p => p.ok && p.tone === 'degraded').length     // 5xx
  const reached = real.filter(p => p.ok && p.tone === 'reached').length        // 3xx/4xx
  const sample = sampledFraction(probes)
  if (failed > 0) {
    return <Badge severity="warning" size="sm" title={`${failed} of ${real.length} probes could not reach the target (transport failure)`}>{failed === real.length ? 'unreachable' : `${failed}/${real.length} unreachable`}</Badge>
  }
  if (serverErr > 0) {
    return <Badge severity="warning" size="sm" title={`${serverErr} of ${real.length} probes reached the server but it answered 5xx`}>server error</Badge>
  }
  if (reached > 0) {
    // Reached an HTTP server but did not verify the route/auth (e.g. probed
    // `/` on a path-routed app, or a 401/404). Honest middle state: not a
    // failure, not "verified".
    return <Badge severity="info" size="sm" title="Reached an HTTP server, but the exact route/auth wasn't verified (e.g. tested `/`, or got 3xx/4xx). Not a reachability failure.">reached · route not verified</Badge>
  }
  // "Verified" requires an actual HTTP 2xx. If the only successful evidence is
  // TCP/TLS (a raw TCP listener, or a non-HTTP port where the HTTP probe was
  // skipped), the port accepts connections but nothing confirmed the service
  // works — a port can accept and still serve nothing. Say what we know.
  const httpOK = (p: ProbeResult) => p.layer === 'http' && p.ok && p.tone !== 'reached'
  const httpVerified = real.some(httpOK)
  if (!httpVerified) {
    return <Badge severity="info" size="sm" title="The port accepts connections (TCP/TLS), but no HTTP response confirmed the service itself. A port can accept a connection and still serve nothing.">port reachable</Badge>
  }
  if (sample && sample.sampled < sample.total) {
    return <Badge severity="info" size="sm" title={`Probes passed on ${sample.sampled} of ${sample.total} pods. The other ${sample.total - sample.sampled} were not sampled.`}>verified ({sample.sampled} of {sample.total} sampled)</Badge>
  }
  // Full green "verified" requires an HTTP 2xx on a REAL path — the data path
  // (in-cluster pod-to-pod) OR a direct Ingress/Gateway dial (path unset).
  // Only the apiserver proxy is the caveated path: a 2xx solely via the proxy
  // proves a backend answers HTTP but NOT that in-cluster workload→pod traffic
  // takes the same route, so it renders "verified via API server", not full green.
  const dataHttpVerified = real.some(p => httpOK(p) && p.path !== 'apiserver')
  if (!dataHttpVerified) {
    return <Badge severity="info" size="sm" title="Reached a backend through the Kubernetes API server proxy. This proves a pod answers HTTP, but not that in-cluster workload-to-pod traffic takes the same path.">{`verified via ${API_PROXY_LABEL}`}</Badge>
  }
  return <Badge severity="success" size="sm" title="Every probe that ran for this hop reached and verified the target (HTTP 2xx / clean transport)">verified</Badge>
}

function SeverityChip({ severity, count, probes }: { severity: FindingSeverity | ''; count: number; probes?: ProbeResult[] }) {
  // Probe state is computed first so it can outrank an info-only
  // static finding: a hop with one info finding AND a failed probe
  // would otherwise render "1 info" while the probe row below carries
  // the live failure. Critical and warning static findings still
  // outrank probe state.
  if (count === 0) {
    return probeChipFor(probes) ?? <Badge severity="info" size="sm" title="Static configuration is consistent; this hop hasn't been actively probed yet">not tested</Badge>
  }
  // When static findings AND a live probe PROBLEM exist on the same hop, stack
  // two chips so the operator sees both. Only problem states stack — a green
  // "verified" or neutral "reached" next to a warning finding is noise, and
  // those still show in the expanded probe rows.
  const real = probes?.filter(p => !p.skipped) ?? []
  const probeProblem = real.some(p => !p.ok || p.tone === 'unhealthy' || p.tone === 'degraded')
  const stackChip = probeProblem ? probeChipFor(probes) : null
  if (severity === 'critical') {
    return <span className="inline-flex items-center gap-1.5"><Badge severity="error" size="sm">{count} critical</Badge>{stackChip}</span>
  }
  if (severity === 'warning') {
    return <span className="inline-flex items-center gap-1.5"><Badge severity="warning" size="sm">{count} warning{count > 1 ? 's' : ''}</Badge>{stackChip}</span>
  }
  if (stackChip) {
    return <span className="inline-flex items-center gap-1.5"><Badge severity="info" size="sm">{count} info</Badge>{stackChip}</span>
  }
  return <Badge severity="info" size="sm">{count} info</Badge>
}

function PanelMessage({ tone, message, onAction, actionLabel }: { tone: 'muted' | 'error'; message: string; onAction?: () => void; actionLabel?: string }) {
  return (
    <div className="p-4">
      <AlertBanner
        variant={tone === 'error' ? 'error' : 'info'}
        title={message}
      >
        {onAction && actionLabel && (
          <button
            type="button"
            onClick={onAction}
            className="mt-2 text-xs px-2 py-1 rounded border border-current/30 hover:bg-current/10"
          >
            {actionLabel}
          </button>
        )}
      </AlertBanner>
    </div>
  )
}

function ZeroConfigDisclaimer() {
  return (
    <p className="text-[10px] text-theme-text-tertiary border-t border-theme-border pt-2 mt-1">
      Built from declared config and live probes. NetworkPolicy enforcement isn't tested - a policy could still drop traffic that probes can't see.
    </p>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────────

// severityToTone bridges the trace's Finding vocabulary (critical / warning /
// info, plus empty when a hop is clean) to Radar's shared StatusTone, so the
// dot rendering uses the same primitive every other surface does.
function severityToTone(s: FindingSeverity | ''): StatusTone {
  switch (s) {
    case 'critical': return 'unhealthy'
    case 'warning': return 'degraded'
    case 'info': return 'unknown'
    default: return 'healthy'
  }
}

function prettyEdge(edge: string, _isSubject?: boolean): string {
  if (!edge) return ''
  if (edge.startsWith('entry:')) {
    return `Entry · ${edge.slice('entry:'.length)}`
  }
  return edge.replace('->', ' → ')
}

function hopKey(hop: Hop, i: number): string {
  return `${hop.resource.kind}:${hop.resource.namespace ?? ''}:${hop.resource.name ?? ''}:${i}`
}

// hopFallbackLabel covers the unnamed-collection case — the Pods hop is a
// fan-out over the selector, not a single named resource. Same for any
// future Routes collection hop on a Gateway entry.
function hopFallbackLabel(hop: Hop): string {
  if (hop.resource.kind === 'Pods') {
    // The ready/selected count lives once, on the meta line ({ready}/{selected}
    // ready) — the name stays count-free so the number isn't stated twice.
    return 'Pods'
  }
  if (hop.resource.kind === 'Routes') return 'attached routes'
  return '-'
}

function hopMetaSummary(hop: Hop): string | null {
  if (!hop.meta) return null
  const parts: string[] = []
  const selected = hop.meta['selected']
  const ready = hop.meta['ready']
  if (typeof selected === 'number' && typeof ready === 'number') {
    parts.push(`${ready}/${selected} ready`)
  } else if (typeof selected === 'number') {
    parts.push(`${selected} selected`)
  }
  if (hop.meta['endpointSource'] === 'unknown') {
    parts.push("couldn't read backing pods")
  }
  if (hop.meta['headless'] === true) {
    parts.push('headless (no virtual IP)')
  }
  if (hop.meta['selectorless'] === true) {
    parts.push('manually-managed endpoints')
  }
  return parts.length ? parts.join(' · ') : null
}
