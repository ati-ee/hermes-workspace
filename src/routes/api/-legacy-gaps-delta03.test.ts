import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ARGUS_EXECUTION_IDS } from '../../lib/argus-swarm-policy'

const fixture = vi.hoisted(() => ({ root: '', ids: [] as Array<string>, worker: 'argus-reviewer', authenticated: true }))
const effects = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), transcript: vi.fn(), publish: vi.fn(), record: vi.fn(), process: vi.fn(), mode: vi.fn(), realpath: vi.fn((path: string) => path) }))
vi.mock('node:fs', () => ({ existsSync: () => true, mkdirSync: effects.write, writeFileSync: effects.write, renameSync: effects.write, readFileSync: effects.read, realpathSync: effects.realpath, lstatSync: () => ({ isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false }), accessSync: vi.fn(), constants: { R_OK: 4 } }))
vi.mock('node:child_process', () => ({ execFile: effects.process, execFileSync: effects.process, spawn: effects.process }))
vi.mock('../../server/claude-paths', () => ({ getProfilesDir: () => `${fixture.root}/profiles`, getHermesRoot: () => fixture.root }))
vi.mock('../../server/auth-middleware', () => ({ isAuthenticated: () => fixture.authenticated }))
vi.mock('../../server/rate-limit', () => ({ requireJsonContentType: () => null }))
vi.mock('../../server/swarm-foundation', () => ({ listSwarmWorkerIds: () => fixture.ids, getSwarmProfilePath: (id: string) => `${fixture.root}/profiles/${id}` }))
vi.mock('../../server/swarm-roster', () => ({ isSwarmWorkerId: (id: unknown) => typeof id === 'string' && /^[a-z][a-z0-9-]*$/.test(id), readSwarmRoster: () => ({ workers: [] }) }))
vi.mock('../../server/swarm-chat-reader', () => ({ readWorkerMessages: effects.transcript }))
vi.mock('../../server/swarm-checkpoints', () => ({ readRuntimeJson: effects.read, newestCheckpointFromMessages: () => ({ stateLabel: 'DONE', runtimeState: 'done', checkpointStatus: 'done', raw: 'synthetic checkpoint', result: 'synthetic', nextAction: 'review', filesChanged: 'synthetic', commandsRun: 'none' }) }))
vi.mock('../../server/swarm-memory', () => ({ appendSwarmMemoryEvent: effects.record }))
vi.mock('../../server/swarm-notifications', () => ({ publishSwarmActionPrompt: effects.publish, publishSwarmCheckpointNotification: effects.publish }))
vi.mock('../../server/swarm-mode', () => ({ readSwarmMode: effects.mode, applySwarmModeToLoopFlags: () => ({ autoContinue: true, allowExecution: true }) }))
vi.mock('../../server/swarm-missions', () => ({ SWARM_MISSIONS_PATH: 'synthetic/missions.json', listSwarmMissions: () => [], listSwarmReports: () => [], getSwarmMission: () => ({ id: 'synthetic-legacy', assignments: [{ id: 'synthetic-assignment', workerId: fixture.worker }] }), cancelSwarmMission: () => ({ mission: { assignments: [{ id: 'synthetic-assignment', workerId: fixture.worker }] }, cancelledAssignmentIds: ['synthetic-assignment'] }), cancelSwarmAssignment: () => ({ mission: { assignments: [] }, assignment: { workerId: fixture.worker } }), appendMissionContinuation: effects.record, recordMissionCheckpoint: effects.record, markMissionAssignmentsReviewedByWorker: effects.record }))
vi.mock('../../server/swarm-native', () => ({ refreshNativeMission: effects.process }))
vi.mock('../../server/gateway-capabilities', () => ({ dashboardFetch: effects.process, ensureGatewayProbed: () => Promise.resolve({ dashboard: { available: false }, conductor: false }) }))
vi.mock('../../server/claude-api', () => ({ deleteSession: effects.process }))
vi.mock('@tanstack/react-router', () => ({ createFileRoute: () => (options: unknown) => ({ options }) }))

