import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callNativeBridge, lookupNativeInput, prepareNativeInput } from '../../server/swarm-native-bridge'

// C2 contract: the REAL Workspace API/auth-grant/store/state machine replays answers RECORDED from the
// REAL sealed Native original-input-lookup-v1 implementation (tree 9f9f5a7a). The guarded Vitest lane
// denies child processes, so swarm-native-lookup-contract-harness.py --record ran the Workspace
// bridge's own prepare/fenced-submit/lookup helpers against the real SessionAuthority + canonical
// dispatch + SQLite offline. Only the profile/input identity tokens are rebound to this test's runtime
// ids; fingerprints, principal bindings, states, admissions and proofs are the owner's exact bytes.
// Only transport loss is simulated (the submit reply is dropped).
vi.mock('../../server/auth-middleware', () => ({ isAuthenticated: vi.fn(() => true), isPasswordProtectionEnabled: vi.fn(() => true) }))
vi.mock('../../server/swarm-native-bridge', () => ({ callNativeBridge: vi.fn(), prepareNativeInput: vi.fn(), lookupNativeInput: vi.fn() }))
vi.mock('../../server/gateway-capabilities', () => ({ dashboardFetch: vi.fn(), ensureGatewayProbed: vi.fn(), getResolvedUrls: vi.fn(), BEARER_TOKEN: '', CLAUDE_API: 'http://synthetic.invalid' }))
vi.mock('../../server/openai-compat-api', () => ({ getBearerToken: vi.fn() }))
vi.mock('../../server/claude-api', () => ({ deleteSession: vi.fn() }))
vi.mock('../../server/kanban-dashboard-proxy', () => ({ fetchDashboardKanbanTask: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({ createFileRoute: () => (options: unknown) => ({ options }) }))

const FIXTURE_PATH = fileURLToPath(new URL('../../server/swarm-native-lookup-contract.fixture.json', import.meta.url))
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
const sha = (relative: string) => createHash('sha256').update(readFileSync(fileURLToPath(new URL(relative, import.meta.url)))).digest('hex')
const SID = fixture.session as string
const ORIGIN = 'http://synthetic.invalid'
const ZERO = { db_writes: 0, scheduled: 0, unchanged: true }
type Out = Record<string, any>
let root: string

const home = () => join(root, '.hermes/profiles/argus-developer')
/** Rebind ONLY the two identity tokens; every other recorded byte is used verbatim. */
function rebind<T>(value: T, requestId: string): T {
  return JSON.parse(JSON.stringify(value), (_key, item) => (item === fixture.tokens.profile ? home() : item === fixture.tokens.input_id ? requestId : item))
}
function replay(name: string) {
  const scenario = fixture.scenarios[name]
  let requestId = ''
  vi.mocked(prepareNativeInput).mockImplementation((request) => {
    requestId = request.requestId
    return Promise.resolve({ profileId: request.profileHome, sessionId: request.sessionId ?? undefined, inputBinding: rebind(scenario.prepare.binding, requestId) })
  })
  vi.mocked(callNativeBridge).mockImplementation((request) => {
    if (request.action === 'submit_existing') {
      expect(request.inputBinding).toEqual(rebind(scenario.prepare.binding, requestId))
      expect(saved().native.inputBinding).toEqual(request.inputBinding) // durable BEFORE submit
      throw new Error('synthetic transport loss: reply dropped')
    }
    if (request.action === 'inspect') {
      expect(request.admissionId).toBe(scenario.inspect.receipt.admission_id)
      return Promise.resolve({ profileId: request.profileHome, sessionId: request.sessionId ?? undefined, receipt: rebind(scenario.inspect.receipt, requestId) })
    }
    throw new Error(`unexpected bridge action ${request.action}`)
  })
  vi.mocked(lookupNativeInput).mockImplementation((request) => {
    expect(request.inputBinding).toEqual(rebind(scenario.prepare.binding, requestId))
    return Promise.resolve({ profileId: request.profileHome, ...rebind(scenario.lookup.result, requestId) })
  })
  return scenario as Out
}
async function api(assignments: Array<unknown>, missionId?: string) {
  const { Route } = await import('./swarm-dispatch')
  const post = (Route as unknown as { options: { server: { handlers: { POST: (c: { request: Request }) => Promise<Response> } } } }).options.server.handlers.POST
  return post({ request: new Request(`${ORIGIN}/api/swarm-dispatch`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ assignments, missionId }) }) })
}
const initial = (task = 'Synthetic contract producer') => ({ workerId: 'argus-developer', task, existingSessionId: SID, producerIntent: 'initial' })
const stored = () => readFileSync(join(root, '.runtime/swarm-missions.json'), 'utf8')
const saved = () => JSON.parse(stored()).missions[0].assignments[0]
const actions = () => vi.mocked(callNativeBridge).mock.calls.map(([request]) => request.action)
async function lostAck(name: string) {
  const scenario = replay(name)
  const response = await api([initial()])
  expect(response.status).toBe(200)
  const body = await response.json()
  const row = body.assignments[0]
  expect(row.native).toMatchObject({ status: 'unknown', admissionId: null })
  // The owner's exact prepared binding was persisted BEFORE the submit (recorded with zero writes).
  expect(row.native.inputBinding).toEqual(rebind(scenario.prepare.binding, row.native.requestId))
  expect(scenario.prepare.counters).toEqual(ZERO)
  expect(scenario.lookup.counters).toEqual(ZERO)
  return { missionId: body.missionId as string, scenario }
}

