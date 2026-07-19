// Consent memory for the mutating in-cluster reachability test (it creates a
// short-lived Job/pod). Keyed by CLUSTER so a "don't ask again" on one cluster
// never silently suppresses the confirm on another - the cluster the pod lands
// in is the whole point of asking. Switching kube-context re-prompts.
//
// No cluster identity → no memory of ANY kind: the operator is asked on every
// run. localStorage is per-ORIGIN, and one origin (Radar Hub) can front many
// clusters, so a shared fallback key would let "don't ask again" on one cluster
// suppress the pod-creating confirm on all of them - and even an in-memory
// session flag is shared across every identity-less cluster in the session.
// The dialog hides its "don't ask again" checkbox in that case, so nothing is
// promised that doesn't stick.

const key = (cluster: string) => `radar.inClusterConsent.${cluster}`

export function inClusterConsentGiven(cluster?: string): boolean {
  if (!cluster) return false
  try {
    return localStorage.getItem(key(cluster)) === '1'
  } catch {
    // localStorage unavailable (private mode / non-browser) - fail toward asking.
    return false
  }
}

export function rememberInClusterConsent(cluster?: string): void {
  if (!cluster) return
  try {
    localStorage.setItem(key(cluster), '1')
  } catch {
    // Non-fatal: if we can't persist, the user is simply asked again next time.
  }
}
