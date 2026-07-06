// Consent memory for the mutating in-cluster reachability test (it creates a
// short-lived Job/pod). Keyed by CLUSTER so a "don't ask again" on one cluster
// never silently suppresses the confirm on another - the cluster the pod lands
// in is the whole point of asking. Switching kube-context re-prompts.

const key = (cluster?: string) => `radar.inClusterConsent.${cluster || 'current'}`

export function inClusterConsentGiven(cluster?: string): boolean {
  try {
    return localStorage.getItem(key(cluster)) === '1'
  } catch {
    // localStorage unavailable (private mode / non-browser) - fail toward asking.
    return false
  }
}

export function rememberInClusterConsent(cluster?: string): void {
  try {
    localStorage.setItem(key(cluster), '1')
  } catch {
    // Non-fatal: if we can't persist, the user is simply asked again next time.
  }
}
