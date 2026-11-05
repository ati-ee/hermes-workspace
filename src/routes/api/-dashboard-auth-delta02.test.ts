import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DashboardAuthError } from '../../server/dashboard-native-auth'

const mock = vi.hoisted(() => ({ error: null as unknown, dashboard: vi.fn(), gateway: vi.fn(), configWrite: vi.fn(), discovery: vi.fn(), cli: vi.fn(), authenticated: true }))
const capabilities = { dashboard: { available: true }, models: true, sessions: true, skills: true, mcp: true, mcpFallback: false, jobs: true }
vi.mock('../../server/gateway-capabilities', () => ({ dashboardFetch: mock.dashboard, gatewayFetch: mock.gateway, ensureGatewayProbed: vi.fn(() => Promise.resolve(capabilities)), getCapabilities: () => capabilities, getGatewayCapabilities: () => capabilities, getGatewayMode: () => 'dashboard', BEARER_TOKEN: '', CLAUDE_API: 'http://synthetic.invalid', CLAUDE_UPGRADE_INSTRUCTIONS: 'synthetic' }))
vi.mock('../../server/claude-api', () => ({ ensureGatewayProbed: vi.fn(() => Promise.resolve(capabilities)), getGatewayCapabilities: () => capabilities, listSessions: () => Promise.reject(mock.error), toSessionSummary: vi.fn(), createSession: mock.configWrite, updateSession: mock.configWrite, deleteSession: mock.configWrite }))
vi.mock('../../server/local-session-store', () => ({ listLocalSessions: () => [], getLocalSession: () => null, deleteLocalSession: mock.configWrite, updateLocalSessionTitle: mock.configWrite }))
vi.mock('../../server/auth-middleware', () => ({ isAuthenticated: () => mock.authenticated }))
vi.mock('../../server/local-provider-discovery', () => ({ ensureDiscovery: mock.discovery, getDiscoveredModels: () => [], ensureProviderInConfig: mock.configWrite }))
vi.mock('../../server/claude-dashboard-api', () => ({ getConfig: () => Promise.reject(mock.error), saveConfig: mock.configWrite }))
vi.mock('../../server/mcp-cli-bridge', () => ({ runHermesMcpTest: mock.cli }))
vi.mock('../../server/mcp-tools-cache', () => ({ getProbe: () => null, setProbe: mock.configWrite }))
vi.mock('../../server/hermes-cron-profiles', () => ({ listProfileCronJobs: () => [], parseProfileJobId: (id: string) => ({ profile: null, jobId: id }), createProfileCronJob: mock.configWrite, readProfileCronOutputs: () => [], runProfileCronAction: mock.configWrite, updateProfileCronJob: mock.configWrite }))
vi.mock('../../server/profiles-browser', () => ({ listProfilesWithFallback: () => Promise.reject(mock.error) }))
vi.mock('../../server/kanban-backend', () => ({ listKanbanCards: () => Promise.reject(mock.error), getKanbanBackendMeta: () => ({ id: 'synthetic' }), createKanbanCard: mock.configWrite, updateKanbanCard: mock.configWrite }))
vi.mock('../../server/claude-tasks-backend', () => ({ listClaudeTasks: () => Promise.reject(mock.error), getClaudeTasksBackendMeta: () => ({ id: 'synthetic' }), createClaudeTask: mock.configWrite }))
vi.mock('@tanstack/react-router', () => ({ createFileRoute: () => (options: unknown) => ({ options }) }))

