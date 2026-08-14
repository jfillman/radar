import { useQuery } from '@tanstack/react-query'
import type { PolicyResourceResponse, PolicyCoverageResponse } from '@skyhook-io/k8s-ui'
import { fetchJSON } from './client'

// /api/policy/resource/{kind}/{namespace}/{name}
//
// Policy results change when the engine rescans rather than on every render, so
// a short stale window keeps drawer navigation instant without going stale in a
// way an operator would notice.
export function usePolicyResource(kind: string, namespace: string, name: string, enabled = true) {
  return useQuery<PolicyResourceResponse>({
    queryKey: ['policy', 'resource', kind, namespace, name],
    queryFn: () =>
      fetchJSON<PolicyResourceResponse>(
        `/policy/resource/${encodeURIComponent(kind)}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
      ),
    enabled: enabled && !!kind && !!namespace && !!name,
    staleTime: 15000,
    // A 403 is a settled answer about this identity, not a blip — retrying
    // would just repeat the denial on every drawer open.
    retry: false,
  })
}

// /api/policy/policies/{policy}
//
// The inverse lookup: every resource one policy recorded an outcome for. A
// namespaced Kyverno Policy reports as "namespace/name", so the namespace is
// passed through and the server tries both shapes.
// `limit` raises the per-rule subject bound. It is part of the query key so
// asking for more is a separate fetch rather than a mutation of the cached one,
// and the default response stays cached for every other drawer open.
export function usePolicyCoverage(
  policy: string,
  namespace?: string,
  enabled = true,
  limit?: number,
  /**
   * Whatever identifies the caller's current namespace view. The server applies
   * that filter from session state, so it changes the response body without
   * changing the URL — it has to be in the key or the cache serves the previous
   * scope's answer under the new scope's heading.
   */
  viewFilter = '',
) {
  return useQuery<PolicyCoverageResponse>({
    queryKey: ['policy', 'coverage', policy, namespace ?? '', limit ?? 0, viewFilter],
    queryFn: () => {
      const params = new URLSearchParams()
      if (namespace) params.set('namespace', namespace)
      if (limit) params.set('limit', String(limit))
      const qs = params.toString()
      return fetchJSON<PolicyCoverageResponse>(
        `/policy/policies/${encodeURIComponent(policy)}${qs ? `?${qs}` : ''}`,
      )
    },
    enabled: enabled && !!policy,
    staleTime: 15000,
    retry: false,
    // Raising the limit is a new query key, and without this the section would
    // fall back to its full loading state — asking to see MORE resources would
    // briefly remove the ones already on screen. The house pattern for a
    // refetch that replaces a visible list.
    placeholderData: (prev) => prev,
  })
}
