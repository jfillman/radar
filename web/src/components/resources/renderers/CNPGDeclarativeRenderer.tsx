import { Share2 } from 'lucide-react'
import {
  CNPGDatabaseRenderer as BaseDatabase,
  CNPGPublicationRenderer as BasePublication,
  CNPGSubscriptionRenderer as BaseSubscription,
} from '@skyhook-io/k8s-ui/components/resources/renderers/CNPGDeclarativeRenderer'
import { ResourceLink, Section, RelationshipGroup } from '@skyhook-io/k8s-ui'
import type { ResourceRef } from '@skyhook-io/k8s-ui'
import { useResources } from '../../../api/client'
import { getCNPGDeclarativeStatus } from '../resource-utils-cnpg'

const CNPG_GROUP = 'postgresql.cnpg.io'

/**
 * Resolves a PostgreSQL-side name back to the CR that declares it.
 *
 * A Publication says it lives in database `demo_app`; the Database CR is called
 * `demo-app` and carries `spec.name: demo_app`. The two are not the same string,
 * so the page can name the database and still leave the reader with no way to
 * open it — the dead end this exists to close.
 *
 * Returns undefined when nothing matches, and the caller falls back to plain
 * text: an unresolved name is still the truth, it just isn't a link.
 */
function useDeclaredRef(
  plural: 'databases' | 'publications',
  namespace: string,
  cluster: string | undefined,
  pgName: string | undefined,
  onNavigate?: (ref: ResourceRef) => void,
) {
  const enabled = !!namespace && !!cluster && !!pgName
  const { data } = useResources<any>(plural, namespace, CNPG_GROUP, { enabled })
  if (!enabled) return undefined
  const match = (data ?? []).find(
    (o: any) => o?.spec?.cluster?.name === cluster && o?.spec?.name === pgName,
  )
  if (!match) return undefined
  return (
    <ResourceLink
      name={pgName as string}
      kind={plural}
      namespace={match?.metadata?.namespace ?? namespace}
      group={CNPG_GROUP}
      label={pgName}
      onNavigate={
        onNavigate
          ? () =>
              onNavigate({
                kind: plural === 'databases' ? 'Database' : 'Publication',
                namespace: match?.metadata?.namespace ?? namespace,
                name: match?.metadata?.name ?? '',
                group: CNPG_GROUP,
              })
          : undefined
      }
    />
  )
}

/**
 * Database, with the objects that replicate out of it.
 *
 * The link only exists in one direction in the API: a Publication names its
 * database, a Database names nothing. Without this, "what publishes from here"
 * has no answer on the page that raises the question.
 */
export function CNPGDatabaseRenderer({
  data,
  onNavigate,
}: {
  data: any
  onNavigate?: (ref: ResourceRef) => void
}) {
  const ns = data?.metadata?.namespace ?? ''
  const cluster = data?.spec?.cluster?.name
  const dbname = data?.spec?.name
  const enabled = !!ns && !!cluster && !!dbname

  const publications = useResources<any>('publications', ns, CNPG_GROUP, { enabled })
  const subscriptions = useResources<any>('subscriptions', ns, CNPG_GROUP, { enabled })

  const inThisDatabase = (o: any) =>
    o?.spec?.cluster?.name === cluster && o?.spec?.dbname === dbname
  const pubs = (publications.data ?? []).filter(inThisDatabase)
  const subs = (subscriptions.data ?? []).filter(inThisDatabase)

  const toRef = (kind: 'Publication' | 'Subscription') => (o: any) => ({
    kind,
    namespace: o?.metadata?.namespace ?? ns,
    name: o?.metadata?.name ?? '',
    group: CNPG_GROUP,
  })

  // Applied and not-applied are different claims and cannot share a group. A
  // subscription the operator could not apply describes replication that is NOT
  // happening; rendered beside a working publication in identical chips, this
  // section asserts that data flows where it does not.
  const applied = (o: any) => getCNPGDeclarativeStatus(o).level === 'healthy'
  const livePubs = pubs.filter(applied)
  const liveSubs = subs.filter(applied)
  const declaredOnly = [
    ...pubs.filter((o: any) => !applied(o)).map((o: any) => ({ o, kind: 'Publication' as const })),
    ...subs.filter((o: any) => !applied(o)).map((o: any) => ({ o, kind: 'Subscription' as const })),
  ]

  const loading = publications.isLoading || subscriptions.isLoading
  const failed = publications.error || subscriptions.error

  return (
    <BaseDatabase
      data={data}
      onNavigate={onNavigate}
      usedBy={
        <Section title="Replication" icon={Share2} defaultExpanded>
          {loading ? (
            <div className="text-sm text-theme-text-tertiary">Looking for publications…</div>
          ) : pubs.length === 0 && subs.length === 0 ? (
            <div className="text-sm text-theme-text-tertiary">
              {failed
                ? 'Could not check what replicates out of this database.'
                : 'Nothing publishes from or subscribes to this database.'}
            </div>
          ) : (
            <div className="space-y-3">
              {livePubs.length > 0 && (
                <RelationshipGroup
                  label="Publishes from here"
                  refs={livePubs.map(toRef('Publication'))}
                  onNavigate={onNavigate}
                />
              )}
              {liveSubs.length > 0 && (
                <RelationshipGroup
                  label="Subscribes into here"
                  refs={liveSubs.map(toRef('Subscription'))}
                  onNavigate={onNavigate}
                />
              )}
              {declaredOnly.length > 0 && (
                <div className="space-y-1.5">
                  <RelationshipGroup
                    label="Declared, but not replicating"
                    refs={declaredOnly.map(({ o, kind }) => toRef(kind)(o))}
                    onNavigate={onNavigate}
                  />
                  <div className="text-xs text-warning-text">
                    {declaredOnly.length === 1
                      ? 'This exists in Kubernetes and not in PostgreSQL, so no data moves through it. Open it for the operator’s reason.'
                      : 'These exist in Kubernetes and not in PostgreSQL, so no data moves through them. Open one for the operator’s reason.'}
                  </div>
                </div>
              )}
            </div>
          )}
        </Section>
      }
    />
  )
}

export function CNPGPublicationRenderer({
  data,
  onNavigate,
}: {
  data: any
  onNavigate?: (ref: ResourceRef) => void
}) {
  const ns = data?.metadata?.namespace ?? ''
  const cluster = data?.spec?.cluster?.name
  const database = useDeclaredRef('databases', ns, cluster, data?.spec?.dbname, onNavigate)
  return <BasePublication data={data} onNavigate={onNavigate} links={{ database }} />
}

export function CNPGSubscriptionRenderer({
  data,
  onNavigate,
}: {
  data: any
  onNavigate?: (ref: ResourceRef) => void
}) {
  const ns = data?.metadata?.namespace ?? ''
  const cluster = data?.spec?.cluster?.name
  const database = useDeclaredRef('databases', ns, cluster, data?.spec?.dbname, onNavigate)
  // The publication a subscription reads from lives on the *upstream* cluster in
  // a real topology. Resolving locally is right for the single-cluster demo and
  // simply finds nothing otherwise, which falls back to plain text rather than
  // linking to the wrong object.
  const publication = useDeclaredRef(
    'publications',
    ns,
    cluster,
    data?.spec?.publicationName,
    onNavigate,
  )
  return <BaseSubscription data={data} onNavigate={onNavigate} links={{ database, publication }} />
}
