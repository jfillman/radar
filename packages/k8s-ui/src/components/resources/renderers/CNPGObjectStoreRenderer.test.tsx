import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { CNPGObjectStoreRenderer } from './CNPGObjectStoreRenderer'

/**
 * A recovery window is keyed by server name, and the plugin's `serverName`
 * parameter defaults to the cluster name but can be set to anything — two
 * clusters can even share a store under distinct keys. Linking the key to a
 * Cluster page is therefore a guess, and a link is an assertion that something
 * is on the other end.
 */
const store = {
  apiVersion: 'barmancloud.cnpg.io/v1',
  kind: 'ObjectStore',
  metadata: { name: 'pg-store', namespace: 'pg' },
  spec: { configuration: { destinationPath: 's3://backups' } },
  status: {
    serverRecoveryWindow: {
      'pg-main': { firstRecoverabilityPoint: '2026-08-01T00:00:00Z', lastSuccessfulBackupTime: '2026-08-10T00:00:00Z' },
    },
  },
}

const nav = () => {}

describe('ObjectStore recovery-window server key', () => {
  it('links the key when a cluster of that name exists', () => {
    const html = renderToString(
      <CNPGObjectStoreRenderer data={store} clusterNames={new Set(['pg-main'])} onNavigate={nav} />,
    )
    expect(html).toContain('>pg-main</button>')
  })

  // A custom serverName, or a store shared under a key that is nobody's cluster.
  it('renders the key as text when no such cluster exists', () => {
    const html = renderToString(
      <CNPGObjectStoreRenderer data={store} clusterNames={new Set(['something-else'])} onNavigate={nav} />,
    )
    expect(html).toContain('pg-main')
    expect(html).not.toContain('>pg-main</button>')
  })

  // Absent means unresolved — still loading, lookup failed, or the host cannot
  // ask. None of those establish that the cluster is there.
  it('does not link when nothing resolved the key', () => {
    const html = renderToString(<CNPGObjectStoreRenderer data={store} onNavigate={nav} />)
    expect(html).toContain('pg-main')
    expect(html).not.toContain('>pg-main</button>')
  })
})
