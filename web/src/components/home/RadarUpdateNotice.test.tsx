import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { VersionInfo } from '../../api/client'
import { RadarUpdateNotice } from './RadarUpdateNotice'

const version: VersionInfo = {
  currentVersion: '1.2.3',
  latestVersion: '1.3.0',
  updateAvailable: true,
  installMethod: 'direct',
  releaseUrl: 'https://github.com/skyhook-io/radar/releases/tag/v1.3.0',
}

describe('RadarUpdateNotice', () => {
  it('does not claim manager discovery has failed while it is loading', () => {
    const html = renderToString(<RadarUpdateNotice version={version} managerLoading />)
    expect(html).toContain('Checking how this installation is managed')
    expect(html).not.toContain('could not be confirmed')
  })

  it('deep-links exact Helm ownership when the host supports it', () => {
    const html = renderToString(
      <RadarUpdateNotice
        version={version}
        manager={{ ownership: 'helm', namespace: 'radar-system', release: 'radar' }}
        onNavigateToHelmRelease={() => {}}
      />,
    )
    expect(html).toContain('Managed by Helm release radar-system/radar')
    expect(html).toContain('Open Helm release')
  })

  it('only deep-links verified GitOps ownership', () => {
    const controllerRef = { group: 'kustomize.toolkit.fluxcd.io', kind: 'Kustomization', namespace: 'flux-system', name: 'radar' }
    const verified = renderToString(
      <RadarUpdateNotice
        version={version}
        manager={{ ownership: 'gitops', controller: 'Flux', controllerRef, controllerVerified: true }}
        onNavigateToGitOps={() => {}}
      />,
    )
    expect(verified).toMatch(/Open.*Kustomization/)

    const suspected = renderToString(
      <RadarUpdateNotice
        version={version}
        manager={{ ownership: 'gitops', controller: 'Flux', controllerRef }}
        onNavigateToGitOps={() => {}}
      />,
    )
    expect(suspected).toContain('appears to be managed by Flux')
    expect(suspected).not.toContain('Open Kustomization')
  })
})
