import { describe, expect, it } from 'vitest'
import type { APIResource } from '../../types'
import { canonicalizeSelectedKind } from './ResourcesView'

const endpoints: APIResource = {
  group: '',
  version: 'v1',
  kind: 'Endpoints',
  name: 'endpoints',
  namespaced: true,
  isCrd: false,
  verbs: ['list', 'get', 'watch'],
}

const httpRoute: APIResource = {
  group: 'gateway.networking.k8s.io',
  version: 'v1',
  kind: 'HTTPRoute',
  name: 'httproutes',
  namespaced: true,
  isCrd: true,
  verbs: ['list', 'get', 'watch'],
}

describe('canonicalizeSelectedKind', () => {
  it('restores the canonical Kind when URL hydration only has the plural resource name', () => {
    expect(
      canonicalizeSelectedKind(
        { name: 'endpoints', kind: 'endpoints', group: '' },
        [endpoints],
        [endpoints]
      )
    ).toEqual({ name: 'endpoints', kind: 'Endpoints', group: '' })
  })

  it('leaves an already canonical selection alone', () => {
    expect(
      canonicalizeSelectedKind(
        { name: 'endpoints', kind: 'Endpoints', group: '' },
        [endpoints],
        [endpoints]
      )
    ).toBeNull()
  })

  it('resolves CRD deep links from Kind to plural resource name', () => {
    expect(
      canonicalizeSelectedKind(
        { name: 'HTTPRoute', kind: 'HTTPRoute', group: 'gateway.networking.k8s.io' },
        [],
        [httpRoute]
      )
    ).toEqual({ name: 'httproutes', kind: 'HTTPRoute', group: 'gateway.networking.k8s.io' })
  })
})
