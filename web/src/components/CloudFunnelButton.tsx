import { useEffect, useId, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Bell, Check, ChevronRight, Globe, History, Sparkles, Users, X } from 'lucide-react'
import { Collapse, CollapseChevron } from '@skyhook-io/k8s-ui/components/ui/Collapse'
import { DialogPortal } from '@skyhook-io/k8s-ui/components/ui/DialogPortal'
import { Tooltip } from './ui/Tooltip'
import { CloudConnectFlow } from './CloudConnectFlow'
import { showApiError } from './ui/Toast'
import {
  ApiError,
  cloudInstallActive,
  type CloudConnectSelf,
  type CloudInstallBlocked,
  type CloudInstallStatus,
  prepareCloudInstall,
  useCapabilities,
  useCloudConnectInfo,
  useCloudConnectSelf,
  useCloudInstallStatus,
} from '../api/client'

// OSS → Cloud funnel: a quiet globe button in the top bar that opens a modal
// pitching Radar Cloud. Two lanes (capabilities.cloudConnect): "driver" runs
// the in-product connect flow against this server; "wizard" links to the Hub's
// connect wizard.
//
// The only outbound call is the Hub's own copy, fetched when the dialog opens
// (never on a poll or a timer) and falling back per-field to the constants
// below. Conversion is otherwise measured on the receiving end: utm_content
// distinguishes which lane sent the user.
const FALLBACK_APP_URL = 'https://app.radarhq.io'

// Rendered until (or unless) the Hub states its own. Keeping the compiled-in
// copy as the fallback means an unreachable Hub, a self-hosted one, or an
// offline laptop all render exactly what Radar rendered before this fetch
// existed — the dialog never waits on the network and never shows a gap.
const DEFAULT_ASSURANCES = ['Free for 3 clusters', 'No credit card', 'Your cluster data stays in your cluster']
// A product fact, not funnel copy — appended even when the Hub supplies its
// own assurances (deduped if the Hub starts sending it).
const SOC2_ASSURANCE = 'SOC 2 compliant'
const SIGNUP_QUERY = '?utm_source=radar-oss&utm_medium=app&utm_campaign=cloud-modal'
const ABOUT_URL = 'https://radarhq.io/about'
const SELF_HOSTED_DOCS_URL = 'https://radarhq.io/docs/cloud/self-hosted/'
const SEEN_KEY = 'radar.cloudFunnel.seen'

// localStorage access can throw (SecurityError) where storage is denied —
// sandboxed embeds, some privacy modes. This button mounts in the top bar
// outside the main error boundary, so an uncaught throw would take down the
// chrome; degrade to "not seen" / no-op persistence instead.
function readSeen(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(SEEN_KEY) === 'true'
  } catch {
    return false
  }
}

function markSeen() {
  try {
    window.localStorage.setItem(SEEN_KEY, 'true')
  } catch {
    // Storage denied — the ping dot reappears on next mount; harmless.
  }
}

