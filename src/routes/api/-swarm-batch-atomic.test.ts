import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { callNativeBridge, lookupNativeInput, prepareNativeInput } from '../../server/swarm-native-bridge'
import type { NativeBridgeRequest, NativeObservation } from '../../server/swarm-native-bridge'

// P-1 all-or-nothing preparation (Reviewer32 counterexamples P1/P2/P3 restated as the REQUIRED
// contract). Real API/auth-grant/store/state machine; synthetic login and labelled synthetic bridge
// boundary. The synthetic prepare binding is NOT a Native proof (the C2 contract test uses the real
// Native implementation); here it only lets a staged existing-session assignment reach its submit.
vi.mock('../../server/auth-middleware', () => ({ isAuthenticated: vi.fn(() => true), isPasswordProtectionEnabled: vi.fn(() => true) }))
vi.mock('../../server/swarm-native-bridge', () => ({ callNativeBridge: vi.fn(), prepareNativeInput: vi.fn(), lookupNativeInput: vi.fn() }))
vi.mock('../../server/gateway-capabilities', () => ({ dashboardFetch: vi.fn(), ensureGatewayProbed: vi.fn(), getResolvedUrls: vi.fn(), BEARER_TOKEN: '', CLAUDE_API: 'http://synthetic.invalid' }))
vi.mock('../../server/openai-compat-api', () => ({ getBearerToken: vi.fn() }))
vi.mock('../../server/claude-api', () => ({ deleteSession: vi.fn() }))
vi.mock('../../server/kanban-dashboard-proxy', () => ({ fetchDashboardKanbanTask: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({ createFileRoute: () => (options: unknown) => ({ options }) }))

const SID = 'local-producer-synthetic-0001'
const REVIEWER_SID = 'local-reviewer-synthetic-0002'
const ORIGIN = 'http://synthetic.invalid'
const DONE = 'STATE: DONE\nFILES_CHANGED: synthetic\nCOMMANDS_RUN: synthetic\nRESULT: frozen\nBLOCKER: none\nNEXT_ACTION: review'
const artifact = { revision: 'a'.repeat(40), sha256: 'b'.repeat(64), path: 'synthetic/v1.patch' }
let root: string

function syntheticPrepared(request: Omit<NativeBridgeRequest, 'action'>): NativeObservation {
  return {
    profileId: request.profileHome,
    sessionId: request.sessionId ?? undefined,
    preflight: { source: 'desktop', executionGeneration: 3, idleVerified: true, atomicIdleFence: false, capability: 'idle-admission-v1' },
    inputBinding: {
      version: 'original-input-lookup-v1', ref: { profile_id: request.profileHome, session_id: request.sessionId! },
      input_id: request.requestId, principal_binding: 'c'.repeat(64), payload_fingerprint: 'd'.repeat(64),
      idle_fence: { expected_generation: 3 },
    },
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  root = mkdtempSync(join(tmpdir(), 'batch-atomic-'))
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  vi.stubEnv('HERMES_HOME', join(root, '.hermes'))
  vi.stubEnv('ARGUS_WORKSPACE_GPU_SOURCE_ENABLED', '1')
  writeFileSync(join(root, 'swarm.yaml'), 'workers:\n- id: argus-developer\n  profile: argus-developer\n- id: argus-reviewer\n  profile: argus-reviewer\n')
  for (const id of ['argus-developer', 'argus-reviewer']) {
    mkdirSync(join(root, '.hermes/profiles', id), { recursive: true })
    writeFileSync(join(root, '.hermes/profiles', id, 'config.yaml'), 'model: synthetic-saved-route\n')
  }
  vi.mocked(prepareNativeInput).mockImplementation((request) => Promise.resolve(syntheticPrepared(request)))
  vi.mocked(lookupNativeInput).mockResolvedValue({ error: 'native_lookup_unavailable' })
  vi.resetModules()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})
function observation(worker = 'argus-developer', sid = SID, aid = 'synthetic-v1', terminal = false, delivery: unknown = { artifact }) {
  const home = join(root, '.hermes/profiles', worker)
  return {
    profileId: home, sessionId: sid,
    receipt: { admission_id: aid, ref: { profile_id: home, session_id: sid }, status: terminal ? 'terminal' : 'queued', outcome: terminal ? 'completed' : null },
    preflight: { source: 'desktop', executionGeneration: 3, idleVerified: true, atomicIdleFence: true, capability: 'idle-admission-v1' },
    ...(terminal ? { finalText: `${DONE}\nSWARM_DELIVERY: ${JSON.stringify(delivery)}` } : {}),
  }
}
async function api(assignments: Array<unknown>, missionId?: string) {
  const { Route } = await import('./swarm-dispatch')
  const post = (Route as unknown as { options: { server: { handlers: { POST: (c: { request: Request }) => Promise<Response> } } } }).options.server.handlers.POST
  return post({ request: new Request(`${ORIGIN}/api/swarm-dispatch`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ assignments, missionId }) }) })
}
const initial = () => ({ workerId: 'argus-developer', task: 'Synthetic initial producer', existingSessionId: SID, producerIntent: 'initial' })
const storePath = () => join(root, '.runtime/swarm-missions.json')
const stored = () => (existsSync(storePath()) ? readFileSync(storePath(), 'utf8') : null)
const effects = () => ({ prepare: vi.mocked(prepareNativeInput).mock.calls.length, bridge: vi.mocked(callNativeBridge).mock.calls.length })

