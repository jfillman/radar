import { useState } from 'react'
import { ConfirmDialog } from './ConfirmDialog'
import { rememberInClusterConsent } from '../../utils/inClusterConsent'

interface InClusterConsentDialogProps {
  open: boolean
  cluster?: string
  namespace: string
  /** The HTTP path the probe requests, as chosen in "what to test". */
  httpPath?: string
  /** How many declared paths the run covers. The dialog is the last screen
   *  before real traffic, so it must name what is actually about to be sent -
   *  it used to show only the cluster and namespace. */
  pathCount?: number
  onClose: () => void
  onConfirm: () => void
}

// Confirms the mutating in-cluster reachability test before it spawns a Job/pod,
// naming the cluster it lands in. Permission is enforced upstream (the button only
// renders when the capability SSAR allows), so this is a safety confirm, not authz.
export function InClusterConsentDialog({ open, cluster, namespace, httpPath, pathCount, onClose, onConfirm }: InClusterConsentDialogProps) {
  const [dontAskAgain, setDontAskAgain] = useState(false)

  function handleClose() {
    onClose()
    setDontAskAgain(false)
  }

  function handleConfirm() {
    if (dontAskAgain && cluster) rememberInClusterConsent(cluster)
    setDontAskAgain(false)
    onConfirm()
  }

  return (
    <ConfirmDialog
      open={open}
      onClose={handleClose}
      onConfirm={handleConfirm}
      title="Run in-cluster reachability test?"
      message="This creates a short-lived, self-deleting Job that sends real pod-to-pod traffic from inside the cluster, running as your own RBAC."
      details={[
        cluster ? `Cluster:   ${cluster}` : '',
        `Namespace: ${namespace}`,
        `Request:   GET ${httpPath || '/'}`,
        // The view lets you select one path; the run does not honour that
        // selection, so the count has to be stated rather than implied.
        typeof pathCount === 'number' && pathCount > 0
          ? `Covers:    all ${pathCount} declared path${pathCount === 1 ? '' : 's'} on this resource`
          : '',
      ]
        .filter(Boolean)
        .join('\n')}
      confirmLabel="Run test"
      cancelLabel="Cancel"
      variant="warning"
    >
      {/* "Don't ask again" is stored per cluster. Without a cluster identity
          there is nothing safe to key it on (one origin can front many
          clusters), so consent is never remembered - hide the checkbox rather
          than promise a persistence that doesn't stick. */}
      {cluster ? (
        <label className="flex items-center gap-2 text-sm text-theme-text-secondary">
          <input
            type="checkbox"
            checked={dontAskAgain}
            onChange={(e) => setDontAskAgain(e.target.checked)}
            className="w-4 h-4 rounded border-theme-border bg-theme-base text-amber-600 focus:ring-amber-500 focus:ring-offset-0"
          />
          <span>Don&apos;t ask again for this cluster</span>
        </label>
      ) : (
        <p className="text-xs text-theme-text-tertiary">
          Cluster identity unavailable - this confirmation can&apos;t be saved, so it will be asked on every run.
        </p>
      )}
    </ConfirmDialog>
  )
}