export function CloudFunnelButton() {
  const [open, setOpen] = useState(false)
  const [seen, setSeen] = useState(readSeen)
  const [inFlowView, setInFlowView] = useState(false)
  const [detailsView, setDetailsView] = useState(false)
  const [blocked, setBlocked] = useState<CloudInstallBlocked | null>(null)

  const capabilities = useCapabilities()
  const lane = capabilities.data?.cloudConnect?.lane ?? 'wizard'
  const appUrl = capabilities.data?.cloudConnect?.appUrl || FALLBACK_APP_URL
  // utm_content distinguishes the lane that opened the Hub — measured Hub-side
  // only when the user actually navigates there; Radar transmits nothing.
  const signupUrlFor = (content: string) => `${appUrl}/signup${SIGNUP_QUERY}&utm_content=${content}`
  const signupUrl = signupUrlFor('funnel-cta')

  // Only while the dialog is open — never on the capabilities poll. The Hub
  // learns that someone opened it, which is congruent with what the dialog is
  // for; it must not learn that Radar is merely running.
  const connectInfo = useCloudConnectInfo(capabilities.data?.cloudConnect?.apiUrl, open)

  // In-cluster Radar can't install its own connection, but it knows exactly
  // which install it is — so the wizard link can carry the real target, and a
  // GitOps-owned install can be told the imperative command isn't for it.
  const inCluster = capabilities.data?.deployment?.mode === 'in-cluster'
  const self = useCloudConnectSelf(open && inCluster)

  // The flow is server-owned: polling here both drives the live progress view
  // and re-attaches to an ongoing flow after a reload or modal close.
  const flowStatus = useCloudInstallStatus(lane === 'driver')
  const flow = flowStatus.data
  const flowLive = cloudInstallActive(flow?.state) || flow?.state === 'connected' || flow?.state === 'failed'

  const queryClient = useQueryClient()
  const applyStatus = (st: CloudInstallStatus) => {
    if (st.state !== 'blocked') queryClient.setQueryData(['cloud-install-status'], st)
    flowStatus.invalidate()
  }

  const prepare = useMutation({
    mutationFn: prepareCloudInstall,
    onSuccess: (st) => {
      if (st.state === 'blocked' && st.blocked) setBlocked(st.blocked)
      else applyStatus(st)
    },
    onError: (err) => {
      // A single-flight 409 is not a failure: its body IS the live flow (one
      // started in another tab, or before this tab's status cache refreshed).
      // Attach to it rather than showing an error over a running install.
      const live = err instanceof ApiError && err.status === 409 ? (err.data as CloudInstallStatus | undefined) : undefined
      if (live?.state) {
        applyStatus(live)
        return
      }
      // Anything else failed before a flow existed. Return to the pitch rather
      // than leaving the flow view armed, where a later status change would
      // pull the user into a screen they did not ask for.
      exitFlow()
      showApiError('Could not inspect this cluster for Cloud connect', err instanceof Error ? err.message : undefined)
    },
    // No meta.errorMessage: the global handler cannot tell a single-flight 409
    // (a successful attach) from a real failure, and would report failure over
    // a running install. Toast explicitly on the paths that are failures.
  })

  const openModal = () => {
    setOpen(true)
    setSeen(true)
    setDetailsView(false)
    markSeen()
    // Re-open lands on a live flow if one is running.
    if (lane === 'driver' && flowLive) setInFlowView(true)
  }

  const startConnect = () => {
    setBlocked(null)
    setInFlowView(true)
    prepare.mutate()
  }

  const exitFlow = () => {
    setInFlowView(false)
    setBlocked(null)
  }

  // Re-attach to a server-owned flow whenever one is observed while the modal
  // is open — the status query may resolve after openModal ran.
  useEffect(() => {
    if (open && lane === 'driver' && flowLive) setInFlowView(true)
  }, [open, lane, flowLive])

  // The server owns the "nothing to pitch" decision: an already-tunneled
  // deployment gets no cloudConnect capability at all. Waiting for
  // capabilities (rather than defaulting to visible) keeps the funnel from
  // flashing at a connected cluster's operator before that answer arrives.
  if (!capabilities.data?.cloudConnect) return null

  const showFlow = inFlowView && (blocked !== null || prepare.isPending || flowLive)
  // The prepare POST can take tens of seconds (chart download + preflight);
  // until the status poll observes the server-side flow, synthesize the
  // preparing state so the modal never renders empty. A blocked result gets
  // the same treatment: it lives only in local state (never seeded into the
  // status query), so a slow or failed first /status fetch must not drop the
  // explanation back to the pitch.
  const flowForView: CloudInstallStatus | undefined =
    prepare.isPending && !flowLive
      ? { state: 'preparing' }
      : (flow ?? (blocked ? { state: 'blocked', blocked } : undefined))

  return (
    <>
      {/* Tooltip is suppressed while the modal is open — it portals above the
          modal backdrop and would otherwise paint on top of the dialog. */}
      <Tooltip content="Radar Cloud: all your clusters, one URL" delay={100} position="bottom" disabled={open}>
        <button
          onClick={openModal}
          aria-label="Radar Cloud"
          aria-haspopup="dialog"
          className="relative p-1.5 rounded-md bg-theme-elevated hover:bg-theme-hover text-theme-text-secondary hover:text-theme-text-primary transition-colors"
        >
          <Globe className="w-4 h-4" />
          {cloudInstallActive(flow?.state) ? (
            <span className="absolute top-0.5 right-0.5 w-[7px] h-[7px] rounded-full bg-emerald-500 animate-pulse motion-reduce:animate-none" />
          ) : (
            !seen && (
              <span className="absolute top-0.5 right-0.5 w-[7px] h-[7px] rounded-full bg-emerald-500">
                <span className="absolute -inset-[3px] rounded-full border border-emerald-500/70 animate-ping motion-reduce:animate-none" />
              </span>
            )
          )}
        </button>
      </Tooltip>

      <DialogPortal
        open={open}
        onClose={() => setOpen(false)}
        className="w-[580px] max-w-full max-h-[calc(100vh-2rem)] overflow-hidden flex flex-col"
      >
        <button
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="absolute top-3.5 right-3.5 z-10 p-1.5 rounded-md text-theme-text-tertiary hover:text-theme-text-primary hover:bg-theme-hover transition-colors"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Only the body scrolls on short viewports — the close control and
            the footer CTA stay pinned so they never scroll away. This matters
            more with the connect flow, whose plan card is the tallest state. */}
        {showFlow && flowForView ? (
          <div className="min-h-0 overflow-y-auto">
            <div className="px-8 pt-7">
              <Eyebrow />
            </div>
            <CloudConnectFlow
              status={flowForView}
              blocked={blocked}
              signupUrl={signupUrlFor('flow-escape')}
              onStatus={applyStatus}
              onExit={exitFlow}
            />
          </div>
        ) : (
          <>
            <div className="min-h-0 overflow-y-auto">
              {detailsView ? (
                <DetailsBody onBack={() => setDetailsView(false)} />
              ) : (
                <PitchBody onDetails={() => setDetailsView(true)} />
              )}
            </div>
            <ModalFooter
              lane={lane}
              signupUrl={signupUrl}
              assurances={connectInfo.data?.assurances}
              notice={connectInfo.data?.notice}
              self={inCluster ? self.data : undefined}
              // Also covers the capabilities query: until it resolves, lane
              // defaults to wizard and Radar does not yet know it is
              // in-cluster, so the CTA would escape before classification.
              selfLoading={inCluster && self.isPending}
              onConnect={startConnect}
              onLater={() => setOpen(false)}
            />
          </>
        )}
      </DialogPortal>
    </>
  )
}

