import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  owner: 'synthetic-owner' as string | null,
  dashboard: vi.fn(),
}))
vi.mock('../../server/dashboard-auth-context', () => ({
  dashboardOwner: () => mock.owner,
}))
vi.mock('../../server/dashboard-native-auth', () => ({
  DashboardAuthError: class extends Error {},
  dashboardNativeAuth: { status: () => ({ connected: true }) },
}))
vi.mock('../../server/gateway-capabilities', () => ({
  CLAUDE_DASHBOARD_URL: 'http://synthetic.invalid',
  dashboardFetch: mock.dashboard,
}))
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}))
beforeEach(() => {
  vi.clearAllMocks()
  mock.owner = 'synthetic-owner'
  mock.dashboard.mockImplementation(() => Promise.resolve(Response.json({})))
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json({ auth_required: true }))),
  )
})
afterEach(() => vi.unstubAllGlobals())
async function get(query = '') {
  const { Route } = await import('./dashboard-auth')
  const handler = (
    Route as unknown as {
      options: {
        server: {
          handlers: { GET: (c: { request: Request }) => Promise<Response> }
        }
      }
    }
  ).options.server.handlers.GET
  return handler({
    request: new Request(`http://synthetic.invalid/api/dashboard-auth${query}`),
  })
}
it('verify retains the generic UI contract but never reads a board-specific debug route', async () => {
  const response = await get('?verify=1')
  expect(response.status).toBe(200)
  expect(mock.dashboard.mock.calls.map(([path]) => path)).toEqual([
    '/api/sessions?limit=1',
    '/api/profiles',
    '/api/plugins/kanban/boards',
  ])
  const body = await response.json()
  expect(body.checks).toHaveLength(3)
  expect(body.authenticatedApiEvidence).toBe(true)
})
it('normal auth status remains unchanged and does not enumerate upstream data', async () => {
  const response = await get()
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    connected: true,
    authRequired: true,
  })
  expect(mock.dashboard).not.toHaveBeenCalled()
})
it('unauthenticated verify calls no upstream', async () => {
  mock.owner = null
  expect((await get('?verify=1')).status).toBe(401)
  expect(fetch).not.toHaveBeenCalled()
  expect(mock.dashboard).not.toHaveBeenCalled()
})
