import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ARGUS_EXECUTION_IDS } from '../../lib/argus-swarm-policy'
import type { ParsedSwarmCheckpoint } from '../../server/swarm-checkpoints'

const fixture = vi.hoisted(() => ({ root: '', authenticated: true }))
const effects = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), mkdir: vi.fn(), notify: vi.fn(), process: vi.fn(), snapshot: vi.fn(), profile: vi.fn(), realpath: vi.fn((path: string) => path) }))
vi.mock('node:fs', () => ({ existsSync: () => true, mkdirSync: effects.mkdir, writeFileSync: effects.write, renameSync: effects.write, readFileSync: effects.read, realpathSync: effects.realpath, lstatSync: () => ({ isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false }), accessSync: vi.fn(), constants: { R_OK: 4 } }))
vi.mock('node:child_process', () => ({ execFileSync: effects.process, execFile: effects.process, spawn: effects.process }))
vi.mock('../../server/claude-paths', () => ({ getProfilesDir: () => `${fixture.root}/profiles`, getHermesRoot: () => fixture.root }))
vi.mock('../../server/swarm-foundation', () => ({ getSwarmProfilePath: effects.profile }))
vi.mock('../../server/auth-middleware', () => ({ isAuthenticated: () => fixture.authenticated }))
vi.mock('../../server/swarm-roster', () => ({ isSwarmWorkerId: (id: unknown) => typeof id === 'string' && /^[a-z][a-z0-9-]*$/.test(id) }))
vi.mock('../../server/swarm-memory', () => ({ appendSwarmMemoryEvent: effects.notify }))
vi.mock('../../server/chat-event-bus', () => ({ publishChatEvent: effects.notify }))
vi.mock('./swarm-dispatch', () => ({ readRuntimeCheckpointSnapshot: effects.snapshot, checkpointFromRuntimeSnapshot: () => checkpoint }))
vi.mock('@tanstack/react-router', () => ({ createFileRoute: () => (options: unknown) => ({ options }) }))

const checkpoint: ParsedSwarmCheckpoint = { stateLabel: 'DONE', runtimeState: 'idle', checkpointStatus: 'done', filesChanged: 'synthetic', commandsRun: 'synthetic', result: 'synthetic', blocker: null, nextAction: 'review', raw: 'synthetic checkpoint' }
const nativeIds = ARGUS_EXECUTION_IDS.flatMap((id) => [id, `swarm-${id}`])
type Handler = (ctx: { request: Request }) => Promise<Response>
async function post(workerId: string) {
  const { Route } = await import('./swarm-checkpoint')
  const handler = (Route as unknown as { options: { server: { handlers: { POST: Handler } } } }).options.server.handlers.POST
  return handler({ request: new Request('http://synthetic.invalid/api/swarm-checkpoint', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workerId, state: 'idle', checkpointStatus: 'done' }) }) })
}
function noEffects() {
  expect(effects.read.mock.calls.filter(([path]) => /(?:runtime\.json|state\.db)$/.test(String(path)))).toEqual([])
  for (const effect of [effects.write, effects.mkdir, effects.notify, effects.process, effects.snapshot]) expect(effect).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
}
beforeEach(async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  fixture.root = fs.mkdtempSync(`${process.env.TMPDIR}/delta04-checkpoint-`)
  fixture.authenticated = true
  vi.clearAllMocks()
  effects.realpath.mockImplementation((path: string) => path)
  effects.profile.mockImplementation((id: string) => `${fixture.root}/profiles/${id}`)
  effects.read.mockImplementation((path: string) => path.endsWith('swarm.yaml') ? `workers:\n${ARGUS_EXECUTION_IDS.map((id) => `- id: ${id}\n  profile: ${id}`).join('\n')}\n` : '{}')
  effects.process.mockReturnValue('')
  vi.stubEnv('HERMES_HOME', fixture.root)
  vi.stubEnv('SWARM_ORCHESTRATOR_WORKER_ID', 'synthetic-orchestrator')
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('offline: network prohibited') }))
})
afterEach(async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  expect(fs.readdirSync(fixture.root)).toEqual([])
  expect(fetch).not.toHaveBeenCalled()
  fs.rmSync(fixture.root, { recursive: true, force: true })
  vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

it.each(nativeIds)('F3-R3 checkpoint route refuses native/prefix %s before effects', async (id) => {
  expect((await post(id)).status).toBe(409)
  expect(effects.profile).not.toHaveBeenCalled()
  noEffects()
})
it.each(['synthetic-alias', 'minted-by-caller'])('F3-R3 route never mints unknown/unconfigured caller %s', async (id) => {
  effects.realpath.mockReturnValue(`${fixture.root}/profiles/argus-reviewer`)
  const response = await post(id)
  expect(response.status).toBe(400)
  expect(effects.profile).not.toHaveBeenCalled()
  noEffects()
})
it.each(nativeIds)('F3-R3 notification direct call refuses %s before state/prompt/tmux effects', async (workerId) => {
  const { publishSwarmCheckpointNotification } = await import('../../server/swarm-notifications')
  expect(() => publishSwarmCheckpointNotification({ workerId, checkpoint })).toThrow('native_control_required')
  noEffects()
})
it('F3-R3 notification direct call refuses a canonical filesystem alias', async () => {
  effects.realpath.mockReturnValue(`${fixture.root}/profiles/argus-developer-local`)
  const { publishSwarmCheckpointNotification } = await import('../../server/swarm-notifications')
  expect(() => publishSwarmCheckpointNotification({ workerId: 'synthetic-alias', checkpoint })).toThrow('native_control_required')
  noEffects()
})
it('F3-R3 keeps supported legacy notification behavior, with fake effects only', async () => {
  const { publishSwarmCheckpointNotification } = await import('../../server/swarm-notifications')
  expect(publishSwarmCheckpointNotification({ workerId: 'synthetic-legacy', checkpoint }).published).toBe(true)
  expect(effects.write).toHaveBeenCalled()
  expect(effects.process).toHaveBeenCalled()
  expect(effects.mkdir).not.toHaveBeenCalled()
})
it('F3-R3 retains Workspace password denial before profile access', async () => {
  fixture.authenticated = false
  expect((await post('minted-by-caller')).status).toBe(401)
  expect(effects.profile).not.toHaveBeenCalled()
  noEffects()
})