// Secondary copy the pitch shouldn't spend vertical space on until asked for.
function Fold({ summary, className = '', children }: { summary: string; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex items-center gap-1.5 text-[11.5px] text-theme-text-tertiary hover:text-theme-text-primary transition-colors"
      >
        <CollapseChevron open={open} className="w-3 h-3" />
        {summary}
      </button>
      <Collapse open={open}>
        <p id={bodyId} className="mt-2 pl-[18px] text-[11.5px] leading-relaxed text-theme-text-tertiary">
          {children}
        </p>
      </Collapse>
    </div>
  )
}

function assuranceItems(fromHub?: string[]): string[] {
  const items = fromHub?.length ? fromHub : DEFAULT_ASSURANCES
  if (items.some((item) => item.toLowerCase().includes('soc 2'))) return items
  // Before the last item: the closer ("data stays in your cluster") is the
  // longest line and wraps most naturally when it comes last.
  return [...items.slice(0, -1), SOC2_ASSURANCE, items[items.length - 1]]
}

function RadarSweep() {
  return (
    <div
      aria-hidden
      className="relative w-[30px] h-[30px] rounded-full overflow-hidden shrink-0 border border-emerald-400/60 shadow-[0_0_12px_rgba(16,185,129,0.35)]"
      style={{ background: 'radial-gradient(circle at 50% 50%, #072920 0%, #03180f 70%, #010a06 100%)' }}
    >
      <div className="absolute inset-[16%] rounded-full border border-emerald-600/50" />
      <div
        className="absolute inset-0 rounded-full animate-[spin_4s_linear_infinite] motion-reduce:animate-none"
        style={{ background: 'conic-gradient(from 0deg, rgba(167,243,208,0.85) 0deg, rgba(16,185,129,0.25) 40deg, transparent 90deg)' }}
      />
    </div>
  )
}

function Eyebrow() {
  return (
    <div className="flex items-center gap-3 mb-5">
      <RadarSweep />
      <span className="font-mono text-[10.5px] tracking-[0.16em] uppercase text-emerald-600 dark:text-emerald-400">Radar Cloud</span>
    </div>
  )
}

