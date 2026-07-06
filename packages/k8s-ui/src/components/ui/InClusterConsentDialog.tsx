import { useState } from 'react'
import { ConfirmDialog } from './ConfirmDialog'
import { rememberInClusterConsent } from '../../utils/inClusterConsent'

interface InClusterConsentDialogProps {
  open: boolean
  cluster?: string
  namespace: string
  onClose: () => void
  onConfirm: () => void
}

// Confirms the mutating in-cluster reachability test before it spawns a Job/pod,
// naming the cluster it lands in. Permission is enforced upstream (the button only
// renders when the capability SSAR allows), so this is a safety confirm, not authz.
export function InClusterConsentDialog({ open, cluster, namespace, onClose, onConfirm }: InClusterConsentDialogProps) {
  const [dontAskAgain, setDontAskAgain] = useState(false)

  function handleClose() {
    onClose()
    setDontAskAgain(false)
  }

  function handleConfirm() {
    if (dontAskAgain) rememberInClusterConsent(cluster)
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
      details={`Cluster:   ${cluster ?? '(current context)'}\nNamespace: ${namespace}`}
      confirmLabel="Run test"
      cancelLabel="Cancel"
      variant="warning"
    >
      <label className="flex items-center gap-2 text-sm text-theme-text-secondary">
        <input
          type="checkbox"
          checked={dontAskAgain}
          onChange={(e) => setDontAskAgain(e.target.checked)}
          className="w-4 h-4 rounded border-theme-border bg-theme-base text-amber-600 focus:ring-amber-500 focus:ring-offset-0"
        />
        <span>Don&apos;t ask again for this cluster</span>
      </label>
    </ConfirmDialog>
  )
}
