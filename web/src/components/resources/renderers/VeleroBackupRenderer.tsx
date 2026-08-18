import { LookupFailureNote } from '@skyhook-io/k8s-ui/components/resources/renderers/LookupFailureNote'
import { VeleroBackupRenderer as BaseVeleroBackupRenderer } from '@skyhook-io/k8s-ui/components/resources/renderers/VeleroBackupRenderer'
import { resolveBackupStorageLocation } from '@skyhook-io/k8s-ui/components/resources/resource-utils-velero'
import type { ResourceRef } from '@skyhook-io/k8s-ui'
import { useResources } from '../../../api/client'
import { useVeleroRunMessages } from '../../../api/policy'

/**
 * Host wrapper adding the two things a Backup cannot answer from its own status:
 * whether the storage location holding it is reachable, and what the errors and
 * warnings it counted actually say.
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
export function VeleroBackupRenderer({ data, onNavigate }: { data: any; onNavigate?: (ref: ResourceRef) => void }) {
  const messages = useRunMessages('backups', data)
  const namespace = data?.metadata?.namespace ?? ''

  const locations = useResources<any>('backupstoragelocations', namespace, 'velero.io', {
    enabled: !!namespace,
  })

  // Resolved against the list, not by name: an unset spec.storageLocation means
  // whichever location carries spec.default. Matching the literal name
  // "default" finds nothing on an install that renamed it, which silently costs
  // both the unavailable-location warning and a working link.
  const resolved = resolveBackupStorageLocation(data, locations.data)

  // Undefined until the lookup answers. A location we have not read is not a
  // healthy one, and rendering it as such is the failure this page is here to
  // avoid.
  const phase =
    locations.isLoading || locations.error
      ? undefined
      : (locations.data ?? []).find((l: any) => l?.metadata?.name === resolved)?.status?.phase

  return (
    <BaseVeleroBackupRenderer
      data={data}
      storageLocationPhase={phase}
      storageLocationName={resolved}
      messages={messages}
      onNavigate={onNavigate}
    />
  )
}

// The messages behind the counts. Nothing is fetched until the operator asks:
// reading them makes Velero create a DownloadRequest and pulls an object out of
// storage, which is not work to do on every drawer open.
function useRunMessages(kind: 'backups' | 'restores', data: any) {
  const namespace = data?.metadata?.namespace ?? ''
  const name = data?.metadata?.name ?? ''
  const fetcher = useVeleroRunMessages(kind, namespace, name)
  return {
    messages: fetcher.data,
    loading: fetcher.isPending,
    lookupNote: fetcher.error ? <LookupFailureNote errors={[fetcher.error]} what="the messages behind these counts" /> : undefined,
    onFetch: namespace && name ? () => fetcher.mutate() : undefined,
  }
}
