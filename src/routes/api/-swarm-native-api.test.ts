import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isAuthenticated } from '../../server/auth-middleware'
import { callNativeBridge } from '../../server/swarm-native-bridge'
import { fetchDashboardKanbanTask } from '../../server/kanban-dashboard-proxy'

vi.mock('../../server/auth-middleware', () => ({ isAuthenticated: vi.fn(() => true) }))
vi.mock('../../server/swarm-native-bridge', () => ({ callNativeBridge: vi.fn() }))
vi.mock('../../server/gateway-capabilities', () => ({ dashboardFetch: vi.fn(), ensureGatewayProbed: vi.fn(), getResolvedUrls: vi.fn(), BEARER_TOKEN: '', CLAUDE_API: 'http://synthetic.invalid' }))
vi.mock('../../server/openai-compat-api', () => ({ getBearerToken: vi.fn() }))
vi.mock('../../server/claude-api', () => ({ deleteSession: vi.fn() }))
vi.mock('../../server/kanban-dashboard-proxy', () => ({ fetchDashboardKanbanTask: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({ createFileRoute: () => (options: unknown) => ({ options }) }))

type Handler = (context: { request: Request }) => Promise<Response>
function handlers(route: unknown) { return (route as { options: { server: { handlers: { GET: Handler; POST: Handler } } } }).options.server.handlers }
let root: string
beforeEach(() => {
  vi.clearAllMocks()
  root = mkdtempSync(join(tmpdir(), 'native-api-'))
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  vi.stubEnv('HERMES_HOME', join(root, '.hermes'))
  mkdirSync(join(root, '.hermes/profiles/orchestrator-argus'), { recursive: true })
  writeFileSync(join(root, '.hermes/profiles/orchestrator-argus/config.yaml'), 'model: synthetic\n')
  writeFileSync(join(root, 'swarm.yaml'), 'workers:\n- id: orchestrator-argus\n  profile: orchestrator-argus\n')
  vi.mocked(isAuthenticated).mockReturnValue(true)
  vi.resetModules()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { force: true, recursive: true }) })
const post = (body: unknown, type = 'application/json') => ({ request: new Request('http://synthetic.invalid/api', { method: 'POST', headers: { 'Content-Type': type }, body: JSON.stringify(body) }) })

describe('real native API wiring, private fixtures only', () => {
  it('binds an existing exact native board/card read-only and excludes blocked tracking cards before admission', async () => {
    vi.mocked(fetchDashboardKanbanTask).mockResolvedValue({ id: 'synthetic-card', title: 'Synthetic tracking exclusion', status: 'blocked' })
    const { Route } = await import('./conductor-spawn')
    const denied = await handlers(Route).POST(post({ goal: 'Synthetic source task', origin: { boardId: 'synthetic-board', cardId: 'synthetic-card' } }))
    expect(denied.status).toBe(409)
    expect(await denied.json()).toMatchObject({ error: 'card_dispatch_excluded; tracking/history is not an execution admission' })
    expect(callNativeBridge).not.toHaveBeenCalled()
    expect(fetchDashboardKanbanTask).toHaveBeenCalledWith('synthetic-card', 'synthetic-board')
  })

  it('persists exact board/card/session lineage, never a fabricated Kanban managed run', async () => {
    vi.mocked(fetchDashboardKanbanTask).mockResolvedValue({ id: 'synthetic-card', title: 'Synthetic approved source task', status: 'ready' })
    const ref = { profile_id: join(root, '.hermes/profiles/orchestrator-argus'), session_id: 'synthetic-origin-session' }
    vi.mocked(callNativeBridge).mockResolvedValue({ profileId: ref.profile_id, sessionId: ref.session_id, receipt: { ref, admission_id: 'synthetic-origin-admission', status: 'queued', outcome: null } })
    const { Route } = await import('./conductor-spawn')
    const response = await handlers(Route).POST(post({ goal: 'Synthetic bounded source task', origin: { boardId: 'synthetic-board', cardId: 'synthetic-card' } }))
    expect(response.status).toBe(200)
    expect(readFileSync(join(root, '.runtime/swarm-missions.json'), 'utf8')).toContain('synthetic-board')
    expect(readFileSync(join(root, '.runtime/swarm-missions.json'), 'utf8')).toContain('synthetic-card')
    expect(vi.mocked(callNativeBridge).mock.calls[0][0].workerId).toBe('orchestrator-argus')
  })

  it('retains authentication/content-type gates and rejects arbitrary caller-minted profiles', async () => {
    const { Route } = await import('./swarm-dispatch')
    vi.mocked(isAuthenticated).mockReturnValue(false)
    expect((await handlers(Route).POST(post({}))).status).toBe(401)
    vi.mocked(isAuthenticated).mockReturnValue(true)
    expect((await handlers(Route).POST(post({}, 'text/plain'))).status).toBe(415)
    expect((await handlers(Route).POST(post({ workerIds: ['invented'], prompt: 'synthetic' }))).status).toBe(400)
    expect(callNativeBridge).not.toHaveBeenCalled()
    expect(readdirSync(join(root, '.hermes/profiles'))).toEqual(['orchestrator-argus'])
  })

  it('routes Conductor and direct-chat through actual native admission bindings, never a fake run', async () => {
    const ref = { profile_id: join(root, '.hermes/profiles/orchestrator-argus'), session_id: 'synthetic-native-session' }
    vi.mocked(callNativeBridge).mockResolvedValue({ profileId: ref.profile_id, sessionId: ref.session_id, model: 'saved-model', provider: 'saved-provider', reasoningEffort: 'saved-effort', receipt: { ref, admission_id: 'synthetic-admission', status: 'queued', outcome: null } })
    const { Route } = await import('./conductor-spawn')
    const response = await handlers(Route).POST(post({ goal: 'Private synthetic source mission', maxParallel: 5 }))
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data).toMatchObject({ mode: 'native-swarm', jobId: null, runId: null, sessionKey: null, assignments: [{ workerId: 'orchestrator-argus', state: 'queued', native: { profileId: ref.profile_id, sessionId: ref.session_id, admissionId: 'synthetic-admission', model: 'saved-model', provider: 'saved-provider', reasoningEffort: 'saved-effort' } }] })
    expect(readdirSync(join(root, '.hermes/profiles'))).toEqual(['orchestrator-argus'])
    const saved = readFileSync(join(root, '.runtime/swarm-missions.json'), 'utf8')
    expect(saved).toContain('synthetic-admission')
    expect(saved).not.toContain('ops-watch')
    expect(readdirSync(join(root, '.hermes/profiles/orchestrator-argus'))).toEqual(['config.yaml'])
    const { Route: stop } = await import('./conductor-stop')
    expect((await handlers(stop).POST(post({ missionIds: [data.missionId] }))).status).toBe(409)
    expect(readFileSync(join(root, '.runtime/swarm-missions.json'), 'utf8')).toBe(saved)
  })

  it('plans only the configured sole dispatcher and ignores caller stock/model metadata', async () => {
    const { Route } = await import('./swarm-decompose')
    const response = await handlers(Route).POST(post({ prompt: 'Synthetic plan', workers: [{ id: 'builder', model: 'invented' }] }))
    expect(await response.json()).toMatchObject({ ok: true, assignments: [{ workerId: 'orchestrator-argus' }], model: null })
    expect(callNativeBridge).not.toHaveBeenCalled()
  })
})
