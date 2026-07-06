// Mirrors internal/trace types.go on the Go side. Keep field names in sync
// when extending - JSON tags on Go must match these property names exactly.

export type Verdict = 'healthy' | 'degraded' | 'broken' | 'unknown'
export type FindingSeverity = 'critical' | 'warning' | 'info'

export interface ResourceRef {
  group?: string
  kind: string
  namespace?: string
  name: string
}

export interface Finding {
  code: string
  severity: FindingSeverity
  message: string
  /** Parsed root cause (plain English) when the detector classified the
   *  failure - e.g. "Image not found in registry", "Exit code 137 (OOMKilled)".
   *  Empty for generic detections; UI renders message in that case. */
  cause?: string
  /** Next-step guidance paired with cause - e.g. "Push the image or fix the
   *  reference", "Increase the container memory limit". Empty when not parsed. */
  action?: string
  remediation?: string
  command?: string
  /** Renderable chip strip carrying structured detail a sentence can't hold -
   *  today the egress-note's allowed destinations. On-chip text is jargon-free;
   *  the jargon lives in each chip's title. */
  chips?: FindingChip[]
  /** Tiny field label printed before the chip strip ("Allowed out"). Empty when
   *  the chips read on their own (deny-all, anywhere). */
  chipsLabel?: string
  /** Quiet tertiary caveats printed under the chips (declared-vs-enforced, the
   *  gated DNS observation). Kept subordinate to the inbound verdict. */
  chipNotes?: string[]
  /** The specific object this finding is about when it differs from the hop it
   *  hangs on - a pod-fanout hop carries one finding per code but the culprit is
   *  a named Pod. Empty = the hop's own resource is the subject. */
  resource?: ResourceRef
}

/** One tag in a Finding's chip strip. Tone 'accent' renders the info-blue
 *  variant (anywhere / deny-all); omitted renders the muted variant. */
export interface FindingChip {
  text: string
  title?: string
  tone?: 'accent' | ''
}

export interface Hop {
  resource: ResourceRef
  edge: string
  findings: Finding[]
  meta?: Record<string, unknown>
  config?: HopConfig
  probes?: ProbeResult[]
}

export type ProbeLayer = 'dns' | 'tcp' | 'tls' | 'http'
export type ProbeVantage = 'in-cluster' | 'local'
/**
 * Which route a Service/Pod probe took. "data" = straight to the resource
 * over the network (kube-proxy for ClusterIP, direct dial for PodIP).
 * "apiserver" = through the K8s API server's proxy subresource. Empty when
 * the question doesn't apply (DNS, HTTP to an Ingress hostname, etc.).
 */
export type ProbePath = 'data' | 'apiserver'

/**
 * Tone classifies a Result for the UI when ok alone is too coarse. It encodes
 * the honest distinction between reaching a target, verifying what we asked
 * for, and the server erroring:
 *   healthy   - reached AND verified (HTTP 2xx; clean DNS/TCP/TLS)
 *   reached   - reached an HTTP server, but the thing we asked for is unproven
 *               (3xx redirect not followed, or 4xx route/auth not what we hit).
 *               NOT a reachability failure; never renders as "verified" or
 *               "degraded".
 *   degraded  - reached, but the server answered 5xx. Traffic passed.
 *   unhealthy - could not reach (transport failure).
 * Empty falls back to (skipped → unknown, !ok → unhealthy, ok → healthy).
 */
export type ProbeTone = 'healthy' | 'reached' | 'degraded' | 'unhealthy'

export interface ProbeResult {
  layer: ProbeLayer
  target: string
  vantage: ProbeVantage
  path?: ProbePath
  ok: boolean
  tone?: ProbeTone
  skipped?: boolean
  reason?: string
  latencyNs?: number
  /** The Service/target port this result is for, when port-scoped (lets the UI group
   *  per-port results into one row per path across directions). */
  port?: number
  detail?: string
  error?: string
  /** Copyable command to verify what this probe couldn't (non-HTTP port, HTTPS
   *  backend, an address only reachable in-cluster). Set at the skip site. */
  command?: string
}

export interface PortMap {
  name?: string
  port: number
  targetPort?: string
  protocol?: string
  appProtocol?: string
}

export interface ContainerPortRef {
  container: string
  name?: string
  port: number
  protocol?: string
}

export interface ProbeRef {
  container: string
  type: string
  port?: string
  path?: string
  scheme?: string
}

export interface BackendRef {
  kind: string
  name: string
  namespace?: string
  port?: string
}

export interface RouteRule {
  hosts?: string[]
  paths?: string[]
  backends?: BackendRef[]
}

export interface GatewayListener {
  name?: string
  port: number
  protocol?: string
  hostname?: string
}

