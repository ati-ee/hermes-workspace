// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Root } from 'react-dom/client'

const fetchModels = vi.fn()
vi.mock('@/lib/gateway-api', async (original) => ({ ...await original<object>(), fetchModels: () => fetchModels() }))
const { OperationsNewAgentModal } = await import('./operations-new-agent-modal')

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

const modal = () => <OperationsNewAgentModal open defaultModel="" onClose={() => {}} onCreate={async () => {}} isSaving={false} />

it('shows model catalog loading state while the request is pending', async () => {
  fetchModels.mockReturnValue(new Promise(() => {}))
  await render(modal())
  expect((await screen.findByRole('status')).textContent).toBe('Loading models...')
  expect(screen.queryByRole('alert')).toBeNull()
})

it('shows the actual catalog error and retries to an explicit empty-catalog state', async () => {
  fetchModels.mockRejectedValueOnce(new Error('synthetic catalog unavailable')).mockResolvedValueOnce({ models: [] })
  await render(modal())
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('synthetic catalog unavailable')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('No models are available for the active connection.'))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(fetchModels).toHaveBeenCalledTimes(2)
})

it('shows no catalog notice once real models load', async () => {
  fetchModels.mockResolvedValue({ models: [{ id: 'synthetic/model-a', provider: 'synthetic', name: 'model-a' }] })
  await render(modal())
  await waitFor(() => expect(fetchModels).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  expect(screen.queryByRole('alert')).toBeNull()
})
