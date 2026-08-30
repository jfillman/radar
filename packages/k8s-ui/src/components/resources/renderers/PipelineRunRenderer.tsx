import { GitBranch, ListChecks } from 'lucide-react'
import { Section, PropertyList, Property, AlertBanner, useOperationalIssuesShown } from '../../ui/drawer-components'
import { formatAge, formatDuration } from '../resource-utils'
import {
  applyTaskRunStatuses,
  buildPipelineTaskGraph,
  tektonRefName,
  type TektonTaskNodeStatus,
} from '../resource-utils-tekton'
import { PipelineDagView } from './PipelineDagView'

interface PipelineRunRendererProps {
  data: any
  // Keyed by pipelineTaskName (not TaskRun name) — injected by the host,
  // which fans out one fetch per status.childReferences entry (a
  // PipelineRun's status only names its child TaskRuns, not their outcome;
  // tekton.dev/v1 dropped the inline per-task status map v1beta1 had).
  // Absent entirely (undefined) on the DAG-only Pipeline view; present here
  // once the host resolves it, even if individual entries are still loading.
  taskStatuses?: Map<string, { status: TektonTaskNodeStatus; reason?: string }>
}

// Renders the DAG only — not the DAG plus a separate linear step list.
// Unlike Argo Rollouts' canary steps (one sequential promotion path, where a
// list reads naturally), Tekton tasks form a genuine DAG with parallel
// branches; a linear list would misrepresent the concurrency the graph
// already shows. Node color is the progress indicator.
export function PipelineRunRenderer({ data, taskStatuses }: PipelineRunRendererProps) {
  const status = data?.status ?? {}
  const conditions = status.conditions ?? []
  const succeededCond = conditions.find((c: any) => c?.type === 'Succeeded')
  const operationalIssuesShown = useOperationalIssuesShown()

  // v1 embeds the Pipeline's spec.tasks into status.pipelineSpec at run
  // time — no second fetch of the Pipeline object needed to draw the graph.
  const pipelineSpec = status.pipelineSpec ?? {}
  const declaredTasks = buildPipelineTaskGraph(pipelineSpec)
  const tasks = taskStatuses ? applyTaskRunStatuses(declaredTasks, taskStatuses) : declaredTasks

  const isFailed = succeededCond?.status === 'False'
  const startTime = status.startTime
  const completionTime = status.completionTime
  const durationMs = startTime
    ? (completionTime ? new Date(completionTime).getTime() : Date.now()) - new Date(startTime).getTime()
    : null

  return (
    <>
      {isFailed && !operationalIssuesShown && (
        <AlertBanner
          variant="error"
          title={succeededCond?.reason || 'PipelineRun failed'}
          message={succeededCond?.message}
        />
      )}

      <Section title="Task Progress" icon={GitBranch}>
        <PipelineDagView tasks={tasks} />
      </Section>

      <Section title="Run Info" icon={ListChecks}>
        <PropertyList>
          <Property label="Pipeline" value={tektonRefName(data?.spec?.pipelineRef)} />
          <Property label="Started" value={startTime ? formatAge(startTime) : undefined} />
          {completionTime && <Property label="Completed" value={formatAge(completionTime)} />}
          {durationMs !== null && <Property label="Duration" value={formatDuration(durationMs, true)} />}
        </PropertyList>
      </Section>
    </>
  )
}