async function reviewed(verdict = 'changes_required') {
  vi.mocked(callNativeBridge).mockResolvedValueOnce(observation())
  const body = await (await api([initial()])).json()
  const target = body.assignments[0]
  const { refreshNativeMission } = await import('../../server/swarm-native')
  vi.mocked(callNativeBridge).mockResolvedValueOnce(observation('argus-developer', SID, 'synthetic-v1', true))
  await refreshNativeMission(body.missionId)
  vi.mocked(callNativeBridge).mockResolvedValueOnce(observation('argus-reviewer', REVIEWER_SID, 'synthetic-review'))
  const review = (await (await api([{ workerId: 'argus-reviewer', task: 'Synthetic exact review', dependsOn: [target.id], existingSessionId: REVIEWER_SID }], body.missionId)).json()).assignments[1]
  vi.mocked(callNativeBridge).mockResolvedValueOnce(observation('argus-reviewer', REVIEWER_SID, 'synthetic-review', true, {
    artifact: { revision: 'c'.repeat(40), sha256: 'd'.repeat(64), path: 'synthetic/review.md' },
    review: { assignmentId: target.id, revision: artifact.revision, sha256: artifact.sha256, verdict },
  }))
  await refreshNativeMission(body.missionId)
  vi.mocked(callNativeBridge).mockClear()
  vi.mocked(prepareNativeInput).mockClear()
  return { missionId: body.missionId as string, target, review }
}

it('P1: a batch of two INITIAL producers is refused whole BEFORE any store write or Native boundary', async () => {
  const response = await api([initial(), { ...initial(), task: 'Synthetic second initial' }])
  expect(response.status).toBe(409)
  expect((await response.json()).error).toBe('batch_profile_reservation_conflict')
  expect(stored()).toBeNull()
  expect(effects()).toEqual({ prepare: 0, bridge: 0 })
})

it('P2: a second correction while the first is active is refused with the store byte-unchanged', async () => {
  const { missionId, target, review } = await reviewed()
  let entered!: () => void
  const reached = new Promise<void>((resolve) => { entered = resolve })
  let release!: (value: ReturnType<typeof observation>) => void
  vi.mocked(callNativeBridge).mockImplementationOnce(() => { entered(); return new Promise((resolve) => { release = resolve }) })
  const correction = (task: string) => ({ ...initial(), task, producerIntent: 'correction', dependsOn: [target.id, review.id] })
  const first = api([correction('Synthetic active correction')], missionId)
  await reached
  const before = stored()
  const second = await api([correction('Synthetic conflicting correction')], missionId)
  expect(second.status).toBe(409)
  expect((await second.json()).error).toBe('profile_reserved; existing work preserved: argus-developer')
  expect(stored()).toBe(before)
  expect(effects()).toEqual({ prepare: 1, bridge: 1 })
  release(observation('argus-developer', SID, 'synthetic-active-correction'))
  expect((await first).status).toBe(200)
})

