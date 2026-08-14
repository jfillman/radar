import { Database } from 'lucide-react'
import { CNPGObjectStoreRenderer as BaseCNPGObjectStoreRenderer } from '@skyhook-io/k8s-ui/components/resources/renderers/CNPGObjectStoreRenderer'
import { Section, RelationshipGroup, CNPG_BARMAN_PLUGIN_NAME } from '@skyhook-io/k8s-ui'
import { LookupFailureNote } from '@skyhook-io/k8s-ui/components/resources/renderers/LookupFailureNote'
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

  // Servers the store holds data for, from its own status. Deliberately a
  // separate question from the one below.
  const servers: string[] = Object.keys(data?.status?.serverRecoveryWindow ?? {})

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

  // Named in the window, absent from the plugin list — the gap the note explains.
  const listed = new Set(users.map((c: any) => c?.metadata?.name))
  const unlisted = servers.filter((s) => !listed.has(s))

  return (
    <>
      <BaseCNPGObjectStoreRenderer
        data={data}
        onNavigate={onNavigate}
        // Every Cluster in the namespace, not just the ones using this store:
        // a server key naming a cluster on the older in-tree path is still a
        // real cluster worth opening, it simply cannot appear in the list below.
        clusterNames={
          clusters.isLoading || clusters.error
            ? undefined
            : new Set((clusters.data ?? []).map((c: any) => c?.metadata?.name).filter(Boolean))
        }
      />
      <Section title="Used By" icon={Database} defaultExpanded>
        {clusters.isLoading ? (
          <div className="text-sm text-theme-text-tertiary">Looking for clusters…</div>
        ) : users.length === 0 ? (
          // Not the same as "nothing uses it" — the caller may not be able to
          // list Clusters here, and a store with no users is worth noticing.
          clusters.error ? (
            <LookupFailureNote
              errors={[clusters.error]}
              what="which clusters use this store"
            />
          ) : (
            <div className="text-sm text-theme-text-tertiary">
              No cluster in this namespace backs up to this store.
            </div>
          )
        ) : (
          // The house pattern for "these other resources relate to this one":
          // labelled group with a count, ref badges, truncate-then-expand.
          <RelationshipGroup
            label="Archiving here through the plugin"
            refs={users.map((c: any) => ({
              kind: 'Cluster',
              namespace: c.metadata?.namespace ?? '',
              name: c.metadata?.name ?? '',
              group: 'postgresql.cnpg.io',
            }))}
            onNavigate={onNavigate}
          />
        )}
        {/* This lookup can only see `spec.plugins`. A cluster still on the
            deprecated in-tree `spec.backup.barmanObjectStore` names a
            destination path and never references this CR, so it CANNOT appear
            above however much data it has here. Read as blast radius — "who
            breaks if I rotate these credentials" — the list would silently omit
            every legacy-path cluster, which mid-migration is most of a fleet.
            The recovery window is the other half of the answer. */}
        {/* Only once the plugin lookup has actually answered. Derived while the
            list is still loading — or after it failed — every server in the
            window looks like an in-tree cluster, which is a claim about their
            configuration made from having no data. */}
        {!clusters.isLoading && !clusters.error && unlisted.length > 0 && (
          <div className="mt-2 pt-2 border-t border-theme-border text-xs text-theme-text-secondary">
            {`${unlisted.join(', ')} ${unlisted.length === 1 ? 'has' : 'have'} data here but ${
              unlisted.length === 1 ? 'is' : 'are'
            } not listed above: this only finds clusters using the barman-cloud plugin, and a cluster on the older in-tree backup settings never names this record.`}
          </div>
        )}
      </Section>
    </>
  )
}