function ModalFooter({
  lane,
  signupUrl,
  assurances,
  notice,
  self,
  selfLoading,
  onConnect,
  onLater,
}: {
  lane: 'driver' | 'wizard'
  signupUrl: string
  // Live copy from the Hub; undefined until (or unless) it arrives.
  assurances?: string[]
  notice?: string
  // Present only in-cluster: what this Radar knows about its own install.
  self?: CloudConnectSelf
  // True while in-cluster self-classification is still in flight.
  selfLoading?: boolean
  onConnect: () => void
  onLater: () => void
}) {
  const gitops = self?.ownership === 'gitops'
  const ambiguous = self?.ownership === 'ambiguous'
  // The server decides who gets a link: it withholds wizardUrl whenever the
  // handoff must inspect before it acts (ambiguous ownership, or GitOps
  // evidence it could not verify). A GitOps install with a link goes to the
  // wizard's Argo/Flux tab, which generates a values patch for the repo rather
  // than an imperative command the controller would revert.
  const cliOnly = (gitops || ambiguous) && !self?.wizardUrl
  // Until classification resolves we cannot know which lane applies, and a
  // fast click would escape to signup before we could route this install.
  const selfPending = selfLoading === true
  return (
    <div className="shrink-0 px-8 py-5 bg-theme-base border-t border-theme-border">
      {self && self.ownership !== 'unknown' && (
        <div className="mb-3.5 card-inner p-3 text-[12px] leading-relaxed text-theme-text-secondary">
          {ambiguous ? (
            <>
              Radar found conflicting management metadata on this install, so it can't say whether a Helm
              upgrade or a repository change is the right move. Run{' '}
              <code className="font-mono text-[11px]">radar cloud install</code> from a machine with
              kubectl. It inspects the release and refuses rather than guessing.
            </>
          ) : gitops ? (
            <>
              This Radar is managed by{' '}
              <b className="text-theme-text-primary">{self.controller || 'a GitOps controller'}</b>, so
              connecting it is a values change in your repository; an imperative upgrade would be reverted.{' '}
              {cliOnly ? (
                <>
                  Radar found that evidence but couldn't confirm it against the live object, so run{' '}
                  <code className="font-mono text-[11px]">radar cloud install</code> from a machine with
                  kubectl. It inspects the release before generating anything.
                </>
              ) : (
                <>
                  The wizard generates the values patch for that controller, plus the one command that
                  creates the token Secret. The token never goes into your repository.
                </>
              )}
            </>
          ) : (
            <>
              Detected this install: namespace{' '}
              <code className="font-mono text-[11px] text-theme-text-primary">{self.namespace}</code>, release{' '}
              <code className="font-mono text-[11px] text-theme-text-primary">{self.release}</code>. The
              wizard will target it directly.
            </>
          )}
        </div>
      )}
      {notice && (
        <div className="mb-3.5 card-inner p-3 text-[12px] leading-relaxed text-theme-text-secondary">{notice}</div>
      )}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
        {lane === 'driver' ? (
          <button
            onClick={onConnect}
            className="whitespace-nowrap px-6 py-2.5 rounded-[10px] bg-emerald-500 hover:bg-emerald-400 text-emerald-950 text-[14px] font-bold shadow-[0_0_22px_rgba(16,185,129,0.35)] hover:shadow-[0_0_30px_rgba(16,185,129,0.5)] hover:-translate-y-px transition-all"
          >
            Connect this cluster
          </button>
        ) : cliOnly ? null : (
          <a
            href={self?.wizardUrl || signupUrl}
            aria-disabled={selfPending}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => { if (selfPending) e.preventDefault() }}
            className={`px-5 py-2 rounded-[10px] bg-emerald-500 hover:bg-emerald-400 text-emerald-950 text-[13.5px] font-bold shadow-[0_0_22px_rgba(16,185,129,0.35)] hover:shadow-[0_0_30px_rgba(16,185,129,0.5)] hover:-translate-y-px transition-all ${selfPending ? 'opacity-60 pointer-events-none' : ''}`}
          >
            {self?.ownership === 'helm' || gitops ? 'Connect this cluster' : 'Try Cloud free'}
          </a>
        )}
        <button onClick={onLater} className="whitespace-nowrap text-[13px] text-theme-text-tertiary hover:text-theme-text-primary transition-colors">
          Maybe later
        </button>
      </div>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-[11.5px] text-theme-text-tertiary">
        {assuranceItems(assurances).map((item) => (
          <span key={item} className="flex items-center gap-1.5">
            <Check className="w-3 h-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
            {item}
          </span>
        ))}
      </div>
    </div>
  )
}

