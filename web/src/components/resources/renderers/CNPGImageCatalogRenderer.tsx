import { Boxes } from 'lucide-react'
import { CNPGImageCatalogRenderer as BaseImageCatalog } from '@skyhook-io/k8s-ui/components/resources/renderers/CNPGDeclarativeRenderer'
import { Section, RelationshipGroup } from '@skyhook-io/k8s-ui'
import { getCNPGImageCatalogEntries } from '../resource-utils-cnpg'
import type { ResourceRef } from '@skyhook-io/k8s-ui'
import { useResources } from '../../../api/client'

const CNPG_GROUP = 'postgresql.cnpg.io'

/**
 * Host wrapper adding the reverse lookup: which clusters are pinned to this
 * catalog.
 *
 * This is the diagnosis path. A cluster that references a catalog lacking its
 * major version reports "incomplete or invalid image catalog" and stops; the
 * catalog is where you check what it offers, and from here you need to see who
 * depends on it before changing anything.
 */
export function CNPGImageCatalogRenderer({
  data,
  onNavigate,
}: {
  data: any
  onNavigate?: (ref: ResourceRef) => void
}) {
  const kind = data?.kind
  const name = data?.metadata?.name ?? ''
  const namespace = data?.metadata?.namespace ?? ''
  // A ClusterImageCatalog is cluster-scoped and may be referenced from any
  // namespace, so that lookup is unscoped.
  const scoped = kind === 'ImageCatalog'
  const enabled = !!name

  const clusters = useResources<any>('clusters', scoped ? namespace : undefined, CNPG_GROUP, { enabled })

  const users = (clusters.data ?? []).filter((c: any) => {
    const ref = c?.spec?.imageCatalogRef
    if (!ref?.name) return false
    const refKind = ref.kind || 'ImageCatalog'
    return ref.name === name && refKind === kind
  })

  // A cluster asking for a major this catalog does not carry is the failure the
  // catalog page exists to explain, and it is invisible from the cluster side —
  // there the reference looks fine.
  const majors = new Set(getCNPGImageCatalogEntries(data).map((e) => e.major))
  const unmet = users.filter((c: any) => !majors.has(c?.spec?.imageCatalogRef?.major))
  const met = users.filter((c: any) => majors.has(c?.spec?.imageCatalogRef?.major))

  const toRef = (c: any) => ({
    kind: 'Cluster',
    namespace: c?.metadata?.namespace ?? '',
    name: c?.metadata?.name ?? '',
    group: CNPG_GROUP,
  })

  return (
    <BaseImageCatalog
      data={data}
      usedBy={
        <Section title="Used By" icon={Boxes} defaultExpanded>
          {clusters.isLoading ? (
            <div className="text-sm text-theme-text-tertiary">Looking for clusters…</div>
          ) : users.length === 0 ? (
            <div className="text-sm text-theme-text-tertiary">
              {clusters.error
                ? 'Could not check which clusters use this catalog.'
                : 'No cluster is pinned to this catalog. Changing it affects nothing today.'}
            </div>
          ) : (
            <div className="space-y-3">
              {met.length > 0 && (
                <RelationshipGroup label="Clusters" refs={met.map(toRef)} onNavigate={onNavigate} />
              )}
              {unmet.length > 0 && (
                <div className="space-y-1.5">
                  <RelationshipGroup
                    label="Pinned to a version this catalog does not list"
                    refs={unmet.map(toRef)}
                    onNavigate={onNavigate}
                  />
                  <div className="text-xs text-warning-text">
                    {/* The named form only when there is a major to name — a
                        reference missing one lands here too, and "asks for
                        PostgreSQL undefined" would be worse than the general
                        sentence. */}
                    {unmet.length === 1 && typeof unmet[0]?.spec?.imageCatalogRef?.major === 'number'
                      ? `${unmet[0]?.metadata?.name} asks for PostgreSQL ${unmet[0].spec.imageCatalogRef.major}, which is not in the list above. It cannot resolve an image and will not start.`
                      : 'A major version these clusters ask for is not in the list above, so they cannot resolve an image and will not start.'}
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
