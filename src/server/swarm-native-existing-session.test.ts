import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callNativeBridge } from './swarm-native-bridge'
import type { NativeObservation } from './swarm-native-bridge'

// B2: a NEW genuine argus-reviewer assignment admitted in ONE explicitly selected existing
// session. Synthetic only: disposable cwd/HERMES_HOME store, mocked bridge (no RPC/network),
// mocked login check (the route test covers the real request gates).
vi.mock('./swarm-native-bridge', () => ({
  callNativeBridge: vi.fn(),
  // C2 (labelled synthetic transport, NOT Native proof; the real-Native contract is
  // src/server/swarm-native-lookup-contract.test.ts): pure prepare returns a binding, lookup is unavailable.
  prepareNativeInput: vi.fn((request: { profileHome: string; sessionId?: string | null; requestId: string }) => Promise.resolve({
    profileId: request.profileHome, sessionId: request.sessionId,
    inputBinding: { version: 'original-input-lookup-v1', ref: { profile_id: request.profileHome, session_id: request.sessionId }, input_id: request.requestId, principal_binding: 'c'.repeat(64), payload_fingerprint: 'd'.repeat(64), idle_fence: { expected_generation: 3 } },
  })),
  lookupNativeInput: vi.fn(() => Promise.resolve({ error: 'native_lookup_unavailable' })),
}))
vi.mock('./auth-middleware', () => ({ isAuthenticated: vi.fn(() => true), isPasswordProtectionEnabled: vi.fn(() => true) }))
// Offline: the real modules probe the local gateway/dashboard (and fetch a token) on import.
vi.mock('./gateway-capabilities', () => ({ ensureGatewayProbed: vi.fn(), dashboardFetch: vi.fn(), BEARER_TOKEN: '', CLAUDE_API: 'http://synthetic.invalid' }))
vi.mock('./kanban-dashboard-proxy', () => ({ fetchDashboardKanbanTask: vi.fn() }))

const SID = 'local-reviewer-synthetic-0001'
const artifact = { revision: 'a'.repeat(40), sha256: 'b'.repeat(64), path: 'synthetic/frozen.patch' }
const done = 'STATE: DONE\nFILES_CHANGED: synthetic\nCOMMANDS_RUN: synthetic\nRESULT: delivered\nBLOCKER: none\nNEXT_ACTION: review'
let root: string
let reviewerHome: string

