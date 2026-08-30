import { GitBranch, ListChecks, Package } from 'lucide-react'
import { Section, PropertyList, Property } from '../../ui/drawer-components'
import { buildPipelineTaskGraph } from '../resource-utils-tekton'
import { PipelineDagView } from './PipelineDagView'

interface PipelineRendererProps {
  data: any
}

// A Pipeline is a template — no run to be "in progress," no conditions of
// its own. The DAG here is the declared task graph only (every node renders
// with unknown/pending styling); see PipelineRunRenderer for the live,
// per-task-status version of the same graph.
export function PipelineRenderer({ data }: PipelineRendererProps) {
  const spec = data?.spec ?? {}
  const tasks = buildPipelineTaskGraph(spec)
  const params = spec.params ?? []
  const workspaces = spec.workspaces ?? []

  return (
    <>
      <Section title="Task Graph" icon={GitBranch}>
        <PipelineDagView tasks={tasks} />
      </Section>

      {params.length > 0 && (
        <Section title="Parameters" icon={ListChecks}>
          <PropertyList>
            {params.map((p: any) => (
              <Property
                key={p.name}
                label={p.name}
                value={p.default !== undefined ? `${JSON.stringify(p.default)}${p.type ? ` (${p.type})` : ''}` : (p.type ?? 'string')}
              />
            ))}
          </PropertyList>
        </Section>
      )}

      {workspaces.length > 0 && (
        <Section title="Workspaces" icon={Package}>
          <PropertyList>
            {workspaces.map((w: any) => (
              <Property key={w.name} label={w.name} value={w.optional ? 'optional' : 'required'} />
            ))}
          </PropertyList>
        </Section>
      )}

      {spec.description && (
        <Section title="Description">
          <p className="text-sm text-theme-text-secondary whitespace-pre-wrap">{spec.description}</p>
        </Section>
      )}
    </>
  )
}
