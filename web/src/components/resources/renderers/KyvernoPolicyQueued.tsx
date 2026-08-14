import { Workflow } from 'lucide-react'
import { clsx } from 'clsx'
import { Section, PropertyList, Property, AlertBanner } from '@skyhook-io/k8s-ui'
import { HEALTH_BADGE_COLORS } from '@skyhook-io/k8s-ui/utils/badge-colors'
import { getKyvernoRequestState } from '@skyhook-io/k8s-ui/components/resources/resource-utils-kyverno-queue'
import { useResources } from '../../../api/client'

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
  // this is an unscoped lookup filtered by the policy they name.
  const { data: requests } = useResources<any>('updaterequests', undefined, 'kyverno.io', {
    enabled: !!name,
  })

  const mine = (requests ?? []).filter((u: any) => requestBelongsTo(u, name, namespace))
  if (mine.length === 0) return null

  const byState = mine.reduce<Record<string, number>>((acc, u: any) => {
    const s = getKyvernoRequestState(u)
    acc[s.text] = (acc[s.text] ?? 0) + 1
    return acc
  }, {})
  const pending = byState['Pending'] ?? 0
  const failed = byState['Failed'] ?? 0

  return (
    <>
      {/* The pile-up is the failure. A handful mid-flight is normal. */}
      {pending >= 25 && (
        <AlertBanner
          variant="warning"
          title={`${pending} requests are queued and not being processed`}
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
        </PropertyList>
        <div className="mt-2 pt-2 border-t border-theme-border text-xs text-theme-text-secondary">
          These are deleted seconds after they complete, so this counts what is in flight right now
          rather than everything this policy has ever done.
        </div>
      </Section>
    </>
  )
}