beforeEach(() => {
  vi.clearAllMocks()
  root = mkdtempSync(join(tmpdir(), 'swarm-existing-session-'))
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  vi.stubEnv('HERMES_HOME', join(root, '.hermes'))
  writeFileSync(join(root, 'swarm.yaml'), 'version: 1\nworkers:\n- id: orchestrator-argus\n  profile: orchestrator-argus\n- id: argus-developer-local\n  profile: argus-developer-local\n- id: argus-reviewer\n  profile: argus-reviewer\n')
  for (const id of ['orchestrator-argus', 'argus-developer-local', 'argus-reviewer']) {
    mkdirSync(join(root, '.hermes/profiles', id), { recursive: true })
    writeFileSync(join(root, '.hermes/profiles', id, 'config.yaml'), 'model: synthetic-saved-route\n')
  }
  reviewerHome = join(root, '.hermes/profiles/argus-reviewer')
  vi.resetModules()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

async function authority(ids: Array<string> = [SID]) {
  const { authorizeExistingSessions } = await import('./swarm-existing-session-auth')
  return authorizeExistingSessions(new Request('http://workspace.test/api/swarm-dispatch', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://workspace.test' }, body: '{}' }), ids)
}

/** A real developer assignment whose terminal receipt delivered an exact frozen artifact. */
async function developerArtifact() {
  const { dispatchNativeAssignments, refreshNativeMission } = await import('./swarm-native')
  const ref = { profile_id: join(root, '.hermes/profiles/argus-developer-local'), session_id: 'synthetic-developer' }
  vi.mocked(callNativeBridge).mockResolvedValueOnce({ profileId: ref.profile_id, sessionId: ref.session_id, receipt: { admission_id: 'dev-admission', ref, status: 'started', outcome: null } })
  const delivery = await dispatchNativeAssignments({ assignments: [{ workerId: 'argus-developer-local', task: 'Synthetic implementation' }] })
  vi.mocked(callNativeBridge).mockResolvedValueOnce({ profileId: ref.profile_id, sessionId: ref.session_id, receipt: { admission_id: 'dev-admission', ref, status: 'terminal', outcome: 'completed' }, finalText: `${done}\nSWARM_DELIVERY: ${JSON.stringify({ artifact })}` })
  await refreshNativeMission(delivery.missionId)
  vi.mocked(callNativeBridge).mockReset()
  return { missionId: delivery.missionId, developerId: delivery.assignments[0].id }
}

function fenced(admission = 'review-admission-new', overrides: Partial<NativeObservation> = {}): NativeObservation {
  return { profileId: reviewerHome, sessionId: SID, receipt: { admission_id: admission, ref: { profile_id: reviewerHome, session_id: SID }, status: 'queued', outcome: null }, preflight: { source: 'desktop', executionGeneration: 3, idleVerified: true, atomicIdleFence: true, capability: 'idle-admission-v1' }, ...overrides }
}

function review(missionId: string, developerId: string, extra: Record<string, unknown> = {}) {
  return { missionId, assignments: [{ workerId: 'argus-reviewer', task: 'Review exact artifact', dependsOn: [developerId], existingSessionId: SID, ...extra }] }
}

async function counters(label: string) {
  const { SWARM_MISSIONS_PATH } = await import('./swarm-missions')
  const actions = vi.mocked(callNativeBridge).mock.calls.map(([request]) => request.action)
  const store = JSON.parse(readFileSync(SWARM_MISSIONS_PATH, 'utf8')) as { missions: Array<{ assignments: Array<{ native?: { admissionId: string | null; report?: unknown } }> }> }
  const counts = {
    missions: store.missions.length,
    assignments: store.missions.reduce((total, mission) => total + mission.assignments.length, 0),
    nativeCreates: actions.filter((action) => action === 'submit').length,
    existingSessionSubmits: actions.filter((action) => action === 'submit_existing').length,
    admissions: store.missions.flatMap((mission) => mission.assignments).filter((item) => item.native?.admissionId).length,
    results: store.missions.flatMap((mission) => mission.assignments).filter((item) => item.native?.report).length,
  }
  console.log('COUNTERS', label, JSON.stringify(counts))
  return counts
}

describe('B2 existing reviewer session binding', () => {
  it('admits ONE new genuine assignment as a new admission in the SAME selected session, never session.create', async () => {
    const { missionId, developerId } = await developerArtifact()
    const { dispatchNativeAssignments } = await import('./swarm-native')
    const { SWARM_MISSIONS_PATH, getSwarmMission } = await import('./swarm-missions')
    vi.mocked(callNativeBridge).mockResolvedValueOnce(fenced())
    const result = await dispatchNativeAssignments(review(missionId, developerId), await authority())
    const reviewer = result.assignments[1]
    const request = vi.mocked(callNativeBridge).mock.calls[0][0]
    expect(request).toMatchObject({ action: 'submit_existing', workerId: 'argus-reviewer', sessionId: SID, requestId: `${missionId}:${reviewer.id}` })
    expect(request.text).toContain(`Existing-session binding: this is NEW assignment ${reviewer.id}`)
    expect(request.text).toContain(artifact.sha256)
    expect(reviewer).toMatchObject({ state: 'queued', sessionBinding: { mode: 'existing', sessionId: SID }, native: { binding: 'existing-session', sessionId: SID, admissionId: 'review-admission-new', requestId: `${missionId}:${reviewer.id}`, preflight: { atomicIdleFence: true, capability: 'idle-admission-v1', executionGeneration: 3 } } })
    // Fresh readback / reload: the immutable selection and NEW identities are durable.
    vi.resetModules()
    const reloaded = JSON.parse(readFileSync(SWARM_MISSIONS_PATH, 'utf8')).missions[0].assignments[1]
    expect(reloaded).toMatchObject({ id: reviewer.id, sessionBinding: { sessionId: SID }, native: { requestId: `${missionId}:${reviewer.id}`, sessionId: SID, admissionId: 'review-admission-new' } })
    expect(getSwarmMission(missionId)!.events.some((entry) => entry.type === 'assignment_dispatched' && (entry.data as { admissionId?: string })?.admissionId === 'review-admission-new')).toBe(true)
    expect(await counters('positive')).toMatchObject({ missions: 1, assignments: 2, nativeCreates: 0, existingSessionSubmits: 1, admissions: 2 })
  })

  it('persists the exact dependency revision/hash review from the new admission only', async () => {
    const { missionId, developerId } = await developerArtifact()
    const { dispatchNativeAssignments, refreshNativeMission } = await import('./swarm-native')
    const { getSwarmMission } = await import('./swarm-missions')
    vi.mocked(callNativeBridge).mockResolvedValueOnce(fenced())
    await dispatchNativeAssignments(review(missionId, developerId), await authority())
    const verdict = { artifact: { revision: 'c'.repeat(40), sha256: 'd'.repeat(64), path: 'synthetic/review.md' }, review: { assignmentId: developerId, revision: artifact.revision, sha256: artifact.sha256, verdict: 'accepted' } }
    vi.mocked(callNativeBridge).mockResolvedValueOnce({ profileId: reviewerHome, sessionId: SID, receipt: { admission_id: 'review-admission-new', ref: { profile_id: reviewerHome, session_id: SID }, status: 'terminal', outcome: 'completed' }, finalText: `${done}\nSWARM_DELIVERY: ${JSON.stringify(verdict)}` })
    await refreshNativeMission(missionId)
    const mission = getSwarmMission(missionId)!
    expect(mission.assignments[0]).toMatchObject({ state: 'done', reviewedBy: 'argus-reviewer' })
    const event = mission.events.find((entry) => entry.type === 'review')
    expect(event?.data).toMatchObject({ artifact, sessionId: SID, admissionId: 'review-admission-new', reviewAssignmentId: mission.assignments[1].id })
    expect(await counters('review_persistence')).toMatchObject({ nativeCreates: 0, existingSessionSubmits: 1 })
  })

  it('keeps the default new-session dispatch unchanged when no session is selected', async () => {
    const { missionId, developerId } = await developerArtifact()
    const { dispatchNativeAssignments } = await import('./swarm-native')
    vi.mocked(callNativeBridge).mockResolvedValueOnce({ profileId: reviewerHome, sessionId: 'fresh-session', receipt: { admission_id: 'fresh-admission', ref: { profile_id: reviewerHome, session_id: 'fresh-session' }, status: 'queued', outcome: null } })
    const result = await dispatchNativeAssignments({ missionId, assignments: [{ workerId: 'argus-reviewer', task: 'Default review', dependsOn: [developerId] }] })
    expect(vi.mocked(callNativeBridge).mock.calls[0][0]).toMatchObject({ action: 'submit' })
    expect(vi.mocked(callNativeBridge).mock.calls[0][0]).not.toHaveProperty('sessionId')
    expect(result.assignments[1].sessionBinding).toBeUndefined()
    expect(result.assignments[1].native).toMatchObject({ sessionId: 'fresh-session', admissionId: 'fresh-admission' })
    expect(result.assignments[1].native).not.toHaveProperty('binding')
  })

  it('refuses missing, forged or mismatched helper authority before any store write or native effect', async () => {
    const { missionId, developerId } = await developerArtifact()
    const { dispatchNativeAssignments } = await import('./swarm-native')
    const { SWARM_MISSIONS_PATH, createOrUpdateMission, stageNativeAssignment } = await import('./swarm-missions')
    const before = readFileSync(SWARM_MISSIONS_PATH, 'utf8')
    const forged = Object.freeze({ sessionIds: Object.freeze([SID]) })
    for (const grant of [undefined, forged, await authority(['local-other-session-0002'])]) {
      await expect(dispatchNativeAssignments(review(missionId, developerId), grant)).rejects.toThrow('existing_session_authorization_required')
      expect(() => createOrUpdateMission({ missionId, title: '', assignments: [{ workerId: 'argus-reviewer', task: 'Direct helper', dependsOn: [developerId], deliveryKind: 'code', sessionBinding: { mode: 'existing', sessionId: SID } }] }, grant)).toThrow('existing_session_authorization_required')
    }
    expect(readFileSync(SWARM_MISSIONS_PATH, 'utf8')).toBe(before)
    // A binding stored WITH authority still cannot be staged by a helper call without it.
    const created = createOrUpdateMission({ missionId, title: '', assignments: [{ workerId: 'argus-reviewer', task: 'Direct helper', dependsOn: [developerId], deliveryKind: 'code', sessionBinding: { mode: 'existing', sessionId: SID } }] }, await authority())
    const bound = created.assignments.find((item) => item.task === 'Direct helper')!
    expect(() => stageNativeAssignment(missionId, bound.id, { requestId: 'r', profileId: reviewerHome, sessionId: SID, admissionId: null, status: 'submitting', binding: 'existing-session' })).toThrow('existing_session_authorization_required')
    expect(JSON.parse(readFileSync(SWARM_MISSIONS_PATH, 'utf8')).missions[0].assignments.find((item: { id: string }) => item.id === bound.id).native).toBeUndefined()
    expect(callNativeBridge).not.toHaveBeenCalled()
  })

  it.each([
    ['argus-developer-local selection', { workerId: 'argus-developer-local' }, 'existing_session_not_eligible'],
    ['report delivery', { deliveryKind: 'report' }, 'existing_session_not_eligible'],
    ['no dependency', { dependsOn: [] }, 'existing_session_not_eligible'],
    ['short session id', { existingSessionId: 'local' }, 'invalid_existing_session_id'],
    ['spaced session id', { existingSessionId: 'local reviewer 0001' }, 'invalid_existing_session_id'],
    ['non-string session id', { existingSessionId: 7 }, 'invalid_existing_session_id'],
  ])('rejects %s before store or native effects', async (_label, extra, reason) => {
    const { missionId, developerId } = await developerArtifact()
    const { dispatchNativeAssignments } = await import('./swarm-native')
    const { SWARM_MISSIONS_PATH } = await import('./swarm-missions')
    const before = readFileSync(SWARM_MISSIONS_PATH, 'utf8')
    await expect(dispatchNativeAssignments(review(missionId, developerId, extra), await authority())).rejects.toThrow(reason)
    expect(readFileSync(SWARM_MISSIONS_PATH, 'utf8')).toBe(before)
    expect(callNativeBridge).not.toHaveBeenCalled()
  })

  it('requires an exact frozen dependency artifact, not a running or report dependency', async () => {
    const { dispatchNativeAssignments } = await import('./swarm-native')
    const { SWARM_MISSIONS_PATH } = await import('./swarm-missions')
    const ref = { profile_id: join(root, '.hermes/profiles/argus-developer-local'), session_id: 'synthetic-developer' }
    vi.mocked(callNativeBridge).mockResolvedValueOnce({ profileId: ref.profile_id, sessionId: ref.session_id, receipt: { admission_id: 'dev-admission', ref, status: 'started', outcome: null } })
    const running = await dispatchNativeAssignments({ assignments: [{ workerId: 'argus-developer-local', task: 'Still running' }] })
    vi.mocked(callNativeBridge).mockReset()
    const before = readFileSync(SWARM_MISSIONS_PATH, 'utf8')
    await expect(dispatchNativeAssignments(review(running.missionId, running.assignments[0].id), await authority())).rejects.toThrow('existing_session_requires_exact_artifact_dependency')
    expect(readFileSync(SWARM_MISSIONS_PATH, 'utf8')).toBe(before)
    expect(callNativeBridge).not.toHaveBeenCalled()
  })

  it('keeps the selection immutable and dedupes repeated and concurrent identical requests', async () => {
    const { missionId, developerId } = await developerArtifact()
    const { dispatchNativeAssignments } = await import('./swarm-native')
    let release!: (value: NativeObservation) => void
    vi.mocked(callNativeBridge).mockImplementationOnce(() => new Promise<NativeObservation>((resolve) => { release = resolve }))
    const grant = await authority([SID, 'local-other-session-0002'])
    const first = dispatchNativeAssignments(review(missionId, developerId), grant)
    const second = dispatchNativeAssignments(review(missionId, developerId), grant)
    await vi.waitFor(() => expect(callNativeBridge).toHaveBeenCalledTimes(1))
    const secondResult = await second
    release(fenced())
    const firstResult = await first
    expect(firstResult.assignments).toHaveLength(2)
    expect(secondResult.assignments).toHaveLength(2)
    await dispatchNativeAssignments(review(missionId, developerId), grant)  // a later exact repeat
    expect(callNativeBridge).toHaveBeenCalledTimes(1)
    await expect(dispatchNativeAssignments(review(missionId, developerId, { existingSessionId: 'local-other-session-0002' }), grant)).rejects.toThrow('session_binding_immutable')
    await expect(dispatchNativeAssignments({ missionId, assignments: [{ workerId: 'argus-reviewer', task: 'Review exact artifact', dependsOn: [developerId] }] })).rejects.toThrow('session_binding_immutable')
    expect(await counters('repeat_concurrent')).toMatchObject({ assignments: 2, existingSessionSubmits: 1, nativeCreates: 0 })
  })

  it('never reserves the same session or reviewer twice across missions/assignments while one is in flight', async () => {
    const { missionId, developerId } = await developerArtifact()
    const { dispatchNativeAssignments } = await import('./swarm-native')
    let release!: (value: NativeObservation) => void
    vi.mocked(callNativeBridge).mockImplementationOnce(() => new Promise<NativeObservation>((resolve) => { release = resolve }))
    const grant = await authority()
    const first = dispatchNativeAssignments(review(missionId, developerId), grant)
    await vi.waitFor(() => expect(callNativeBridge).toHaveBeenCalledTimes(1))
    await expect(dispatchNativeAssignments(review(missionId, developerId, { task: 'A different review' }), grant)).rejects.toThrow(/reserved/)
    release(fenced())
    await first
    expect(callNativeBridge).toHaveBeenCalledTimes(1)
    expect(await counters('cross_assignment_reservation')).toMatchObject({ existingSessionSubmits: 1, nativeCreates: 0 })
  })

  it('keeps a lost reply UNKNOWN with no resubmission and no fallback session', async () => {
    const { missionId, developerId } = await developerArtifact()
    const { dispatchNativeAssignments } = await import('./swarm-native')
    const grant = await authority()
    vi.mocked(callNativeBridge).mockRejectedValueOnce(new Error('transport closed after send'))
    const lost = await dispatchNativeAssignments(review(missionId, developerId), grant)
    expect(lost.assignments[1]).toMatchObject({ state: 'needs_input', native: { status: 'unknown', admissionId: null, sessionId: SID, binding: 'existing-session' } })
    vi.mocked(callNativeBridge).mockResolvedValueOnce({ profileId: reviewerHome, error: 'native_admission_unknown', notAdmitted: false })
    await dispatchNativeAssignments(review(missionId, developerId), grant)
    expect(callNativeBridge).toHaveBeenCalledTimes(1)
    expect(await counters('lost_reply')).toMatchObject({ nativeCreates: 0, existingSessionSubmits: 1, admissions: 1 })
  })

  it.each([
    ['another session receipt', fenced('review-admission-new', { sessionId: 'local-other-session-0002', receipt: { admission_id: 'review-admission-new', ref: { profile_id: '', session_id: 'local-other-session-0002' }, status: 'queued', outcome: null } })],
    ['another profile receipt', fenced('review-admission-new', { profileId: '/synthetic/other-profile' })],
    ['no atomic idle fence', fenced('review-admission-new', { preflight: { source: 'desktop', executionGeneration: 3, idleVerified: true, atomicIdleFence: false, capability: 'idle-admission-v1' } })],
    ['no preflight at all', fenced('review-admission-new', { preflight: undefined })],
    ['the OLD developer admission', fenced('dev-admission')],
  ])('never persists %s as a successful binding', async (_label, observation) => {
    const { missionId, developerId } = await developerArtifact()
    const { dispatchNativeAssignments } = await import('./swarm-native')
    vi.mocked(callNativeBridge).mockResolvedValueOnce(observation)
    const result = await dispatchNativeAssignments(review(missionId, developerId), await authority())
    expect(result.assignments[1]).toMatchObject({ state: 'needs_input', native: { status: 'unknown', admissionId: null } })
    expect(result.assignments[1].native?.preflight).toBeUndefined()
    expect(result.assignments[0]).toMatchObject({ state: 'checkpointed', reviewedBy: null })
  })

  it('blocks without admission when the native idle-admission capability is missing', async () => {
    const { missionId, developerId } = await developerArtifact()
    const { dispatchNativeAssignments } = await import('./swarm-native')
    vi.mocked(callNativeBridge).mockResolvedValueOnce({ profileId: reviewerHome, error: 'native_idle_fence_unavailable', notAdmitted: true })
    const result = await dispatchNativeAssignments(review(missionId, developerId), await authority())
    expect(result.assignments[1]).toMatchObject({ state: 'blocked', native: { status: 'not_admitted', admissionId: null } })
    expect(await counters('missing_capability')).toMatchObject({ existingSessionSubmits: 1, nativeCreates: 0, admissions: 1 })
  })
})


// V2: all identities below are fixtures; actual owning mission/authority/persistence functions.
describe('V2 same Developer continuation', () => {
  async function prepared() {
    const prep = await developerArtifact()
    const { dispatchNativeAssignments } = await import('./swarm-native')
    // Keep the fixture mission open: completed historical missions must remain immutable.
    const { createOrUpdateMission } = await import('./swarm-missions')
    createOrUpdateMission({ missionId: prep.missionId, title: '', assignments: [{ workerId: 'argus-validator', task: 'Synthetic pending qualification gate', reviewRequired: false }] })
    // Complete the dependency's independent-review fixture via the owning observation path.
    const ref = { profile_id: reviewerHome, session_id: 'synthetic-prep-review' }
    vi.mocked(callNativeBridge).mockResolvedValueOnce({ profileId: reviewerHome, sessionId: ref.session_id,
      receipt: { admission_id: 'synthetic-prep-review-admission', ref, status: 'terminal', outcome: 'completed' },
      finalText: `${done}\nSWARM_DELIVERY: ${JSON.stringify({ artifact: { ...artifact, path: 'synthetic/review.md' }, review: { assignmentId: prep.developerId, revision: artifact.revision, sha256: artifact.sha256, verdict: 'accepted' } })}` })
    await dispatchNativeAssignments({ missionId: prep.missionId, assignments: [{ workerId: 'argus-reviewer', task: 'Synthetic prerequisite review', dependsOn: [prep.developerId] }] })
    vi.mocked(callNativeBridge).mockReset()
    writeFileSync(join(root, 'swarm.yaml'), readFileSync(join(root, 'swarm.yaml'), 'utf8') + '- id: argus-developer\n  profile: argus-developer\n')
    const home = join(root, '.hermes/profiles/argus-developer')
    mkdirSync(home, { recursive: true }); writeFileSync(join(home, 'config.yaml'), 'model: synthetic-saved-route\n')
    return { ...prep, home }
  }
  it('admits one new Developer assignment in the explicitly selected SAME session with no create or resend', async () => {
    vi.stubEnv('ARGUS_WORKSPACE_GPU_SOURCE_ENABLED', '1')
    const { missionId, developerId, home } = await prepared()
    const { dispatchNativeAssignments } = await import('./swarm-native')
    const { getSwarmMission } = await import('./swarm-missions')
    vi.mocked(callNativeBridge).mockResolvedValueOnce(fenced('synthetic-new-developer-admission', { profileId: home,
      receipt: { admission_id: 'synthetic-new-developer-admission', ref: { profile_id: home, session_id: SID }, status: 'queued', outcome: null } }))
    const body = { missionId, assignments: [{ workerId: 'argus-developer', task: 'Synthetic continuation', dependsOn: [developerId], existingSessionId: SID }] }
    const granted = await authority()
    await dispatchNativeAssignments(body, granted)
    await dispatchNativeAssignments(body, granted)
    expect(callNativeBridge).toHaveBeenCalledTimes(1)
    expect(vi.mocked(callNativeBridge).mock.calls[0][0]).toMatchObject({ action: 'submit_existing', workerId: 'argus-developer', sessionId: SID })
    expect(getSwarmMission(missionId)!.assignments.at(-1)).toMatchObject({ native: { sessionId: SID, admissionId: 'synthetic-new-developer-admission' } })
    console.log('SAME_DEVELOPER_FIXTURE_COUNTERS', JSON.stringify({ submit: 1, session_create: 0, replay_submit: 0 }))
  })
  it('keeps Developer binding default OFF even with a genuine request authority', async () => {
    const { missionId, developerId } = await prepared()
    const { dispatchNativeAssignments } = await import('./swarm-native')
    await expect(dispatchNativeAssignments({ missionId, assignments: [{ workerId: 'argus-developer', task: 'Synthetic continuation', dependsOn: [developerId], existingSessionId: SID }] }, await authority())).rejects.toThrow('existing_session_not_eligible')
    expect(callNativeBridge).not.toHaveBeenCalled()
  })
})
