import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ARGUS_EXECUTION_IDS } from '../lib/argus-swarm-policy'

const effects = vi.hoisted(() => ({ exec: vi.fn(), execSync: vi.fn(), spawn: vi.fn(), write: vi.fn(), read: vi.fn(), realpath: vi.fn((path: string) => path) }))
vi.mock('node:child_process', () => ({
  execFile: (...args: Array<unknown>) => { effects.exec(...args); const callback = args.at(-1); if (typeof callback === 'function') callback(null, '{}', ''); return { stdin: { end: effects.write }, on: vi.fn() } },
  execFileSync: (...args: Array<unknown>) => { effects.execSync(...args); return '{}' },
  spawn: effects.spawn,
}))
vi.mock('node:fs', () => ({ existsSync: () => true, readFileSync: effects.read, readdirSync: () => [], lstatSync: () => ({ isSymbolicLink: () => false }), statSync: () => ({ mtimeMs: 1 }), realpathSync: effects.realpath, appendFileSync: effects.write, mkdirSync: effects.write, writeFileSync: effects.write, renameSync: effects.write, unlinkSync: effects.write, copyFileSync: effects.write, symlinkSync: effects.write }))
vi.mock('./claude-paths', () => ({ getProfilesDir: () => '/synthetic/profiles', getHermesRoot: () => '/synthetic', getLocalBinDir: () => '/synthetic/bin' }))
vi.mock('./swarm-memory', () => ({ appendSwarmMemoryEvent: effects.write }))
vi.mock('./swarm-roster', () => ({ rosterByWorkerId: () => new Map(ARGUS_EXECUTION_IDS.map((id) => [id, { id, wrapper: id, model: 'synthetic' }])), isSwarmWorkerId: (id: unknown) => typeof id === 'string' }))
vi.mock('./swarm-foundation', () => ({ listSwarmWorkerIds: () => [...ARGUS_EXECUTION_IDS], getSwarmProfilePath: (id: string) => `/synthetic/profiles/${id}`, patchSwarmRuntimeFile: effects.write }))
vi.mock('./swarm-model-resolver', () => ({ resolveSwarmModelLabel: () => ({ provider: 'synthetic', default: 'synthetic' }) }))
vi.mock('./auth-middleware', () => ({ isAuthenticated: () => true, requireLocalOrAuth: () => true }))
vi.mock('./gateway-capabilities', () => ({ ensureGatewayProbed: vi.fn(), dashboardFetch: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({ createFileRoute: () => (options: unknown) => ({ options }) }))

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); effects.read.mockReturnValue('{}'); effects.realpath.mockImplementation((path: string) => path); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network prohibited') })) })
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.useRealTimers(); vi.unstubAllGlobals() })
function noEffects() { expect(effects.exec).not.toHaveBeenCalled(); expect(effects.execSync).not.toHaveBeenCalled(); expect(effects.spawn).not.toHaveBeenCalled(); expect(effects.write).not.toHaveBeenCalled(); expect(effects.read).not.toHaveBeenCalled() }
async function refusal(action: () => unknown) {
  let error: unknown
  try { const pending = Promise.resolve(action()).catch((caught: unknown) => { error = caught }); await vi.runAllTimersAsync(); await pending } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain('native_control_required')
  noEffects()
}
type Handler = (context: { request: Request }) => Promise<Response>
function handler(route: unknown, method = 'POST'): Handler { return (route as { options: { server: { handlers: Record<string, Handler> } } }).options.server.handlers[method] }
function request(body: unknown) { return { request: new Request('http://synthetic.invalid/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) } }

it.each(ARGUS_EXECUTION_IDS)('refuses every legacy route for %s before effects', async (workerId) => {
  const routes = [await import('../routes/api/swarm-tmux-start'), await import('../routes/api/swarm-tmux-stop'), await import('../routes/api/swarm-tmux-scroll')]
  const lifecycle = await import('../routes/api/swarm-lifecycle')
  for (const route of routes) { vi.clearAllMocks(); const response = await handler(route.Route)(request({ workerId, direction: 'up' })); expect(response.status).toBe(409); noEffects() }
  for (const action of ['request-handoff', 'renew', 'notify-handoff-written', 'auto-sweep']) { vi.clearAllMocks(); const response = await handler(lifecycle.Route)(request({ action, workerId })); expect(response.status).toBe(409); noEffects() }
  vi.clearAllMocks()
  const response = await handler(lifecycle.Route, 'GET')({ request: new Request(`http://synthetic.invalid/api?workerId=${workerId}`) })
  expect(response.status).toBe(409); noEffects()
})

it.each(ARGUS_EXECUTION_IDS)('guards direct lifecycle and config helpers for %s', async (id) => {
  const life = await import('./swarm-lifecycle')
  const config = await import('./swarm-profile-config')
  const actions = [() => life.sendToWorker(id, 'synthetic'), () => life.getSwarmLifecycleStatus(id), () => life.requestWorkerHandoff(id), () => life.renewWorker(id), () => life.notifyHandoffWritten(id), () => life.autoSweepLifecycle(['legacy-fixture', id]), () => config.ensureSwarmProfileConfig(`/synthetic/profiles/${id}`), () => config.syncSwarmProfileModel(`/synthetic/profiles/${id}`, { provider: 'synthetic', default: 'synthetic' }), () => config.syncSwarmProfileIdentity(`/synthetic/profiles/${id}`, { id })]
  for (const action of actions) { vi.clearAllMocks(); await refusal(action) }
})

it('blocks an implicit sweep before any worker and removes legacy runtime advertisements', async () => {
  const life = await import('../routes/api/swarm-lifecycle')
  expect((await handler(life.Route)(request({ action: 'auto-sweep' }))).status).toBe(409)
  noEffects()
  const { getSwarmEnvironment } = await import('./swarm-environment')
  expect(getSwarmEnvironment().runtimeApis.some((path) => /swarm-(tmux|lifecycle)/.test(path))).toBe(false)
})

it('cannot address a native tmux session through an alternate legacy worker ID', async () => {
  const route = await import('../routes/api/swarm-tmux-scroll')
  expect((await handler(route.Route)(request({ workerId: 'legacy-fixture', session: 'swarm-argus-developer-local', direction: 'up' }))).status).toBe(409)
  noEffects()
})

it('guards direct profile aliases before config or credential access', async () => {
  const config = await import('./swarm-profile-config')
  effects.realpath.mockReturnValue('/synthetic/profiles/argus-developer-local')
  await refusal(() => config.ensureSwarmProfileConfig('/synthetic/profiles/alias'))
})