it('P3: a batch of two accepted continuations is refused whole before any submit, store byte-unchanged', async () => {
  const { missionId, target } = await reviewed('accepted')
  const before = stored()
  const continuation = (task: string) => ({ ...initial(), task, producerIntent: 'continuation', dependsOn: [target.id] })
  const response = await api([continuation('Synthetic next one'), continuation('Synthetic next two')], missionId)
  expect(response.status).toBe(409)
  expect((await response.json()).error).toBe('batch_profile_reservation_conflict')
  expect(stored()).toBe(before)
  expect(effects()).toEqual({ prepare: 0, bridge: 0 })
})

it('concurrent requests for one profile: the loser changes nothing and only ONE admission is attempted', async () => {
  let entered!: () => void
  const reached = new Promise<void>((resolve) => { entered = resolve })
  let release!: (value: ReturnType<typeof observation>) => void
  vi.mocked(callNativeBridge).mockImplementationOnce(() => { entered(); return new Promise((resolve) => { release = resolve }) })
  const first = api([initial()])
  await reached
  const before = stored()
  const second = await api([{ ...initial(), task: 'Concurrent other mission' }])
  expect(second.status).toBe(409)
  expect(stored()).toBe(before)
  expect(effects()).toEqual({ prepare: 1, bridge: 1 })
  release(observation())
  expect((await first).status).toBe(200)
  expect(JSON.parse(stored()!).missions).toHaveLength(1)
})

it('a mixed batch stages every admissible intent atomically and returns a per-assignment receipt for each', async () => {
  const { missionId, target, review } = await reviewed('changes_required')
  vi.mocked(callNativeBridge)
    .mockResolvedValueOnce(observation('argus-developer', SID, 'synthetic-v2'))
    .mockRejectedValueOnce(new Error('synthetic ACK lost'))
  const response = await api([
    { ...initial(), task: 'Synthetic corrected v2', producerIntent: 'correction', dependsOn: [target.id, review.id] },
    { workerId: 'argus-reviewer', task: 'Synthetic second review', dependsOn: [target.id], existingSessionId: REVIEWER_SID },
  ], missionId)
  const body = await response.json()
  expect(response.status, JSON.stringify(body.error ?? null)).toBe(200)
  expect(body.results.map((r: { admissionId: string | null; error: string | null }) => [r.admissionId, r.error]))
    .toEqual([['synthetic-v2', null], [null, 'unknown']])
  // The lost-ACK row crossed the Native boundary: it is retained sticky UNKNOWN, never deleted.
  const saved = JSON.parse(stored()!).missions[0].assignments.at(-1)
  expect(saved.native).toMatchObject({ status: 'unknown', admissionId: null })
  expect(saved.native.inputBinding.input_id).toBe(saved.native.requestId)
  expect(effects()).toEqual({ prepare: 2, bridge: 2 })
})


it('a repeated identical intent in one batch is a whole-batch refusal, not a duplicate submit', async () => {
  const response = await api([initial(), initial()])
  expect(response.status).toBe(409)
  expect(stored()).toBeNull()
  expect(effects()).toEqual({ prepare: 0, bridge: 0 })
})

it('an invalid late assignment refuses the entire prospective batch before any Native preparation', async () => {
  const response = await api([initial(), { workerId: 'argus-reviewer', task: 'Synthetic invalid late assignment', existingSessionId: REVIEWER_SID, dependsOn: ['nonexistent'] }])
  expect(response.status).toBe(400)
  expect(stored()).toBeNull()
  expect(effects()).toEqual({ prepare: 0, bridge: 0 })
})
