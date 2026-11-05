// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Root } from 'react-dom/client'

const fetchSessions = vi.fn()
const officeRows: unknown[] = []
vi.mock('@/lib/gateway-api', async (original) => ({ ...await original<object>(), fetchSessions: () => fetchSessions() }))
vi.mock('@tanstack/react-router', async (original) => ({ ...await original<object>(), useNavigate: () => vi.fn() }))
vi.mock('./components/office-view', () => ({ OfficeView: (props: { agentRows: unknown[] }) => { officeRows.push(props.agentRows); return null } }))
const { AgentHubLayout } = await import('./agent-hub-layout')
const { useConductorGateway } = await import('./hooks/use-conductor-gateway')
const { Conductor } = await import('./conductor')

const FAKE = ['Nova', 'Pixel', 'Blaze', 'Echo', 'Sage', 'Drift', 'Flux', 'Volt']

let root: Root | undefined
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // Use the real JSDOM browser store, not Node 26's unrelated Web Storage global.
  vi.stubGlobal('localStorage', (globalThis as typeof globalThis & { jsdom: { window: Window } }).jsdom.window.localStorage)
})
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

const lastRows = () => officeRows.at(-1) as Array<{ name: string; id: string }>

it('renders no fabricated office agents when no real sessions exist', async () => {
  fetchSessions.mockResolvedValue({ sessions: [] })
  await render(<AgentHubLayout agents={[]} />)
  await waitFor(() => expect(fetchSessions).toHaveBeenCalled())
  await waitFor(() => expect(lastRows()).toEqual([]))
  expect(JSON.stringify(officeRows)).not.toMatch(new RegExp(FAKE.join('|')))
})

it('uses real session labels, with key fallback, instead of persona names', async () => {
  const now = Date.now()
  fetchSessions.mockResolvedValue({ sessions: [
    { key: 'agent:argus-developer:main', label: 'argus-developer', updatedAt: now },
    { key: 'agent:unlabelled:main', updatedAt: now - 1000 },
  ] })
  await render(<AgentHubLayout agents={[]} />)
  await waitFor(() => expect(lastRows().map(r => r.name)).toEqual(['argus-developer', 'agent:unlabelled:main']))
  expect(JSON.stringify(lastRows())).not.toMatch(new RegExp(FAKE.join('|')))
})

let gateway: ReturnType<typeof useConductorGateway> | undefined
function GatewayProbe() { gateway = useConductorGateway(); return null }

it('maps native swarm assignments to actual worker ids with unknown model, not personas', async () => {
  fetchSessions.mockResolvedValue({ sessions: [] })
  globalThis.localStorage.setItem('conductor:active-mission', JSON.stringify({
    missionId: 'synthetic-mission', missionJobId: null, goal: 'synthetic goal', phase: 'running',
    missionStartedAt: new Date().toISOString(), isPaused: false, pausedElapsedMs: 0, accumulatedPausedMs: 0,
    pauseStartedAt: null, workerKeys: [], workerLabels: [], workerOutputs: {}, streamText: '', planText: '',
    completedAt: null, tasks: [],
  }))
  const http = vi.fn(async (input: RequestInfo | URL) => String(input).startsWith('/api/conductor-spawn?missionId=synthetic-mission')
    ? Response.json({ ok: true, mission: { id: 'synthetic-mission', status: 'running', nativeSwarm: true, updatedAt: new Date().toISOString(),
        assignments: [{ workerId: 'argus-developer', state: 'running' }, { workerId: 'argus-reviewer', state: 'blocked' }] } })
    : Response.json({ ok: false, error: 'not part of fixture' }, { status: 404 }))
  vi.stubGlobal('fetch', http)
  await render(<GatewayProbe />)
  await waitFor(() => expect(gateway?.workers.map(w => w.label)).toEqual(['argus-developer', 'argus-reviewer']))
  expect(gateway!.workers.map(w => w.model)).toEqual([null, null])
  // Raw GatewaySession.model is string | undefined: unknown stays absent, never null/fabricated.
  expect(gateway!.workers.map(w => Object.hasOwn(w.raw as object, 'model'))).toEqual([true, true])
  expect(gateway!.workers.map(w => (w.raw as { model?: unknown }).model)).toEqual([undefined, undefined])
  expect(gateway!.workers.map(w => w.displayName)).toEqual(['argus-developer · running', 'argus-reviewer · blocked'])
  expect(JSON.stringify(gateway!.workers)).not.toMatch(new RegExp([...FAKE, 'native-swarm'].join('|')))
})

function stubProfiles(response: Response) {
  const http = vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/profiles/list'
    ? response.clone()
    : Response.json({ ok: false, error: 'not part of fixture' }, { status: 404 }))
  vi.stubGlobal('fetch', http)
  return http
}

it('conductor presents real configured profile routes without claiming execution or personas', async () => {
  fetchSessions.mockResolvedValue({ sessions: [] })
  stubProfiles(Response.json({ profiles: [
    { name: 'argus-developer', provider: 'synthetic-provider', model: 'synthetic-model' },
    { name: 'parked-profile' },
  ] }))
  await render(<Conductor />)
  const panel = await screen.findByRole('region', { name: 'Hermes profile routes' })
  await waitFor(() => expect(panel.textContent).toContain('argus-developer'))
  expect(panel.textContent).toContain('synthetic-provider / synthetic-model')
  expect(panel.textContent).toContain('parked-profile')
  expect(panel.textContent).toContain('Provider not configured / Model not configured')
  expect(panel.textContent).toContain('does not prove which model executed')
  expect(document.body.textContent).not.toMatch(new RegExp(FAKE.join('|')))
  await waitFor(() => expect(JSON.stringify(officeRows.at(-1))).toContain('Configured: synthetic-provider / synthetic-model'))
  expect(JSON.stringify(officeRows)).not.toMatch(new RegExp(FAKE.join('|')))
})

it('conductor shows profile-load failure explicitly and infers no worker identities', async () => {
  fetchSessions.mockResolvedValue({ sessions: [] })
  stubProfiles(Response.json({ error: 'Unauthorized' }, { status: 401 }))
  await render(<Conductor />)
  const panel = await screen.findByRole('region', { name: 'Hermes profile routes' })
  await waitFor(() => expect(panel.querySelector('[role="alert"]')?.textContent).toBe('Hermes profiles could not be loaded. No worker identities are inferred.'))
  expect(officeRows.at(-1)).toEqual([])
  expect(document.body.textContent).not.toMatch(new RegExp(FAKE.join('|')))
})
