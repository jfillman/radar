import type { ComponentType } from 'react'
import { CheckCircle2, AlertTriangle, ShieldAlert, Info } from 'lucide-react'
import { AlertBanner } from '../ui/drawer-components'
import { coverageBannerTone, routeOutcomeRank } from './TracePanel'
import type { Trace, Finding } from './types'

type Tone = ReturnType<typeof coverageBannerTone>

const ICON: Record<Tone, ComponentType<{ className?: string }>> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  error: ShieldAlert,
  info: Info,
}

/** The passive drawer view-model — extracted as a pure function so the decision
 *  logic (tone, worst-offender-when-failing, CTA label) is unit-testable without
 *  a DOM. `minimal` = no coverage projection yet (static/config-only); `glance` =
 *  a coverage headline with its single honest tone. */
export interface TraceSummaryView {
  kind: 'glance' | 'minimal'
  headline: string
  tone?: Tone
  /** The failing route to spotlight under the headline, with a count of how many
   *  routes failed in total — so the label can read honestly ("Failing route"
   *  for one, "Worst of N failing routes" when there are more). */
  worst?: { route: string; target?: string; evidence?: string; failingCount: number }
  /** A muted honesty line under the headline — e.g. "Config check only — not
   *  tested from live traffic" — so a config-derived glance never reads as a
   *  tested result. */
  subtitle?: string
  notTested: number
  ctaLabel: string
}

// The drawer never runs active probes (that emits real traffic — deliberate, see
// client.ts useTrace). So a config-only glance must INVITE the test, never imply
// one ran ("See test detail →" is dishonest with nothing tested).
const RUN_CTA = 'Run reachability test →'
const CONFIG_ONLY = 'Config check only — not tested from live traffic'

