// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { useHermesProfileIdentities } from './use-hermes-profile-identities'

let root: Root | undefined
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  globalThis.localStorage?.clear()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
function client(retry: number | false = false) {
  return new QueryClient({ defaultOptions: { queries: { retry, retryDelay: 0, gcTime: 0 } } })
}
async function render(node: ReactNode, queries = client()) {
  root = createRoot(document.body.appendChild(document.createElement('div')))
  await act(async () => root!.render(<QueryClientProvider client={queries}>{node}</QueryClientProvider>))
}

function Probe() {
  const query = useHermesProfileIdentities()
  if (query.isPending) return <p role="status">loading</p>
  if (query.isError) return <p role="alert">{query.error instanceof Error ? query.error.message : 'error'}</p>
  return <ul>{query.data.map(p => <li key={p.name}>{`${p.name}|${p.provider}|${p.model}`}</li>)}</ul>
}

it('loads actual profile identities from the owning list route without exposing extra fields', async () => {
  const http = vi.fn().mockResolvedValue(Response.json({ profiles: [
    { name: 'argus-developer', provider: 'synthetic-provider', model: 'synthetic-model', api_key: 'never-render' },
    { name: 'argus-reviewer', model: { provider: 'nested-provider', default: 'nested-model' } },
  ] }))
  vi.stubGlobal('fetch', http)
  await render(<Probe />)
  expect(await screen.findByText('argus-developer|synthetic-provider|synthetic-model')).toBeTruthy()
  expect(screen.getByText('argus-reviewer|nested-provider|nested-model')).toBeTruthy()
  expect(document.body.textContent).not.toContain('never-render')
  expect(http).toHaveBeenCalledTimes(1)
  expect(String(http.mock.calls[0][0])).toBe('/api/profiles/list')
})

it('reports a failed profile list once and never invents identities (hook disables retry)', async () => {
  const http = vi.fn().mockResolvedValue(Response.json({ error: 'Unauthorized' }, { status: 401 }))
  vi.stubGlobal('fetch', http)
  await render(<Probe />, client(3))
  expect((await screen.findByRole('alert')).textContent).toBe('Hermes profile list failed (401)')
  expect(screen.queryByRole('listitem')).toBeNull()
  expect(http).toHaveBeenCalledTimes(1)
})
