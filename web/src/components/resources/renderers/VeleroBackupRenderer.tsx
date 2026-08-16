import { VeleroBackupRenderer as BaseVeleroBackupRenderer } from '@skyhook-io/k8s-ui/components/resources/renderers/VeleroBackupRenderer'
import { getBackupStorageLocation } from '@skyhook-io/k8s-ui/components/resources/resource-utils-velero'
import { useResources } from '../../../api/client'

/**
 * Host wrapper adding the one fact a Backup cannot observe about itself: whether
 * the storage location holding it is reachable.
 *
 * The backup's own status says Completed and goes on saying it after the bucket
 * behind it goes Unavailable. This is the page someone opens to decide whether
 * they can restore to this point, so the answer belongs here and not one screen
 * away.
 *
 * Namespace is explicit — storage locations live alongside the backups that name
 * them, in Velero's own namespace. Omitting it would inherit the reader's
 * namespace view filter, which is a browsing preference and not the scope of
 * this question.
 */
export function VeleroBackupRenderer({ data }: { data: any }) {
  const namespace = data?.metadata?.namespace ?? ''
  const wanted = getBackupStorageLocation(data)

  const locations = useResources<any>('backupstoragelocations', namespace, 'velero.io', {
    enabled: !!namespace && !!wanted,
  })

  // Undefined until the lookup answers. A location we have not read is not a
  // healthy one, and rendering it as such is the failure this page is here to
  // avoid.
  const phase =
    locations.isLoading || locations.error
      ? undefined
      : (locations.data ?? []).find((l: any) => l?.metadata?.name === wanted)?.status?.phase

  return <BaseVeleroBackupRenderer data={data} storageLocationPhase={phase} />
}