const nativeIds = ARGUS_EXECUTION_IDS.flatMap((id) => [id, `swarm-${id}`])
type Handler = (context: { request: Request }) => Promise<Response>
function post(route: unknown, body: unknown) {
  const handler = (route as { options: { server: { handlers: { POST: Handler } } } }).options.server.handlers.POST
  return handler({ request: new Request('http://synthetic.invalid/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
}
function noEffects() {
  for (const effect of [effects.read, effects.write, effects.transcript, effects.publish, effects.record, effects.process, effects.mode]) expect(effect).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
}
beforeEach(async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  fixture.root = fs.mkdtempSync(`${process.env.TMPDIR}/delta03-fixture-`)
  fixture.ids = [...ARGUS_EXECUTION_IDS]; fixture.worker = 'argus-reviewer'; fixture.authenticated = true
  vi.clearAllMocks()
  effects.realpath.mockImplementation((path: string) => path)
  effects.read.mockReturnValue({})
  effects.transcript.mockReturnValue({ ok: true, messages: [] })
  effects.publish.mockReturnValue({ published: true, sessionKey: 'synthetic' })
  effects.record.mockReturnValue({ id: 'synthetic' })
  effects.mode.mockReturnValue({ mode: 'auto' })
  vi.stubEnv('HERMES_HOME', fixture.root)
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json({ ok: true }))))
})
afterEach(async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  fs.rmSync(fixture.root, { recursive: true, force: true })
  vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

it.each(nativeIds)('F3-R1 POST refuses %s before transcript/runtime/prompt/auto-dispatch effects', async (workerId) => {
  const { Route } = await import('./swarm-orchestrator-loop')
  const response = await post(Route, { workerIds: [workerId], autoContinue: true, allowExecution: true })
  expect(response.status).toBe(409)
  expect((await response.json()).error).toContain('native_control_required')
  noEffects()
})
it.each([{}, { workerIds: [] }, { workerIds: [], dryRun: true }])('F3-R1 implicit all selection refuses before effects (%j)', async (body) => {
  const { Route } = await import('./swarm-orchestrator-loop')
  expect((await post(Route, body)).status).toBe(409)
  noEffects()
})
it('F3-R1 direct loop and runtime writer cannot bypass native identity guards', async () => {
  const module = await import('./swarm-orchestrator-loop') as unknown as { runWorkerLoop: (id: string, staleMs: number, dryRun: boolean) => unknown; writeRuntimePatch: (id: string, patch: Record<string, unknown>, dryRun: boolean) => unknown }
  for (const id of nativeIds) {
    expect(() => module.runWorkerLoop(id, 60_000, false)).toThrow('native_control_required')
    expect(() => module.writeRuntimePatch(id, {}, false)).toThrow('native_control_required')
  }
  noEffects()
})
it('F3-R1 direct loop/writer reject a filesystem alias of a native profile', async () => {
  effects.realpath.mockReturnValue(`${fixture.root}/profiles/argus-reviewer`)
  const module = await import('./swarm-orchestrator-loop') as unknown as { runWorkerLoop: (id: string, staleMs: number, dryRun: boolean) => unknown; writeRuntimePatch: (id: string, patch: Record<string, unknown>, dryRun: boolean) => unknown }
  expect(() => module.runWorkerLoop('synthetic-alias', 60_000, false)).toThrow('native_control_required')
  expect(() => module.writeRuntimePatch('synthetic-alias', {}, false)).toThrow('native_control_required')
  noEffects()
})
it('F3-R1 retains Workspace authentication before any legacy effect', async () => {
  fixture.authenticated = false
  const { Route } = await import('./swarm-orchestrator-loop')
  expect((await post(Route, {})).status).toBe(401)
  noEffects()
})

it.each(nativeIds)('F3-R2 reset route refuses %s before any runtime effect', async (workerId) => {
  const { Route } = await import('./swarm-runtime.reset')
  const response = await post(Route, { workerIds: [workerId] })
  expect(response.status).toBe(409)
  expect((await response.json()).error).toContain('native_control_required')
  noEffects()
})
it.each([{}, { workerIds: [] }])('F3-R2 implicit all-runtime reset refuses (%j)', async (body) => {
  const { Route } = await import('./swarm-runtime.reset')
  expect((await post(Route, body)).status).toBe(409)
  noEffects()
})
it('F3-R2 direct single/batch/all writers return per-worker native refusals, not exceptions', async () => {
  const reset = await import('../../server/swarm-runtime-reset')
  const input = { actor: 'synthetic-test', reason: 'synthetic' }
  for (const id of nativeIds) expect(reset.resetSwarmWorkerRuntime(id, input)).toMatchObject({ workerId: id, ok: false, error: expect.stringContaining('native_control_required') })
  const all = reset.resolveResetTargetWorkerIds().workerIds || []
  const results = reset.resetSwarmWorkerRuntimes(all, input)
  expect(results).toHaveLength(ARGUS_EXECUTION_IDS.length)
  expect(results.every((row) => !row.ok && row.error?.includes('native_control_required'))).toBe(true)
  noEffects()
})
it('F3-R2 direct reset refuses a filesystem alias of a native profile', async () => {
  fixture.ids = ['synthetic-alias']
  effects.realpath.mockReturnValue(`${fixture.root}/profiles/argus-reviewer`)
  const { resetSwarmWorkerRuntime } = await import('../../server/swarm-runtime-reset')
  expect(resetSwarmWorkerRuntime('synthetic-alias', { actor: 'synthetic-test', reason: 'synthetic' })).toMatchObject({ ok: false, error: expect.stringContaining('native_control_required') })
  noEffects()
})
it('F3-R2 legacy cancel exposes per-worker refusal without native reset or accidental 500', async () => {
  const { Route } = await import('./swarm-missions')
  const response = await post(Route, { action: 'cancel', missionId: 'synthetic-legacy' })
  expect(response.status).toBe(200)
  expect((await response.json()).runtimeResets).toEqual([{ workerId: fixture.worker, ok: false, error: expect.stringContaining('native_control_required') }])
  noEffects()
})
it('F3-R2 legacy Conductor stop exposes per-worker refusal without fallback effects', async () => {
  const { Route } = await import('./conductor-stop')
  const response = await post(Route, { missionIds: ['synthetic-legacy'] })
  expect(response.status).toBe(200)
  expect((await response.json()).runtimeResets).toEqual([{ workerId: fixture.worker, ok: false, error: expect.stringContaining('native_control_required') }])
  noEffects()
})
it('F3-R2 preserves safe supported non-native helper behavior and mixed per-worker results', async () => {
  fixture.ids = ['synthetic-legacy', 'argus-reviewer']
  const reset = await import('../../server/swarm-runtime-reset')
  const results = reset.resetSwarmWorkerRuntimes(fixture.ids, { actor: 'synthetic-test', reason: 'synthetic' })
  expect(results[0]).toEqual({ workerId: 'synthetic-legacy', ok: true })
  expect(results[1]).toMatchObject({ workerId: 'argus-reviewer', ok: false, error: expect.stringContaining('native_control_required') })
  expect(effects.write.mock.calls.every(([path]) => String(path).includes('/profiles/synthetic-legacy'))).toBe(true)
  expect(effects.transcript).not.toHaveBeenCalled()
  expect(effects.process).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
  const { runWorkerLoop } = await import('./swarm-orchestrator-loop')
  expect(runWorkerLoop('synthetic-legacy', 60_000, false).status).toBe('checkpointed')
})
