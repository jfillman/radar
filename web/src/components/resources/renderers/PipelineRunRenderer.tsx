import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { PipelineRunRenderer as BasePipelineRunRenderer } from '@skyhook-io/k8s-ui/components/resources/renderers/PipelineRunRenderer'
import {
  buildChildTaskRunRefs,
  tektonNodeStatusFromConditions,
  type TektonTaskNodeStatus,
} from '@skyhook-io/k8s-ui/components/resources/resource-utils-tekton'
import { fetchJSON } from '../../../api/client'

interface PipelineRunRendererProps {
  data: any
}

/**
 * Host wrapper for the package's PipelineRunRenderer: a PipelineRun's
 * status.childReferences names each TaskRun it created but not the TaskRun's
 * outcome (tekton.dev/v1 dropped v1beta1's inline per-task status map), so
 * the live per-task coloring in the DAG needs one fetch per child — fanned
 * out here the same way CompositeRenderer resolves composed-resource status.
 */
export function PipelineRunRenderer({ data }: PipelineRunRendererProps) {
  const childRefs = useMemo(() => buildChildTaskRunRefs(data?.status), [data])
  const entries = useMemo(() => [...childRefs.entries()], [childRefs])

  const queries = useQueries({
    queries: entries.map(([, ref]) => ({
      queryKey: ['resource', 'taskruns', data?.metadata?.namespace ?? '', ref.taskRunName, 'tekton.dev'],
      queryFn: async () =>
        fetchJSON<{ resource: any }>(
          `/resources/taskruns/${data?.metadata?.namespace ?? '_'}/${ref.taskRunName}?group=tekton.dev`,
        ),
      staleTime: 5000,
      retry: false,
      enabled: Boolean(ref.taskRunName && data?.metadata?.namespace),
    })),
  })

  const taskStatuses = useMemo(() => {
    const map = new Map<string, { status: TektonTaskNodeStatus; reason?: string }>()
    entries.forEach(([pipelineTaskName], i) => {
      const q = queries[i]
      if (q.isLoading || !q.data) {
        map.set(pipelineTaskName, { status: 'unknown' })
        return
      }
      map.set(pipelineTaskName, tektonNodeStatusFromConditions(q.data.resource?.status?.conditions))
    })
    return map
  }, [entries, queries])

  return <BasePipelineRunRenderer data={data} taskStatuses={taskStatuses} />
}