export function summarizeTrace(trace: Trace): TraceSummaryView {
  const coverage = trace.coverage
  const routes = trace.routes ?? []

  // 1. PROBED — actual probe results exist (tested > 0) → the route-coverage
  //    glance. A coverage projection with tested === 0 is NOT a tested result
  //    (the drawer never probes); it falls through to the config-only states
  //    below so the operator gets real config value, not "not yet tested".
  if (coverage && coverage.tested > 0 && trace.headline) {
    const tone = coverageBannerTone(coverage, routes)
    const failing = coverage.failed > 0
    // The worst-offender line shows ONLY when a route genuinely failed. Benign
    // scale-to-0 is intentional dormancy, not a failure to call out.
    const failingRoutes = failing
      ? [...routes]
          // An apiserver-proxy-only (indirect) unreachable never confirmed the real
          // path — it's amber in coverageBannerTone, so it must NOT be spotlighted as
          // a definitive "Failing route" here. A genuinely-down backend is upgraded to
          // confidence 'real' upstream (definitive 0-ready endpoints), so it still shows.
          .filter((r) => (r.outcome === 'server-error' || (r.outcome === 'unreachable' && r.confidence !== 'indirect')) && !r.benign)
          .sort((a, b) => routeOutcomeRank(a.outcome) - routeOutcomeRank(b.outcome))
      : []
    const worstRoute = failingRoutes[0]
    return {
      kind: 'glance',
      headline: trace.headline,
      tone,
      worst: worstRoute && {
        route: worstRoute.route,
        target: worstRoute.target,
        evidence: worstRoute.evidence,
        failingCount: failingRoutes.length,
      },
      notTested: trace.notTested?.length ?? coverage.skipped,
      // Calm when healthy ("see detail"), actionable when failing ("open").
      ctaLabel: failing ? 'Open Reachability →' : 'See test detail →',
    }
  }

  // Everything below is CONFIG-ONLY (nothing actively tested). The rule: lead
  // with what the config SAYS, in config language ("wired", "would block") —
  // never traffic language ("reachable", "verified") — and invite the run.

  // 2. CONFIG PROBLEM IN THE VERDICT — the static trace already found a break
  //    (down pod, no ready endpoints, wrong targetPort, a default-deny that
  //    flipped the verdict). Name the cause in plain English; broken=red,
  //    degraded=amber honors the definitive-vs-heuristic nuance.
  if (trace.verdict === 'broken' || trace.verdict === 'degraded') {
    return {
      kind: 'glance',
      // Prefer the worst finding's plain one-line message over diagnosis.summary
      // (which can be a paragraph of forensics) — the headline slot is a glance,
      // the full cause lives on the tab. Same message-first rule as state 3.
      headline:
        staticWorstFinding(trace)?.message ||
        trace.diagnosis?.summary ||
        (trace.verdict === 'broken' ? 'Reachability broken (config check)' : 'Reachability issue (config check)'),
      tone: trace.verdict === 'broken' ? 'error' : 'warning',
      subtitle: CONFIG_ONLY,
      notTested: 0,
      ctaLabel: RUN_CTA,
    }
  }

  // 3. CONFIG RED FLAG NOT IN THE VERDICT — a warning/critical finding the
  //    verdict didn't escalate (e.g. a caller-independent policy note). Surface
  //    the worst one rather than letting a clean verdict swallow it.
  const wf = staticWorstFinding(trace)
  if (wf) {
    return {
      kind: 'glance',
      // The plain-language message is the operator-facing one-liner; the cause
      // (which may carry kind names like "NetworkPolicy") stays for the full tab.
      headline: wf.message || wf.cause || 'A configuration issue was found',
      tone: wf.severity === 'critical' ? 'error' : 'warning',
      subtitle: CONFIG_ONLY,
      notTested: 0,
      ctaLabel: RUN_CTA,
    }
  }

  // 4. UNKNOWN — the trace couldn't determine reachability (RBAC denied, cache
  //    not synced, the API isn't installed). NOT clean: surface the uncertainty.
  if (trace.verdict === 'unknown') {
    return {
      kind: 'glance',
      headline: trace.reason || "Couldn't read the config to map the path",
      tone: 'info',
      subtitle: CONFIG_ONLY,
      notTested: 0,
      ctaLabel: RUN_CTA,
    }
  }

  // 5. NO RUNNING BACKENDS — config-only, but the service has zero ready pods.
  //    "Wired" would overclaim (there's nothing to route to). Surface it amber as
  //    dormant — the probed path treats scale-to-0 as amber too, so config must.
  const pods = podReadiness(trace)
  if (pods.ready === 0 && pods.selected !== undefined) {
    return {
      kind: 'glance',
      headline:
        pods.selected === 0
          ? hasScaleToZeroFinding(trace)
            ? 'No running pods behind this service (scaled to zero)'
            : "No pods match this service's selector (0 selected)"
          : `No running pods behind this service (0 of ${pods.selected} ready)`,
      tone: 'warning',
      subtitle: CONFIG_ONLY,
      notTested: 0,
      ctaLabel: RUN_CTA,
    }
  }

  // 6. WIRED CLEAN — the path resolves end to end to running pods, no red flag.
  //    For a PATH-OWNING subject (Ingress/Gateway/Route) the host→backend wiring
  //    is already shown by the resource's own Rules section, AND "routes to N
  //    pods" describes only the BACKEND — it skips the front-door (controller)
  //    question entirely, so as a headline it both REPEATS and OVERCLAIMS (it
  //    reads as "the entry works" when the controller was never verified). Lead
  //    with the honest "not tested" + the live-test CTA, nothing asserted.
  if (PATH_OWNING_KINDS.has(trace.subject.kind)) {
    return {
      kind: 'minimal',
      headline: 'Reachability not tested yet',
      subtitle: 'Run the live test to check the path in through the front door.',
      notTested: 0,
      ctaLabel: RUN_CTA,
    }
  }
  //    For a Service/Pod subject there's no Rules section, so this glance is the
  //    ONLY place the wiring appears — keep it (it's not a restatement there).
  return {
    kind: 'minimal',
    headline: staticGlance(trace),
    subtitle: CONFIG_ONLY,
    notTested: 0,
    ctaLabel: RUN_CTA,
  }
}

// Subjects whose own renderer already prints their routing rules (host→backend),
// so the reachability glance must NOT restate the wiring — and "routes to N
// pods" would overclaim a front door it never verified.
const PATH_OWNING_KINDS = new Set(['Ingress', 'Gateway', 'HTTPRoute', 'GRPCRoute'])

/** Whether any hop carries the intentional scale-to-0 finding (mirrors the Go
 *  markBenignScaleZero / isScaleZeroFinding). Only then is "scaled to zero" an
 *  honest cause for 0 selected pods — otherwise it could be a bad/stale selector. */
function hasScaleToZeroFinding(trace: Trace): boolean {
  const all = [...(trace.upstreams ?? []), ...(trace.downstream ?? [])].flatMap((h) => h.findings ?? [])
  return all.some((f) => (f.code ?? '') === 'svc:scaled-to-zero' || (f.code ?? '').endsWith('Backing workload scaled to 0'))
}

/** Ready / selected pod counts from the Pods hop, the numbers behind "is there
 *  anything running to route to". Either may be undefined when the trace can't
 *  read pod state. */
function podReadiness(trace: Trace): { ready?: number; selected?: number } {
  const pods = [...(trace.upstreams ?? []), ...(trace.downstream ?? [])].find((h) => h.resource.kind === 'Pods')
  if (!pods) return {}
  const ready = typeof pods.meta?.ready === 'number' ? (pods.meta.ready as number) : undefined
  const selected = typeof pods.meta?.selected === 'number' ? (pods.meta.selected as number) : pods.config?.podNames?.length
  return { ready, selected }
}

