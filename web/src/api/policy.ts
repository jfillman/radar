import { useQuery } from '@tanstack/react-query'
import type { PolicyResourceResponse } from '@skyhook-io/k8s-ui'
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
