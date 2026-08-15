import { Workflow } from 'lucide-react'
import { clsx } from 'clsx'
import { Section, PropertyList, Property, AlertBanner } from '@skyhook-io/k8s-ui'
import { LookupFailureNote } from '@skyhook-io/k8s-ui/components/resources/renderers/LookupFailureNote'
import { HEALTH_BADGE_COLORS } from '@skyhook-io/k8s-ui/utils/badge-colors'
import {
  getKyvernoRequestState,
  getKyvernoRequestMessage,
} from '@skyhook-io/k8s-ui/components/resources/resource-utils-kyverno-queue'
import { formatAge } from '@skyhook-io/k8s-ui/components/resources/resource-utils'
import { useResources, isForbiddenError } from '../../../api/client'

/** A request sitting this long is not mid-flight. Kyverno retries on every
 *  reconcile, so past this point a backlog grows rather than drains. */
const STALLED_MINUTES = 5

/** Enough at once to be worth raising even while it is still moving. */
const BACKLOG_SIZE = 25

/**
 * The banner headline, or null when a queue is doing what a queue does.
 *
 * Only the first case has measured that the work stopped. The second says how
 * much is waiting and nothing more: everything in it is younger than the stall
 * threshold, so it is as likely to be a burst draining normally — asserting it
 * is not being processed would be a claim about the controller made from
 * evidence that suggests the opposite.
 */
export function queueBannerTitle(
  pending: number,
  stalledMinutes: number,
  oldestAge: string,
): string | null {
  if (stalledMinutes >= STALLED_MINUTES) return `Queued work has not moved for ${oldestAge}`
  if (pending >= BACKLOG_SIZE) return `${pending} requests are queued`
  return null
}

/**
 * Whether a queued request belongs to this policy.
 *
 * Exactly one form matches, never both. A namespaced Policy is recorded as
 * `namespace/name` and a cluster-scoped one bare, and Kyverno permits the two
 * to share a name — so accepting the bare form as a fallback hands a namespaced
 * policy the backlog of a ClusterPolicy it has nothing to do with. The coverage
 * lookup refuses the same fallback for the same reason.
 */
export function requestBelongsTo(request: any, name: string, namespace: string): boolean {
  const policy = request?.spec?.policy
  if (!policy || !name) return false
  return policy === (namespace ? `${namespace}/${name}` : name)
}

/**
 * What this policy has queued and not finished.
 *
 * A generate or mutate-existing rule does its work through queued requests, and
 * the way that fails in practice is a pile-up rather than one bad request:
 * upstream reports describe thousands stuck in Pending, never cleaned up, taken
 * up again on every reconcile. That is a count, and a count belongs next to the
 * policy — the requests have their own page, but nobody watches it.
 *
 * Silent when the policy has queued nothing, so it never adds an empty section
 * to the majority of policies that only validate.
 */
export function KyvernoPolicyQueued({ data }: { data: any }) {
  const name = data?.metadata?.name ?? ''
  const namespace = data?.metadata?.namespace ?? ''
  // Requests live in the engine's own namespace whatever the policy's is, so
  // this asks for every namespace and filters by the policy they name.
  //
  // KNOWN LIMIT: passing no namespace does not mean cluster-wide here. The
  // resources endpoint falls back to the caller's namespace view filter, so a
  // reader who has narrowed the header to their own namespace gets none of
  // Kyverno's and this section stays silent — the one case where its silence is
  // not "nothing is queued". Reaching past the filter needs the endpoint to opt
  // out of it, the way the capacity surfaces deliberately do; until then the
  // warning is unavailable to a filtered reader rather than wrong.
  const {
    data: requests,
    error,
  } = useResources<any>('updaterequests', undefined, 'kyverno.io', {
    enabled: !!name,
  })

  const mine = (requests ?? []).filter((u: any) => requestBelongsTo(u, name, namespace))
  if (mine.length === 0) {
    // An empty list and an unreadable one are not the same answer, but they do
    // not deserve the same treatment either. Being denied `updaterequests` is
    // cluster-static and would put an identical note on every policy page,
    // including the majority that only validate and never queue anything — the
    // house rule for a bonus surface is to hide the expected state and keep the
    // genuine fault, which is neither permanent nor beyond acting on.
    if (!error || isForbiddenError(error)) return null
    return (
      <Section title="Queued Work" icon={Workflow}>
        <LookupFailureNote errors={[error]} what="what this policy has queued" />
      </Section>
    )
  }

  const byState = mine.reduce<Record<string, number>>((acc, u: any) => {
    const s = getKyvernoRequestState(u)
    acc[s.text] = (acc[s.text] ?? 0) + 1
    return acc
  }, {})
  const pending = byState['Pending'] ?? 0
  const failed = byState['Failed'] ?? 0

  // The count alone cannot tell healthy churn from a stopped controller: two
  // Pending three seconds old and two Pending forty minutes old render
  // identically. Age of the OLDEST pending request is the number that separates
  // them, and it is the one Kyverno's own troubleshooting guide sends you to
  // look for.
  const messages = Array.from(
    new Set(mine.map((u: any) => getKyvernoRequestMessage(u)).filter(Boolean) as string[]),
  )
  const oldestPending = mine
    .filter((u: any) => getKyvernoRequestState(u).text === 'Pending')
    .map((u: any) => u?.metadata?.creationTimestamp)
    .filter(Boolean)
    .sort()[0]
  const stalledMinutes = oldestPending
    ? Math.floor((Date.now() - new Date(oldestPending).getTime()) / 60000)
    : 0
  const title = queueBannerTitle(pending, stalledMinutes, formatAge(oldestPending))

  return (
    <>
      {title && (
        <AlertBanner
          variant="warning"
          title={title}
          message="Requests build up when the background controller cannot keep up or cannot reach what it needs. They are retried on every reconcile, so a backlog grows rather than drains."
        />
      )}
      <Section title="Queued Work" icon={Workflow} defaultExpanded={pending > 0 || failed > 0}>
        <PropertyList>
          <Property label="Requests" value={String(mine.length)} />
          {Object.entries(byState).map(([state, n]) => (
            <Property
              key={state}
              label={state}
              value={
                <span
                  className={clsx(
                    'badge',
                    HEALTH_BADGE_COLORS[
                      (state === 'Failed'
                        ? 'unhealthy'
                        : state === 'Pending'
                          ? 'degraded'
                          : state === 'Completed'
                            ? 'healthy'
                            : 'unknown') as keyof typeof HEALTH_BADGE_COLORS
                    ],
                  )}
                >
                  {n}
                </span>
              }
            />
          ))}
          {oldestPending && (
            <Property label="Oldest Pending" value={`${formatAge(oldestPending)} ago`} />
          )}
        </PropertyList>
        {messages.length > 0 && (
          <div className="mt-2 pt-2 border-t border-theme-border space-y-1">
            {/* Kyverno writes why it could not complete a request into
                status.message, and it is the only diagnosis this object
                carries. A count without it says something is wrong and leaves
                you to go and find out what. */}
            {messages.map((m, i) => (
              <div key={i} className="text-xs text-warning-text">{m}</div>
            ))}
          </div>
        )}
        <div className="mt-2 pt-2 border-t border-theme-border text-xs text-theme-text-secondary">
          These are deleted seconds after they complete, so this counts what is in flight right now
          rather than everything this policy has ever done.
        </div>
      </Section>
    </>
  )
}
