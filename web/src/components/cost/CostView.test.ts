import { describe, expect, it } from 'vitest'
import { resourceKindForCostWorkload } from './CostView'

describe('resourceKindForCostWorkload', () => {
  it('does not link standalone aggregate rows as pods', () => {
    expect(resourceKindForCostWorkload('standalone')).toBeNull()
  })

  it('keeps static pod rows linkable to their mirror pod', () => {
    expect(resourceKindForCostWorkload('staticpod')).toBe('Pod')
  })
})
