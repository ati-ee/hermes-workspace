import { expect, it, vi } from 'vitest'
import { DashboardAuthError } from '../../server/dashboard-native-auth'
import { listClaudeTasks } from '../../server/claude-tasks-backend'

vi.mock('../../server/auth-middleware', () => ({ isAuthenticated: () => true }))
vi.mock('../../server/claude-tasks-backend', () => ({ listClaudeTasks: vi.fn(), createClaudeTask: vi.fn(), getClaudeTasksBackendMeta: () => ({ id: 'hermes-proxy', label: 'Synthetic native feed' }) }))
vi.mock('@tanstack/react-router', () => ({ createFileRoute: () => (options: unknown) => ({ options }) }))

it('returns structured Dashboard 401/needs-login instead of an unhandled task-list failure', async () => {
  vi.mocked(listClaudeTasks).mockRejectedValueOnce(new DashboardAuthError(401))
  const { Route } = await import('./claude-tasks')
  const get = (Route as unknown as { options: { server: { handlers: { GET: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.GET
  const result = await get({ request: new Request('http://synthetic.invalid/api/claude-tasks?assignee=argus-reviewer') })
  expect(result.status).toBe(401)
  expect(await result.json()).toMatchObject({ code: 'dashboard_auth_required', needs_login: true, login_url: '/dashboard-connect' })
  vi.mocked(listClaudeTasks).mockResolvedValueOnce([])
  const empty = await get({ request: new Request('http://synthetic.invalid/api/claude-tasks') })
  expect(empty.status).toBe(200)
  expect(await empty.json()).toMatchObject({ tasks: [], source: 'hermes-proxy', boardId: 'default' })
})
