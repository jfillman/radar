import { Share2 } from 'lucide-react'
import {
  CNPGDatabaseRenderer as BaseDatabase,
  CNPGPublicationRenderer as BasePublication,
  CNPGSubscriptionRenderer as BaseSubscription,
} from '@skyhook-io/k8s-ui/components/resources/renderers/CNPGDeclarativeRenderer'
import { ResourceLink, Section, RelationshipGroup } from '@skyhook-io/k8s-ui'
import type { ResourceRef } from '@skyhook-io/k8s-ui'
import { useResources } from '../../../api/client'

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
              {pubs.length > 0 && (
                <RelationshipGroup
                  label="Publishes from here"
                  refs={pubs.map(toRef('Publication'))}
                  onNavigate={onNavigate}
                />
              )}
              {subs.length > 0 && (
                <RelationshipGroup
                  label="Subscribes into here"
                  refs={subs.map(toRef('Subscription'))}
                  onNavigate={onNavigate}
                />
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
