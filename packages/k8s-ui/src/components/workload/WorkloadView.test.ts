import { describe, expect, it } from 'vitest'
import { getWorkloadHeaderStatus } from './WorkloadView'
import { getWorkloadRolloutActivity } from '../../utils/workload-rollout'

describe('getWorkloadHeaderStatus', () => {
  it('shows health instead of Stable for an idle under-replicated workload', () => {
    const deployment = {
      metadata: { generation: 2 },
      spec: { replicas: 3 },
      status: {
        observedGeneration: 2,
        replicas: 2,
        updatedReplicas: 3,
        readyReplicas: 2,
        availableReplicas: 2,
      },
    }
    const rollout = getWorkloadRolloutActivity(deployment, 'deployments')

    expect(rollout).toMatchObject({ phase: 'idle', label: 'Stable' })
    expect(getWorkloadHeaderStatus('deployments', deployment, rollout)).toMatchObject({
      text: '2/3',
      level: 'degraded',
    })
  })

  it('shows rollout activity while a revision is progressing', () => {
    const deployment = {
      metadata: { generation: 2 },
      spec: { replicas: 3 },
      status: {
        observedGeneration: 2,
        replicas: 4,
        updatedReplicas: 2,
        readyReplicas: 3,
        availableReplicas: 3,
      },
    }
    const rollout = getWorkloadRolloutActivity(deployment, 'deployments')

    expect(getWorkloadHeaderStatus('deployments', deployment, rollout)).toMatchObject({
      text: 'Rolling out',
      level: 'neutral',
    })
  })
})
