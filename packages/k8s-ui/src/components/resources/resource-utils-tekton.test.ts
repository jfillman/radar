import { describe, expect, it } from 'vitest'
import { buildPipelineTaskGraph, type TektonTaskNode } from './resource-utils-tekton'

function depsOf(nodes: TektonTaskNode[], name: string): string[] {
  return nodes.find((n) => n.name === name)?.dependsOn ?? []
}

describe('buildPipelineTaskGraph', () => {
  it('reads explicit runAfter as a direct dependency', () => {
    const nodes = buildPipelineTaskGraph({
      tasks: [
        { name: 'a', params: [] },
        { name: 'b', runAfter: ['a'], params: [] },
      ],
    })
    expect(depsOf(nodes, 'b')).toEqual(['a'])
    expect(depsOf(nodes, 'a')).toEqual([])
  })

  it('infers a dependency from a $(tasks.X.results.Y) param reference', () => {
    const nodes = buildPipelineTaskGraph({
      tasks: [
        { name: 'a', params: [] },
        { name: 'b', params: [{ name: 'in', value: '$(tasks.a.results.out)' }] },
      ],
    })
    expect(depsOf(nodes, 'b')).toEqual(['a'])
  })

  // Pins the real bug found live on the "build" Pipeline (platform-catalog
  // namespace): build-source's only runAfter is start-build-stage-span, but
  // it also pipes a trace ID from start-flow and a config blob from
  // validate-config into its params — both genuine result-ref dependencies,
  // and both already implied by the runAfter chain
  // (start-build-stage-span <- start-flow <- validate-config). Drawing all
  // three as direct edges put 3 arrows into build-source in the DAG instead
  // of the single "runs right after start-build-stage-span" edge a reader
  // expects.
  it('drops a result-ref dependency already implied by another dependency (transitive reduction)', () => {
    const nodes = buildPipelineTaskGraph({
      tasks: [
        { name: 'clone-repo', params: [] },
        { name: 'validate-config', runAfter: ['clone-repo'], params: [] },
        { name: 'start-flow', runAfter: ['validate-config'], params: [] },
        {
          name: 'start-build-stage-span',
          runAfter: ['start-flow'],
          params: [{ name: 'flow-traceparent', value: '$(tasks.start-flow.results.traceparent)' }],
        },
        {
          name: 'build-source',
          runAfter: ['start-build-stage-span'],
          params: [
            { name: 'config-json', value: '$(tasks.validate-config.results.config-json)' },
            { name: 'flow-traceparent', value: '$(tasks.start-flow.results.traceparent)' },
            { name: 'stage-span-id', value: '$(tasks.start-build-stage-span.results.span-id)' },
          ],
        },
      ],
    })
    expect(depsOf(nodes, 'build-source')).toEqual(['start-build-stage-span'])
  })

  it('keeps a result-ref dependency that is NOT reachable through another dependency', () => {
    // c depends on both a and b, and b is unrelated to a — neither implies
    // the other, so both direct edges are real and must survive reduction.
    const nodes = buildPipelineTaskGraph({
      tasks: [
        { name: 'a', params: [] },
        { name: 'b', params: [] },
        {
          name: 'c',
          params: [
            { name: 'x', value: '$(tasks.a.results.out)' },
            { name: 'y', value: '$(tasks.b.results.out)' },
          ],
        },
      ],
    })
    expect(depsOf(nodes, 'c').sort()).toEqual(['a', 'b'])
  })

  it('preserves a genuine diamond (fan-out then fan-in) without over-pruning', () => {
    const nodes = buildPipelineTaskGraph({
      tasks: [
        { name: 'start', params: [] },
        { name: 'left', runAfter: ['start'], params: [] },
        { name: 'right', runAfter: ['start'], params: [] },
        { name: 'join', runAfter: ['left', 'right'], params: [] },
      ],
    })
    expect(depsOf(nodes, 'join').sort()).toEqual(['left', 'right'])
  })

  describe('finally tasks', () => {
    it('includes a finally task as a node, tagged isFinally', () => {
      const nodes = buildPipelineTaskGraph({
        tasks: [{ name: 'build', params: [] }],
        finally: [{ name: 'notify', params: [] }],
      })
      expect(nodes.map((n) => n.name).sort()).toEqual(['build', 'notify'])
      expect(nodes.find((n) => n.name === 'notify')?.isFinally).toBe(true)
      expect(nodes.find((n) => n.name === 'build')?.isFinally).toBeUndefined()
    })

    it('depends on every terminal regular task, since Tekton waits for all of them regardless of result-refs', () => {
      // build and lint both run after start and don't feed each other —
      // notify has to wait for both, even though it only reads build's result.
      const nodes = buildPipelineTaskGraph({
        tasks: [
          { name: 'start', params: [] },
          { name: 'build', runAfter: ['start'], params: [] },
          { name: 'lint', runAfter: ['start'], params: [] },
        ],
        finally: [
          { name: 'notify', params: [{ name: 'status', value: '$(tasks.build.results.outcome)' }] },
        ],
      })
      expect(depsOf(nodes, 'notify').sort()).toEqual(['build', 'lint'])
    })

    it('depends only on the single terminal task in a linear pipeline (no fan-out to prune)', () => {
      const nodes = buildPipelineTaskGraph({
        tasks: [
          { name: 'clone', params: [] },
          { name: 'build', runAfter: ['clone'], params: [] },
        ],
        finally: [{ name: 'cleanup', params: [] }],
      })
      expect(depsOf(nodes, 'cleanup')).toEqual(['build'])
    })

    it('never depends on another finally task', () => {
      const nodes = buildPipelineTaskGraph({
        tasks: [{ name: 'build', params: [] }],
        finally: [
          { name: 'notify-slack', params: [] },
          { name: 'notify-email', params: [] },
        ],
      })
      expect(depsOf(nodes, 'notify-slack')).toEqual(['build'])
      expect(depsOf(nodes, 'notify-email')).toEqual(['build'])
    })
  })
})
