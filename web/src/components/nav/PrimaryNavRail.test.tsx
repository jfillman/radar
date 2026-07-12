import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { PrimaryNavRail } from './PrimaryNavRail'

function renderRail(showCapacity: boolean) {
  return renderToString(
    <PrimaryNavRail
      activeView="home"
      onNavigate={() => {}}
      pinned
      onTogglePinned={() => {}}
      showCapacity={showCapacity}
    />,
  )
}

describe('PrimaryNavRail Karpenter discovery gate', () => {
  it('shows Capacity when Karpenter NodePools are discoverable', () => {
    expect(renderRail(true)).toContain('Capacity')
  })

  it('does not add irrelevant navigation on clusters without Karpenter', () => {
    expect(renderRail(false)).not.toContain('Capacity')
  })
})
