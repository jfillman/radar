import { TaskRunRenderer as BaseTaskRunRenderer } from '@skyhook-io/k8s-ui/components/resources/renderers/TaskRunRenderer'
import { useOpenLogs } from '@skyhook-io/k8s-ui/components/dock'

interface TaskRunRendererProps {
  data: any
}

// Step logs open in a floating dock log tab (useOpenLogs) rather than the
// resource's own "Logs" tab — that tab's pod-discovery is built around
// BatchExecutionFullscreen's multi-run model (useWorkloadRuns), which a
// single TaskRun (exactly one pod, no run history) doesn't need.
export function TaskRunRenderer({ data }: TaskRunRendererProps) {
  const openLogs = useOpenLogs()
  const namespace = data?.metadata?.namespace ?? ''
  const podName = data?.status?.podName as string | undefined
  const steps = (data?.status?.steps ?? []) as Array<{ name: string }>
  const containers = steps.map((s) => `step-${s.name}`)

  return (
    <BaseTaskRunRenderer
      data={data}
      onViewLogs={
        podName
          ? (pod, containerName) => openLogs({ namespace, podName: pod, containers, containerName })
          : undefined
      }
    />
  )
}
