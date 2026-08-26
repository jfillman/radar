import { describe, expect, it } from 'vitest'
import { getRolloutStep, getWorkloadDisplayStatus, getWorkloadStatus } from './resource-utils'

describe('getRolloutStep', () => {
  it('presents Argo currentStepIndex as a one-based step number', () => {
    expect(getRolloutStep({
      spec: { strategy: { canary: { steps: [{ setWeight: 25 }, { pause: {} }] } } },
      status: { currentStepIndex: 0 },
    })).toBe('1/2')
  })

  it('clamps Argo completed steps to the declared step count', () => {
    expect(getRolloutStep({
      spec: { strategy: { canary: { steps: [{ setWeight: 25 }, { pause: {} }] } } },
      status: { currentStepIndex: 2 },
    })).toBe('2/2')
  })
})

describe('getWorkloadStatus', () => {
  it('keeps a capacity-preserving surge healthy', () => {
    expect(getWorkloadStatus({
      spec: { replicas: 1 },
      status: { readyReplicas: 2, availableReplicas: 1, updatedReplicas: 1 },
    }, 'deployments')).toMatchObject({ text: '1/1', level: 'healthy' })
  })

  it('shows health instead of Stable for an idle under-replicated workload', () => {
    expect(getWorkloadDisplayStatus({
      metadata: { generation: 2 },
      spec: { replicas: 3 },
      status: {
        observedGeneration: 2,
        replicas: 2,
        updatedReplicas: 3,
        readyReplicas: 2,
        availableReplicas: 2,
      },
    }, 'deployments').status).toMatchObject({ text: '2/3', level: 'degraded' })
  })

  it('shows rollout activity while a revision is progressing', () => {
    expect(getWorkloadDisplayStatus({
      metadata: { generation: 2 },
      spec: { replicas: 3 },
      status: {
        observedGeneration: 2,
        replicas: 4,
        updatedReplicas: 2,
        readyReplicas: 3,
        availableReplicas: 3,
      },
    }, 'deployments').status).toMatchObject({ text: 'Rolling out', level: 'neutral' })
  })
})