describe('C2 replay of the real Native original-input-lookup-v1 contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    root = mkdtempSync(join(tmpdir(), 'lookup-contract-'))
    vi.spyOn(process, 'cwd').mockReturnValue(root)
    vi.stubEnv('HERMES_HOME', join(root, '.hermes'))
    vi.stubEnv('ARGUS_WORKSPACE_GPU_SOURCE_ENABLED', '1')
    writeFileSync(join(root, 'swarm.yaml'), 'workers:\n- id: argus-developer\n  profile: argus-developer\n- id: argus-reviewer\n  profile: argus-reviewer\n')
    for (const id of ['argus-developer', 'argus-reviewer']) {
      mkdirSync(join(root, '.hermes/profiles', id), { recursive: true })
      writeFileSync(join(root, '.hermes/profiles', id, 'config.yaml'), 'model: synthetic-saved-route\n')
    }
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  it('the fixture is bound to this bridge/harness and to the sealed Native lookup implementation', () => {
    expect(fixture.schema).toBe('workspace-c2-native-contract/1')
    expect(fixture.bridge_sha256).toBe(sha('../../server/swarm-native-bridge.py'))
    expect(fixture.harness_sha256).toBe(sha('../../server/swarm-native-lookup-contract-harness.py'))
    expect(fixture.native_checkout_session_input_lookup_sha256).toBe('afa9865340d8c9227ea6d892283f28475a8e381b8ffcec9e267b270c7a700c4b')
    expect(fixture.native_checkout_canonical_input_lookup_sha256).toBe('4e4ee4b74daa60c8387d4573f85035b6d42a2a597367220fb5d4a3094cc3faab')
    expect(readFileSync(FIXTURE_PATH, 'utf8')).not.toMatch(/\/home\/|\/srv\//)
  })

  it('binds a real lost-ACK admission exactly once from positive exact proof; never re-binds', async () => {
    const { missionId, scenario } = await lostAck('queued')
    const admissionId = scenario.submit.receipt.admission_id
    expect(scenario.lookup.counts).toEqual({ admissions: 1, sessions: 1 })
    const { refreshNativeMission } = await import('../../server/swarm-native')
    await refreshNativeMission(missionId)
    expect(saved().native).toMatchObject({ admissionId, status: 'queued', sessionId: SID })
    expect(actions()).toEqual(['submit_existing', 'inspect'])
    await refreshNativeMission(missionId)
    expect(vi.mocked(lookupNativeInput)).toHaveBeenCalledTimes(1)
    expect(actions()).toEqual(['submit_existing', 'inspect', 'inspect'])
    const mission = JSON.parse(stored()).missions[0]
    expect(mission.events.filter((e: Out) => e.data?.source === 'original-input-lookup-v1')).toHaveLength(1)
    const { applyInputLookup } = await import('../../server/swarm-missions')
    const proof = { profileId: home(), ...rebind(scenario.lookup.result, saved().native.requestId) }
    expect(applyInputLookup(missionId, saved().id, proof)).toBe(false)
    // Active work keeps its reservation; nothing was resubmitted and no session was created.
    expect((await api([initial('Other mission while active')])).status).toBe(409)
  })

  it('cross-mission: the same real exact proof can never bind another assignment', async () => {
    const { missionId, scenario } = await lostAck('queued')
    const first = saved()
    const { applyInputLookup } = await import('../../server/swarm-missions')
    // Proof for the first request offered to an unrelated request id: refused (input mismatch).
    const foreign = { profileId: home(), ...rebind(scenario.lookup.result, `${missionId}:assign-foreign`) }
    expect(applyInputLookup(missionId, first.id, foreign)).toBe(false)
    expect(saved().native.admissionId).toBeNull()
  })

  it('a reply lost BEFORE any admission: real not_found changes nothing and never unlocks or resubmits', async () => {
    const { missionId, scenario } = await lostAck('lost_before_admission')
    expect(scenario.lookup.counts).toEqual({ admissions: 0, sessions: 1 })
    const before = stored()
    const { refreshNativeMission } = await import('../../server/swarm-native')
    await refreshNativeMission(missionId)
    expect(stored()).toBe(before)
    expect(actions()).toEqual(['submit_existing'])
    vi.resetModules()
    const retry = await api([initial()], missionId)
    expect(retry.status).toBe(409)
    expect((await retry.json()).error).toBe('native_reconciliation_required; awaiting exact original-input lookup')
    expect((await api([initial('Other mission')])).status).toBe(409)
    expect(stored()).toBe(before)
  })

  it('a real admission under the same input id with another payload is a mismatch: stays UNKNOWN', async () => {
    const { missionId, scenario } = await lostAck('payload_mismatch')
    expect(scenario.lookup.result.lookup).toMatchObject({ state: 'found', binding: 'mismatch', admission: null, proof: null })
    const before = stored()
    const { refreshNativeMission } = await import('../../server/swarm-native')
    await refreshNativeMission(missionId)
    expect(stored()).toBe(before)
    expect(actions()).toEqual(['submit_existing'])
  })

  it('an unavailable (retired) owner proves nothing: stays UNKNOWN and reserved', async () => {
    const { missionId, scenario } = await lostAck('owner_unavailable')
    expect(scenario.lookup.result.lookup).toMatchObject({ state: 'unavailable', reason: 'runtime_retired', admission: null })
    const before = stored()
    const { refreshNativeMission } = await import('../../server/swarm-native')
    await refreshNativeMission(missionId)
    expect(stored()).toBe(before)
    expect((await api([initial('Other mission')])).status).toBe(409)
  })

  it('a settled terminal admission is bound, then released only through its exact settled receipt', async () => {
    const { missionId, scenario } = await lostAck('settled_terminal')
    expect(scenario.lookup.result.lookup).toMatchObject({ state: 'found', binding: 'exact', settled: true, admission: { status: 'terminal', outcome: 'completed' } })
    const { refreshNativeMission } = await import('../../server/swarm-native')
    await refreshNativeMission(missionId)
    expect(saved().native).toMatchObject({ admissionId: scenario.submit.receipt.admission_id, status: 'terminal', outcome: 'completed' })
    // A completed turn is not a completed task: no checkpoint/artifact, so it needs input, not done.
    expect(saved().state).toBe('needs_input')
  })
  it.each([
    ['foreign profile', (o: Out) => { o.lookup.ref.profile_id += '-foreign' }],
    ['foreign session', (o: Out) => { o.lookup.ref.session_id += '-foreign' }],
    ['foreign input', (o: Out) => { o.lookup.input_id += '-foreign' }],
    ['foreign principal', (o: Out) => { o.lookup.principal_binding = 'f'.repeat(64) }],
    ['foreign fingerprint', (o: Out) => { o.lookup.proof.payload_fingerprint = 'f'.repeat(64) }],
    ['foreign fence', (o: Out) => { o.lookup.proof.idle_fence.expected_generation += 1 }],
    ['unsupported version', (o: Out) => { o.lookup.version = 'future-unsupported' }],
    ['unavailable owner', (o: Out) => { o.lookup.state = 'unavailable' }],
    ['owner reason with forged proof', (o: Out) => { o.lookup.reason = 'stale_epoch' }],
    ['non-numeric epoch', (o: Out) => { o.lookup.admission.authority_epoch = '1' }],
    ['negative sequence', (o: Out) => { o.lookup.admission.sequence = -1 }],
    ['fractional generation', (o: Out) => { o.lookup.admission.execution_generation = 0.5 }],
    ['unsettled terminal', (o: Out) => { o.lookup.admission.status = 'terminal'; o.lookup.admission.outcome = 'completed'; o.lookup.settled = false }],
    ['settled active', (o: Out) => { o.lookup.settled = true }],
    ['expanded result', (o: Out) => { o.lookup.messages = [{ text: 'not proof' }] }],
    ['disconnected', (o: Out) => { o.error = 'native_lookup_unavailable' }],
  ])('rejects %s without any store/reservation change', async (_name, mutate) => {
    const { missionId, scenario } = await lostAck('queued')
    const proof = { profileId: home(), ...rebind(scenario.lookup.result, saved().native.requestId) }
    mutate(proof)
    const before = stored()
    const { applyInputLookup } = await import('../../server/swarm-missions')
    expect(applyInputLookup(missionId, saved().id, proof)).toBe(false)
    expect(stored()).toBe(before)
    expect((await api([initial('Other mission')])).status).toBe(409)
    expect(actions()).toEqual(['submit_existing'])
  })

  it('historical lost-ACK rows without prepared binding remain untouched; no guessed lookup', async () => {
    const { missionId } = await lostAck('queued')
    // Test-only historical-store fixture; production never patches/migrates a binding into it.
    const historical = JSON.parse(stored())
    delete historical.missions[0].assignments[0].native.inputBinding
    writeFileSync(join(root, '.runtime/swarm-missions.json'), JSON.stringify(historical))
    const before = stored()
    const { refreshNativeMission } = await import('../../server/swarm-native')
    await refreshNativeMission(missionId)
    expect(stored()).toBe(before)
    expect(lookupNativeInput).not.toHaveBeenCalled()
    expect(actions()).toEqual(['submit_existing'])
  })

  it('preparation unavailable: never submits and stores no invented binding', async () => {
    replay('queued')
    vi.mocked(prepareNativeInput).mockRejectedValueOnce(new Error('synthetic prepare disconnect'))
    const response = await api([initial()])
    expect(response.status).toBe(200)
    expect(saved().native).toMatchObject({ status: 'not_admitted', admissionId: null })
    expect(saved().native.inputBinding).toBeUndefined()
    expect(callNativeBridge).not.toHaveBeenCalled()
  })

  it('the same admission id cannot bind a different mission even with otherwise matching proof', async () => {
    const { missionId, scenario } = await lostAck('queued')
    const { refreshNativeMission } = await import('../../server/swarm-native')
    await refreshNativeMission(missionId)
    const data = JSON.parse(stored())
    // Test-only contender state: admission identity is deliberately reused across two distinct attempts.
    const contender = structuredClone(data.missions[0])
    contender.id += '-other'
    contender.assignments[0].id += '-other'
    const native = contender.assignments[0].native
    native.requestId += '-other'; native.inputBinding.input_id = native.requestId
    native.admissionId = null; native.status = 'unknown'
    data.missions.push(contender)
    writeFileSync(join(root, '.runtime/swarm-missions.json'), JSON.stringify(data))
    const before = stored()
    const { applyInputLookup } = await import('../../server/swarm-missions')
    expect(applyInputLookup(contender.id, contender.assignments[0].id,
      { profileId: home(), ...rebind(scenario.lookup.result, native.requestId) })).toBe(false)
    expect(stored()).toBe(before)
  })

  it.each([
    ['foreign request', (b: Out) => { b.input_id += '-foreign' }],
    ['extra field', (b: Out) => { b.principal = 'not-authority' }],
    ['fingerprint LF', (b: Out) => { b.payload_fingerprint += '\n' }],
    ['negative fence', (b: Out) => { b.idle_fence.expected_generation = -1 }],
  ])('rejects prepared %s before submit', async (_name, mutate) => {
    const scenario = replay('queued')
    vi.mocked(prepareNativeInput).mockImplementationOnce((request) => {
      const binding = rebind(scenario.prepare.binding, request.requestId)
      mutate(binding)
      return Promise.resolve({ profileId: home(), sessionId: SID, inputBinding: binding })
    })
    expect((await api([initial()])).status).toBe(200)
    expect(saved().native).toMatchObject({ status: 'not_admitted', admissionId: null })
    expect(saved().native.inputBinding).toBeUndefined()
    expect(callNativeBridge).not.toHaveBeenCalled()
  })

})