/** The worst caller-independent config finding (critical first, then warning),
 *  scanned across every hop. Drives state 3 so a real red flag the verdict
 *  didn't escalate (a policy would-deny, a targetPort mismatch) still surfaces
 *  in the drawer instead of being swallowed by a clean verdict. */
function staticWorstFinding(trace: Trace): Finding | undefined {
  const downstream = (trace.downstream ?? []).flatMap((h) => h.findings ?? [])
  // An upstream missing_ref finding is about a SIBLING backend route, not this
  // subject — including it would condemn an otherwise-healthy Service from a
  // broken sibling (mirrors TracePanel HopRow's upstream scoping). Downstream
  // findings are scanned unconditionally.
  const upstream = (trace.upstreams ?? []).flatMap((h) => h.findings ?? []).filter((f) => !(f.code ?? '').startsWith('missing_ref:'))
  const all = [...downstream, ...upstream]
  return all.find((f) => f.severity === 'critical') ?? all.find((f) => f.severity === 'warning')
}

/** A one-line static-config glance for the wired-clean drawer, in PLAIN language a
 *  non-k8s operator owns — "Routes to N running pods on port X", optionally led by
 *  the external host. Deliberately drops k8s idioms (port→targetPort arrows,
 *  "N/M ready"); the precise wiring lives on the Reachability tab. States what the
 *  config IS in config language — never the empty "not yet tested". */
function staticGlance(trace: Trace): string {
  const hops = [...(trace.upstreams ?? []), ...(trace.downstream ?? [])]
  const svc = hops.find((h) => h.resource.kind === 'Service')
  const host = hops.map((h) => h.config?.hostnames?.[0]).find(Boolean)
  const port = svc?.config?.ports?.[0]?.port
  const { ready, selected } = podReadiness(trace)
  const podN = ready ?? selected
  // Only say "running" when readiness was actually OBSERVED. When only the
  // selector-match count is known, the pods may not be ready — say "matching" so
  // the glance never asserts liveness it didn't see.
  const noun = typeof ready === 'number' ? 'running pod' : 'matching pod'

  let core: string
  if (typeof podN === 'number' && port !== undefined) core = `Routes to ${podN} ${noun}${podN === 1 ? '' : 's'} on port ${port}`
  else if (typeof podN === 'number') core = `Routes to ${podN} ${noun}${podN === 1 ? '' : 's'}`
  else if (port !== undefined) core = `Configured on port ${port}`
  else core = 'Configuration looks valid'

  return host ? `${host} · ${core.charAt(0).toLowerCase()}${core.slice(1)}` : core
}

/**
 * TraceSummary is the PASSIVE drawer glance for the network-reachability path:
 * one honest headline (tone from coverageBannerTone — the SAME single tone source
 * the full panel uses), a worst-offender line ONLY when something failed, a muted
 * not-tested count, and ONE CTA into the full Reachability tab. It never nags — a
 * healthy verified path reads as a calm one-liner. The full route matrix, per-route
 * localization, path topology, and the in-cluster test all live on the tab
 * (TracePanel), reachable via the CTA. The drawer stays a glance, not a console.
 */
export function TraceSummary({ trace, onOpenReachability }: { trace: Trace; onOpenReachability: () => void }) {
  const v = summarizeTrace(trace)

  if (v.kind === 'minimal') {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2 text-sm text-theme-text-secondary">
          <span className="truncate">{v.headline}</span>
          <OpenButton onClick={onOpenReachability} label={v.ctaLabel} />
        </div>
        {v.subtitle && <span className="text-xs text-theme-text-tertiary">{v.subtitle}</span>}
      </div>
    )
  }

  return (
    <AlertBanner variant={v.tone!} icon={ICON[v.tone!]} title={v.headline}>
      {v.worst && (
        <div className="mt-1 text-xs">
          <span className="text-theme-text-secondary">
            {v.worst.failingCount > 1 ? `Worst of ${v.worst.failingCount} failing routes: ` : 'Failing route: '}
          </span>
          <span className="font-mono text-theme-text-primary break-all">{v.worst.route}</span>
          {v.worst.target && <span className="text-theme-text-tertiary break-all"> → {v.worst.target}</span>}
          {v.worst.evidence && <span className="text-theme-text-tertiary"> · {v.worst.evidence}</span>}
        </div>
      )}
      {v.subtitle ? (
        <div className="mt-1 text-xs text-theme-text-tertiary">{v.subtitle}</div>
      ) : (
        v.notTested > 0 && <div className="mt-1 text-xs text-theme-text-tertiary">{v.notTested} not tested</div>
      )}
      <OpenButton onClick={onOpenReachability} label={v.ctaLabel} />
    </AlertBanner>
  )
}

function OpenButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-2 text-xs px-2 py-1 rounded border border-current/30 hover:bg-current/10 transition-colors"
    >
      {label}
    </button>
  )
}