type Case = { label: string; load: () => Promise<{ Route: unknown }>; method?: string; body?: object; query?: string; params?: Record<string, string> }
const cases: Array<Case> = [
  { label: 'overview', load: () => import('./dashboard/overview') },
  { label: 'models', load: () => import('./models') },
  { label: 'model/info', load: () => import('./model/info') },
  { label: 'sessions GET', load: () => import('./sessions') },
  { label: 'profiles/skills', load: () => import('./profiles/skills'), query: '?name=synthetic-profile' },
  { label: 'profiles/toggle-skill', load: () => import('./profiles/toggle-skill'), method: 'PUT', body: { profile: 'synthetic-profile', name: 'synthetic', enabled: true } },
  { label: 'skills/toggle', load: () => import('./skills/toggle'), method: 'POST', body: { name: 'synthetic', enabled: true } },
  { label: 'mcp GET', load: () => import('./mcp') },
  { label: 'mcp configure', load: () => import('./mcp/configure'), method: 'PUT', body: { name: 'synthetic', enabled: true } },
  { label: 'mcp discover', load: () => import('./mcp/discover'), method: 'POST', body: { name: 'synthetic', transportType: 'stdio', command: 'synthetic-never-executed', args: [] } },
  { label: 'mcp test', load: () => import('./mcp/test'), method: 'POST', body: { name: 'synthetic' } },
  { label: 'mcp delete', load: () => import('./mcp/$name'), method: 'DELETE', params: { name: 'synthetic' } },
  { label: 'mcp logs pre-stream', load: () => import('./mcp/$name.logs'), params: { name: 'synthetic' } },
  { label: 'jobs active GET', load: () => import('./claude-jobs'), query: '?profiles=active' },
  { label: 'job GET', load: () => import('./claude-jobs.$jobId'), params: { jobId: 'synthetic' } },
  { label: 'skills GET', load: () => import('./skills') },
  { label: 'OAuth poll Dashboard boundary', load: () => import('./oauth.poll-token'), method: 'POST', body: { provider: 'synthetic', deviceCode: 'synthetic' } },
  { label: 'profiles/list', load: () => import('./profiles/list') },
  { label: 'swarm-kanban GET only', load: () => import('./swarm-kanban') },
  { label: 'claude-tasks GET only', load: () => import('./claude-tasks') },
]

type Handler = (context: { request: Request; params: Record<string, string> }) => Promise<Response>
async function invoke(entry: Case) {
  const { Route } = await entry.load()
  const method = entry.method || 'GET'
  const handler = (Route as { options: { server: { handlers: Record<string, Handler> } } }).options.server.handlers[method]
  const request = new Request(`http://synthetic.invalid/api${entry.query || ''}`, { method, headers: { 'content-type': 'application/json' }, ...(entry.body ? { body: JSON.stringify(entry.body) } : {}) })
  return handler({ request, params: entry.params || {} })
}
beforeEach(() => {
  vi.clearAllMocks(); mock.authenticated = true
  mock.error = new DashboardAuthError(401, 'synthetic private error body must not leak')
  mock.dashboard.mockImplementation(() => Promise.reject(mock.error))
  mock.gateway.mockImplementation(() => Promise.resolve(Response.json({ active_agents: 0 })))
  mock.discovery.mockResolvedValue(undefined)
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('offline fixture: real network prohibited') }))
})
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); expect(mock.configWrite).not.toHaveBeenCalled(); expect(mock.cli).not.toHaveBeenCalled(); vi.unstubAllGlobals() })

it.each(cases)('maps Dashboard 401 to structured needs-login in $label, never healthy-empty or fallback', async (entry) => {
  const response = await invoke(entry)
  expect(response.status).toBe(401)
  const body = await response.json()
  expect(body).toMatchObject({ code: 'dashboard_auth_required', needs_login: true, login_url: '/dashboard-connect' })
  expect(JSON.stringify(body)).not.toContain('synthetic private error body')
  expect(body.ok).not.toBe(true)
})

it('keeps non-auth overview failure distinct and does not invent a login requirement', async () => {
  mock.error = new Error('synthetic unavailable')
  const response = await invoke(cases[0])
  expect(response.status).toBe(200)
  expect((await response.json()).status).toBeNull()
})

it.each([0, 1, 12])('preserves Dashboard unavailable status without a false login requirement (case %s)', async (index) => {
  mock.error = new DashboardAuthError(502, 'synthetic private unavailable body')
  const response = await invoke(cases[index])
  expect(response.status).toBe(502)
  expect(await response.json()).toMatchObject({ code: 'dashboard_auth_unavailable', needs_login: false })
})

it('preserves authenticated model metadata on the healthy model/info path', async () => {
  mock.dashboard.mockResolvedValue(Response.json({ model: 'synthetic-saved-model', provider: 'synthetic-saved-provider' }))
  const response = await invoke(cases[2])
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ model: 'synthetic-saved-model', provider: 'synthetic-saved-provider' })
})

it('keeps Workspace password denial separate from Dashboard login and calls no upstream', async () => {
  mock.authenticated = false
  const response = await invoke(cases[1])
  expect(response.status).toBe(401)
  expect((await response.json()).needs_login).toBeUndefined()
  expect(mock.dashboard).not.toHaveBeenCalled()
})
