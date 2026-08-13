import { Database } from 'lucide-react'
import { CNPGClusterRenderer as BaseCNPGClusterRenderer } from '@skyhook-io/k8s-ui/components/resources/renderers/CNPGClusterRenderer'
import { Section, RelationshipGroup, getCNPGDeclarativeStatus } from '@skyhook-io/k8s-ui'
import type { ResourceRef } from '@skyhook-io/k8s-ui'
import { useResources } from '../../../api/client'

const CNPG_GROUP = 'postgresql.cnpg.io'

/**
 * Host wrapper adding the reverse lookup: which Databases, Publications and
 * Subscriptions are declared against this cluster.
 *
 * Each of those objects links forward to its cluster. Without this the
 * relationship is one-way, so an operator reading a cluster has no way to see
 * that three databases were declared against it and one of them never applied.
 */
export function CNPGClusterRenderer({
  data,
  onNavigate,
}: {
  data: any
  onNavigate?: (ref: ResourceRef) => void
}) {
  const namespace = data?.metadata?.namespace ?? ''
  const name = data?.metadata?.name ?? ''
  const enabled = !!namespace && !!name

  const databases = useResources<any>('databases', namespace, CNPG_GROUP, { enabled })
  const publications = useResources<any>('publications', namespace, CNPG_GROUP, { enabled })
  const subscriptions = useResources<any>('subscriptions', namespace, CNPG_GROUP, { enabled })

  const mine = (items: any[] | undefined) =>
    (items ?? []).filter((o) => o?.spec?.cluster?.name === name)

  const dbs = mine(databases.data)
  const pubs = mine(publications.data)
  const subs = mine(subscriptions.data)
  const total = dbs.length + pubs.length + subs.length

  const loading = databases.isLoading || publications.isLoading || subscriptions.isLoading
  const failed = databases.error || publications.error || subscriptions.error

  // Not applied is the state worth surfacing here: the manifest exists and
  // PostgreSQL does not have the object. Counting it on the cluster is how an
  // operator notices without opening each one.
  const notApplied = [...dbs, ...pubs, ...subs].filter(
    (o) => getCNPGDeclarativeStatus(o).level === 'unhealthy',
  ).length

  const refs = (items: any[], kind: string) =>
    items.map((o) => ({
      kind,
      namespace: o?.metadata?.namespace ?? '',
      name: o?.metadata?.name ?? '',
      group: CNPG_GROUP,
    }))

  return (
    <>
      <BaseCNPGClusterRenderer
        data={data}
        onNavigate={onNavigate}
        declared={
          <Section title="Declared Objects" icon={Database} defaultExpanded={notApplied > 0}>
            {loading ? (
              <div className="text-sm text-theme-text-tertiary">Looking for declared objects…</div>
            ) : total === 0 ? (
              // "None declared" and "could not check" are different answers, and
              // only one of them means the cluster has no declarative objects.
              <div className="text-sm text-theme-text-tertiary">
                {failed
                  ? 'Could not check which databases are declared against this cluster.'
                  : 'No Database, Publication or Subscription is declared against this cluster.'}
              </div>
            ) : (
              <div className="space-y-3">
                {notApplied > 0 && (
                  <div className="text-sm text-warning-text">
                    {`${notApplied} of ${total} could not be applied to PostgreSQL — the manifest exists, the object does not.`}
                  </div>
                )}
                {dbs.length > 0 && (
                  <RelationshipGroup label="Databases" refs={refs(dbs, 'Database')} onNavigate={onNavigate} />
                )}
                {pubs.length > 0 && (
                  <RelationshipGroup label="Publications" refs={refs(pubs, 'Publication')} onNavigate={onNavigate} />
                )}
                {subs.length > 0 && (
                  <RelationshipGroup label="Subscriptions" refs={refs(subs, 'Subscription')} onNavigate={onNavigate} />
                )}
              </div>
            )}
          </Section>
        }
      />
    </>
  )
}