// The pitch answers what this is, what you get, and whether it can be
// trusted. The headline names the product — an opener that defuses a fear
// instead buries what the dialog is even about; one-line highlights carry the
// value; the anti-sell line is the credibility beat. Anything longer lives one
// click deeper in DetailsBody, so this stays short enough to read at a glance.
function PitchBody({ onDetails }: { onDetails: () => void }) {
  const highlights = [
    { icon: Globe, text: 'Your whole fleet in one URL: issues, checks and search across every cluster' },
    { icon: Users, text: "Bring the team: SSO, invites and roles. Your cluster's RBAC has the final say" },
    { icon: Bell, text: 'Alerts that reach you the moment something breaks' },
    { icon: History, text: 'Long-term retention: history that survives restarts and keeps growing' },
    { icon: Sparkles, text: 'An AI agent that digs into issues and pinpoints the root cause' },
  ]
  return (
    <div className="px-8 pt-7 pb-2">
      <Eyebrow />
      <h3 className="text-[22px] font-semibold leading-tight tracking-tight text-theme-text-primary mb-3 text-balance">
        Meet Radar Cloud
      </h3>
      <p className="text-[14px] leading-relaxed text-theme-text-secondary mb-5">
        The hosted side of Radar: your clusters in one place, run by us.{' '}
        <b className="text-theme-text-primary font-semibold">This app stays free and open source, always.</b>
      </p>
      <ul className="space-y-2.5 mb-4">
        {highlights.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-start gap-2.5 text-[13px] leading-relaxed text-theme-text-secondary">
            <Icon className="w-4 h-4 shrink-0 mt-[3px] text-emerald-600 dark:text-emerald-400" />
            {text}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onDetails}
        className="flex items-center gap-1 mb-5 text-[12.5px] text-theme-text-tertiary hover:text-theme-text-primary transition-colors"
      >
        How it works and what it costs
        <ChevronRight className="w-3.5 h-3.5" />
      </button>
      <div className="mb-5 border-l-2 border-emerald-500/40 pl-3.5">
        <p className="text-[12.5px] leading-relaxed text-theme-text-secondary">
          Just you and one cluster? Stay right here. This app is the product, not a demo.
        </p>
      </div>
    </div>
  )
}

// The deeper page earns its click by answering what the pitch raises but
// leaves open — how the connection works, what it costs, who's behind it —
// rather than restating the capability list the reader just saw. Copy here
// must stay consistent with the flow's own claims (plan card, assurances).
function DetailsBody({ onBack }: { onBack: () => void }) {
  return (
    <div className="px-8 pt-6 pb-2">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 mb-4 text-[12px] text-theme-text-tertiary hover:text-theme-text-primary transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back
      </button>
      <div className="space-y-4 mb-4">
        <section>
          <h4 className="text-[13px] font-semibold text-theme-text-primary mb-1">How it works</h4>
          <p className="text-[12.5px] leading-relaxed text-theme-text-secondary">
            A small agent in your cluster connects outward to Radar Cloud. You approve the connection in
            your browser before anything is installed, and your cluster data stays in your cluster.
          </p>
        </section>
        <section>
          <h4 className="text-[13px] font-semibold text-theme-text-primary mb-1">What it costs</h4>
          <p className="text-[12.5px] leading-relaxed text-theme-text-secondary">
            Free for 3 clusters, no credit card. Paid plans beyond that are what keep the lights on,
            while this app stays Apache&nbsp;2.0: every feature, forever.
          </p>
        </section>
        <section>
          <h4 className="text-[13px] font-semibold text-theme-text-primary mb-1">Who's behind it</h4>
          <p className="text-[12.5px] leading-relaxed text-theme-text-secondary">
            Radar is built in the open by many hands, and overseen by a small team of humans, the kind
            you can actually talk to.{' '}
            <a href={ABOUT_URL} target="_blank" rel="noopener noreferrer" className="whitespace-nowrap underline underline-offset-2 hover:text-theme-text-primary">
              Meet us →
            </a>
          </p>
        </section>
      </div>
      <Fold summary="Prefer to run the control plane in your own VPC?" className="mb-5">
        Self-hosting is fully self-serve. Set it up yourself, whenever you're ready.{' '}
        <a href={SELF_HOSTED_DOCS_URL} target="_blank" rel="noopener noreferrer" className="text-theme-text-secondary underline underline-offset-2 hover:text-theme-text-primary">
          Read the docs
        </a>
        .
      </Fold>
    </div>
  )
}