export interface HopConfig {
  ports?: PortMap[]
  serviceType?: string
  clusterIP?: string
  selector?: Record<string, string>
  containerPorts?: ContainerPortRef[]
  probes?: ProbeRef[]
  hostnames?: string[]
  rules?: RouteRule[]
  tlsHosts?: string[]
  listeners?: GatewayListener[]
  addresses?: string[]
  servedBy?: string
  servedByTitle?: string
  podIPs?: string[]
  podNames?: string[]
}

export type UnknownClass = 'by-design' | 'investigate'

export interface Trace {
  subject: ResourceRef
  upstreams: Hop[]
  downstream: Hop[]
  verdict: Verdict
  brokenAt: number
  reason?: string
  /** Distinguishes the two flavors of the unknown verdict so the UI can
   *  pick the right visual register. 'by-design' covers configurations
   *  where auto-verification doesn't apply (e.g. selectorless Service);
   *  the banner renders as informational. 'investigate' covers cases
   *  where the trace tried and couldn't read state (RBAC, cache cold,
   *  lookup failure); the banner renders as warning. Absent on
   *  non-unknown verdicts. */
  unknownClass?: UnknownClass
  truncated?: boolean
  // Coverage-honest projection (server-authoritative, mirrors internal/trace/coverage.go).
  // These describe ONLY what was actually tested. Localization on a RouteResult is the
  // behind-the-gate evidence, kept separate so it can never feed the headline/outcome.
  coverage?: Coverage
  routes?: RouteResult[]
  notTested?: RouteSkip[]
  brokenRoute?: ResourceRef
  /** The single coverage-honest banner sentence - same string the MCP renders. */
  headline?: string
  /** The one finding that matters - cause, the named culprit, the next action -
   *  promoted from the path so a consumer reads the "why + what next" without
   *  walking the hop chain. Absent when there is nothing to diagnose (every
   *  route verified over real traffic). */
  diagnosis?: Diagnosis
}

/** Hoisted lead diagnosis, mirrors internal/trace/coverage.go Diagnosis. Every
 *  field is PROMOTED from a real finding (or coverage state), never synthesized.
 *  causeCode is the structured code, present ONLY for trustworthy structural
 *  fingerprints (missing-ref / svc:*); a pod-state code is omitted and summary
 *  carries the honest prose instead. */
export interface Diagnosis {
  causeCode?: string
  summary: string
  culpritResource?: ResourceRef
  nextAction?: string
  command?: string
}

/** Per-route outcome (pairs with a confidence). Mirrors the Go Outcome* constants. */
export type RouteOutcome = 'verified' | 'reached' | 'server-error' | 'unreachable' | 'not-tested'
/** How an outcome was learned: 'real' = real-traffic path; 'indirect' = apiserver proxy
 *  (annotates, never sets the headline). '' for a static-known break (missing backend). */
export type RouteConfidence = 'real' | 'indirect' | ''
/** Skip impact: 'coverage' + 'vantage' are real gaps (cap green); 'benign' loses no coverage. */
export type SkipReasonClass = 'coverage' | 'benign' | 'vantage'

export interface Coverage {
  tested: number
  passed: number
  failed: number
  skipped: number
}

export interface ProbeFact {
  layer: string
  path?: string
  target?: string
  ok: boolean
  tone?: string
  detail?: string
}

export interface RouteResult {
  route: string
  target?: string
  /** Backend Service namespace - set when it differs from the subject namespace
   *  (cross-namespace Gateway API backendRef) so the in-cluster probe dials an FQDN. */
  targetNamespace?: string
  outcome: RouteOutcome
  /** Which layer failed on a non-reachable route, so the UI can say exactly what
   *  broke: 'tcp' | 'tls' | 'http' (unreachable), or 'upstream' for a 502/504 where
   *  HTTP was reached but the gateway couldn't reach its backend. */
  failedLayer?: 'tcp' | 'tls' | 'http' | 'upstream'
  confidence?: RouteConfidence
  evidence?: string
  command?: string
  /** Unreachable by DESIGN (backing workload intentionally scaled to 0) - read
   *  amber-benign, not red. */
  benign?: boolean
  /** Behind-the-gate facts (apiserver/direct-pod). Render as plain "checked behind it"
   *  sub-lines - never label them "localization" in the UI. */
  localization?: ProbeFact[]
  /** Best-guess concrete request to test this route from inside the cluster.
   *  A STARTING POINT the user edits before running; pathGuessed marks a path
   *  derived from a pattern (no single faithful request exists). */
  inClusterRequest?: ProbeRequest
}

/** A concrete HTTP request the in-cluster runner can send to the Service. */
export interface ProbeRequest {
  scheme: string
  host?: string
  path: string
  pathGuessed?: boolean
}

export interface RouteSkip {
  route?: string
  reason: string
  reasonClass?: SkipReasonClass
  command?: string
}
