import { Database } from 'lucide-react'
import { CNPGObjectStoreRenderer as BaseCNPGObjectStoreRenderer } from '@skyhook-io/k8s-ui/components/resources/renderers/CNPGObjectStoreRenderer'
import { Section, RelationshipGroup, CNPG_BARMAN_PLUGIN_NAME } from '@skyhook-io/k8s-ui'
import type { ResourceRef } from '@skyhook-io/k8s-ui'
import { useResources } from '../../../api/client'

/**
 * Host wrapper adding the reverse lookup the package renderer cannot do: which
 * CNPG Clusters back up into this store.
 *
 * The Cluster page already links forward to its ObjectStore. Without this the
 * relationship is one-way, so an operator reading a recovery window keyed by
 * server name has no route to the cluster behind it.
 */
export function CNPGObjectStoreRenderer({
  data,
  onNavigate,
}: {
  data: any
  onNavigate?: (ref: ResourceRef) => void
}) {
  const namespace = data?.metadata?.namespace ?? ''
  const storeName = data?.metadata?.name ?? ''

  // Clusters reference their store by name within their own namespace, so the
  // search is namespace-scoped rather than cluster-wide.
  const clusters = useResources<any>('clusters', namespace, 'postgresql.cnpg.io', {
    enabled: !!storeName && !!namespace,
  })

  const users = (clusters.data ?? []).filter((c: any) => {
    const plugins = c?.spec?.plugins
    if (!Array.isArray(plugins)) return false
    return plugins.some(
      (p: any) =>
        p?.name === CNPG_BARMAN_PLUGIN_NAME &&
        p?.enabled !== false &&
        p?.parameters?.barmanObjectName === storeName,
    )
  })

  return (
    <>
      <BaseCNPGObjectStoreRenderer data={data} onNavigate={onNavigate} />
      <Section title="Used By" icon={Database} defaultExpanded>
        {clusters.isLoading ? (
          <div className="text-sm text-theme-text-tertiary">Looking for clusters…</div>
        ) : users.length === 0 ? (
          // Not the same as "nothing uses it" — the caller may not be able to
          // list Clusters here, and a store with no users is worth noticing.
          <div className="text-sm text-theme-text-tertiary">
            {clusters.error
              ? 'Could not check which clusters use this store.'
              : 'No cluster in this namespace backs up to this store.'}
          </div>
        ) : (
          // The house pattern for "these other resources relate to this one":
          // labelled group with a count, ref badges, truncate-then-expand.
          <RelationshipGroup
            label="Clusters"
            refs={users.map((c: any) => ({
              kind: 'Cluster',
              namespace: c.metadata?.namespace ?? '',
              name: c.metadata?.name ?? '',
              group: 'postgresql.cnpg.io',
            }))}
            onNavigate={onNavigate}
          />
        )}
      </Section>
    </>
  )
}
