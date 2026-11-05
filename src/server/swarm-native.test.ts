import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callNativeBridge } from './swarm-native-bridge'

vi.mock('./swarm-native-bridge', () => ({ callNativeBridge: vi.fn() }))
// Offline: the real modules probe the local gateway/dashboard (and fetch a token) on import.
vi.mock('./gateway-capabilities', () => ({ ensureGatewayProbed: vi.fn(), dashboardFetch: vi.fn(), BEARER_TOKEN: '', CLAUDE_API: 'http://synthetic.invalid' }))
vi.mock('./kanban-dashboard-proxy', () => ({ fetchDashboardKanbanTask: vi.fn() }))

let root: string
beforeEach(() => {
  vi.clearAllMocks()
  root = mkdtempSync(join(tmpdir(), 'swarm-native-'))
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  vi.stubEnv('HERMES_HOME', join(root, '.hermes'))
  writeFileSync(join(root, 'swarm.yaml'), 'version: 1\nworkers:\n- id: orchestrator-argus\n  profile: orchestrator-argus\n- id: argus-developer-local\n  profile: argus-developer-local\n- id: argus-reviewer\n  profile: argus-reviewer\n- id: builder\n  archived: true\n- id: argus-validator\n  archived: true\n- id: whatsapp\n')
  for (const id of ['orchestrator-argus', 'argus-developer-local', 'argus-reviewer', 'whatsapp']) {
    mkdirSync(join(root, '.hermes/profiles', id), { recursive: true })
    writeFileSync(join(root, '.hermes/profiles', id, 'config.yaml'), 'model: synthetic-saved-route\n')
  }
  vi.resetModules()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

describe('attach-only native Swarm', () => {
  it('keeps a terminal receipt and original completion time immutable across refreshes', async () => {
    const { dispatchNativeAssignments, refreshNativeMission } = await import('./swarm-native')
    const { getSwarmMission, recordNativeObservation } = await import('./swarm-missions')
    const ref = { profile_id: join(root, '.hermes/profiles/argus-developer-local'), session_id: 'synthetic-terminal-stable' }
    const receipt = { ref, admission_id: 'synthetic-terminal-admission', status: 'started', outcome: null }
    vi.mocked(callNativeBridge).mockResolvedValue({ profileId: ref.profile_id, sessionId: ref.session_id, receipt })
    const delivery = await dispatchNativeAssignments({ assignments: [{ workerId: 'argus-developer-local', task: 'Frozen private artifact' }] })
    const artifact = { revision: 'a'.repeat(40), sha256: 'b'.repeat(64), path: 'synthetic/frozen.patch' }
    vi.mocked(callNativeBridge).mockResolvedValue({ profileId: ref.profile_id, sessionId: ref.session_id, receipt: { ...receipt, status: 'terminal', outcome: 'completed' }, finalText: `STATE: DONE\nFILES_CHANGED: synthetic\nCOMMANDS_RUN: synthetic\nRESULT: frozen\nBLOCKER: none\nNEXT_ACTION: review\nSWARM_DELIVERY: ${JSON.stringify({ artifact })}` })
    await refreshNativeMission(delivery.missionId)
    const before = getSwarmMission(delivery.missionId)!
    recordNativeObservation(delivery.missionId, before.assignments[0].id, { error: 'later_unavailable' })
    await refreshNativeMission(delivery.missionId)
    expect(getSwarmMission(delivery.missionId)).toEqual(before)
    expect(callNativeBridge).toHaveBeenCalledTimes(2)
  })

  it('preserves a concurrent active admission and rejects broadcast without creating a second mission', async () => {
    const { dispatchNativeAssignments } = await import('./swarm-native')
    const { listSwarmMissions } = await import('./swarm-missions')
    const ref = { profile_id: join(root, '.hermes/profiles/argus-developer-local'), session_id: 'synthetic-reserved' }
    vi.mocked(callNativeBridge).mockResolvedValue({ profileId: ref.profile_id, sessionId: ref.session_id, receipt: { ref, admission_id: 'synthetic-running', status: 'started', outcome: null } })
    const first = await dispatchNativeAssignments({ assignments: [{ workerId: 'argus-developer-local', task: 'First private task' }] })
    await expect(dispatchNativeAssignments({ assignments: [{ workerId: 'argus-developer-local', task: 'Do not preempt' }] })).rejects.toThrow('profile_reserved')
    await expect(dispatchNativeAssignments({ workerIds: ['argus-reviewer', 'argus-developer-local'], prompt: 'Do not broadcast' })).rejects.toThrow('broadcast_disabled')
    expect(listSwarmMissions()).toHaveLength(1)
    expect(listSwarmMissions()[0].assignments[0].native?.admissionId).toBe('synthetic-running')
    await dispatchNativeAssignments({ missionId: first.missionId, assignments: [{ workerId: 'argus-developer-local', task: 'First private task' }] })
    expect(callNativeBridge).toHaveBeenCalledTimes(1)
  })

  it.each(['failed', 'cancelled', 'interrupted'])('does not promote a terminal %s receipt or wrong profile to completed work', async (outcome) => {
    const { dispatchNativeAssignments, refreshNativeMission } = await import('./swarm-native')
    const { getSwarmMission } = await import('./swarm-missions')
    const ref = { profile_id: join(root, '.hermes/profiles/argus-developer-local'), session_id: 'synthetic-failed' }
    vi.mocked(callNativeBridge).mockResolvedValue({ profileId: ref.profile_id, sessionId: ref.session_id, receipt: { ref, admission_id: 'synthetic-failure-admission', status: 'started', outcome: null } })
    const started = await dispatchNativeAssignments({ assignments: [{ workerId: 'argus-developer-local', task: 'Synthetic terminal task' }] })
    vi.mocked(callNativeBridge).mockResolvedValue({ profileId: ref.profile_id, sessionId: ref.session_id, receipt: { ref, admission_id: 'synthetic-failure-admission', status: 'terminal', outcome }, finalText: 'STATE: DONE\nRESULT: success label is not evidence' })
    await refreshNativeMission(started.missionId)
    expect(getSwarmMission(started.missionId)?.state).toBe(outcome === 'failed' ? 'blocked' : 'cancelled')
    expect(getSwarmMission(started.missionId)?.assignments[0].native?.outcome).toBe(outcome)
    vi.mocked(callNativeBridge).mockResolvedValue({ profileId: '/wrong/profile', sessionId: 'wrong-session', receipt: { ref: { profile_id: '/wrong/profile', session_id: 'wrong-session' }, admission_id: 'wrong-admission', status: 'started', outcome: null } })
    const wrong = await dispatchNativeAssignments({ assignments: [{ workerId: 'argus-reviewer', task: 'Synthetic wrong binding' }] })
    expect(wrong.assignments[0]).toMatchObject({ state: 'needs_input', native: { status: 'unknown', admissionId: null } })
  })

  it('keeps legacy missions byte-stable and cannot turn caches or aliases into execution profiles', async () => {
    const { configuredArgusProfiles } = await import('./swarm-profile-policy')
    const { createOrUpdateMission, SWARM_MISSIONS_PATH } = await import('./swarm-missions')
    const { dispatchNativeAssignments } = await import('./swarm-native')
    createOrUpdateMission({ missionId: 'legacy-football-history', title: 'Historical failed mission', assignments: [{ workerId: 'builder', task: 'Historical task' }] })
    const before = readFileSync(SWARM_MISSIONS_PATH, 'utf8')
    await expect(dispatchNativeAssignments({ missionId: 'legacy-football-history', assignments: [{ workerId: 'argus-reviewer', task: 'No history rewrite' }] })).rejects.toThrow('historical_mission_readonly')
    expect(readFileSync(SWARM_MISSIONS_PATH, 'utf8')).toBe(before)
    for (const name of ['.pytest_cache', '.deleted', '.hidden', 'hybrid', 'codex-mcp-pilot']) {
      mkdirSync(join(root, '.hermes/profiles', name))
      writeFileSync(join(root, '.hermes/profiles', name, 'config.yaml'), 'model: synthetic parked')
    }
    symlinkSync(join(root, '.hermes/profiles/argus-developer-local'), join(root, '.hermes/profiles/argus-architect'))
    expect(configuredArgusProfiles({ executionOnly: true }).map((profile) => profile.workerId)).toEqual(['orchestrator-argus', 'argus-developer-local', 'argus-reviewer'])
  })

  it('shares configured discovery with live-status consumers and never promotes unavailable data to idle', async () => {
    const { configuredArgusProfiles } = await import('./swarm-profile-policy')
    expect(configuredArgusProfiles({ executionOnly: true }).map((profile) => profile.workerId)).toEqual(['orchestrator-argus', 'argus-developer-local', 'argus-reviewer'])
    const { readNativeProfileStatus } = await import('./swarm-native-status')
    const profileId = join(root, '.hermes/profiles/argus-developer-local')
    vi.mocked(callNativeBridge).mockResolvedValue({ profileId, connected: true, status: 'started', sessions: [{ sessionId: 'ordinary-native-id', source: 'local', title: 'Synthetic ordinary GUI', status: 'started', model: 'm', provider: 'p' }] })
    expect(await readNativeProfileStatus('argus-developer-local')).toMatchObject({ state: 'active', sessionId: 'ordinary-native-id', missionId: null, admissionId: null, source: 'native-session-list' })
    vi.mocked(callNativeBridge).mockResolvedValue({ error: 'gateway_not_ready' })
    expect(await readNativeProfileStatus('argus-reviewer')).toMatchObject({ state: 'offline', connected: false })
  })

  it.each([false, true])('requires an independent immutable exact-artifact review (matching=%s)', async (matching) => {
    const { dispatchNativeAssignments, refreshNativeMission } = await import('./swarm-native')
    const { getSwarmMission, markMissionAssignmentReviewed, markMissionAssignmentsReviewedByWorker, archiveStaleMissions } = await import('./swarm-missions')
    const developerRef = { profile_id: join(root, '.hermes/profiles/argus-developer-local'), session_id: 'synthetic-developer' }
    const reviewRef = { profile_id: join(root, '.hermes/profiles/argus-reviewer'), session_id: 'synthetic-reviewer' }
    const artifact = { revision: 'a'.repeat(40), sha256: 'b'.repeat(64), path: 'synthetic/frozen.patch' }
    const done = 'STATE: DONE\nFILES_CHANGED: synthetic\nCOMMANDS_RUN: synthetic\nRESULT: delivered\nBLOCKER: none\nNEXT_ACTION: review'
    vi.mocked(callNativeBridge).mockResolvedValue({ profileId: developerRef.profile_id, sessionId: developerRef.session_id, receipt: { admission_id: 'dev-admission', ref: developerRef, status: 'started', outcome: null } })
    const delivery = await dispatchNativeAssignments({ assignments: [{ workerId: 'argus-developer-local', task: 'Synthetic implementation', reviewRequired: false }] })
    const target = delivery.assignments[0]
    const queued = await dispatchNativeAssignments({ missionId: delivery.missionId, assignments: [{ workerId: 'argus-reviewer', task: 'Review frozen artifact', dependsOn: [target.id] }] })
    expect(queued.assignments[1].state).toBe('queued')
    vi.mocked(callNativeBridge).mockResolvedValue({ profileId: developerRef.profile_id, sessionId: developerRef.session_id, receipt: { admission_id: 'dev-admission', ref: developerRef, status: 'terminal', outcome: 'completed' }, finalText: `${done}\nSWARM_DELIVERY: ${JSON.stringify({ artifact })}` })
    await refreshNativeMission(delivery.missionId)
    expect(getSwarmMission(delivery.missionId)?.state).toBe('reviewing')
    markMissionAssignmentReviewed({ missionId: delivery.missionId, assignmentId: target.id, reviewerId: 'argus-reviewer' })
    markMissionAssignmentsReviewedByWorker({ missionId: delivery.missionId, reviewerId: 'argus-reviewer' })
    archiveStaleMissions(-1)
    expect(getSwarmMission(delivery.missionId)?.state).not.toBe('complete')
    vi.mocked(callNativeBridge).mockResolvedValue({ profileId: reviewRef.profile_id, sessionId: reviewRef.session_id, receipt: { admission_id: 'review-admission', ref: reviewRef, status: 'started', outcome: null } })
    const reviewing = await dispatchNativeAssignments({ missionId: delivery.missionId, assignments: [{ workerId: 'argus-reviewer', task: 'Review frozen artifact', dependsOn: [target.id] }] })
    const reviewAssignment = reviewing.assignments[1]
    const terminalReview = (sha256: string) => ({ profileId: reviewRef.profile_id, sessionId: reviewRef.session_id, receipt: { admission_id: 'review-admission', ref: reviewRef, status: 'terminal', outcome: 'completed' }, finalText: `${done}\nSWARM_DELIVERY: ${JSON.stringify({ artifact, review: { assignmentId: target.id, revision: artifact.revision, sha256, verdict: 'accepted' } })}` })
    const { recordNativeObservation } = await import('./swarm-missions')
    recordNativeObservation(delivery.missionId, reviewAssignment.id, terminalReview(matching ? artifact.sha256 : 'c'.repeat(64)))
    expect(getSwarmMission(delivery.missionId)?.state === 'complete').toBe(matching)
    if (matching) expect(getSwarmMission(delivery.missionId)?.assignments[0].reviewedBy).toBe('argus-reviewer')
  })

  it('persists actual admission identities, never starts busy work, and fences ambiguous failures', async () => {
    const { dispatchNativeAssignments, refreshNativeMission } = await import('./swarm-native')
    const { getSwarmMission } = await import('./swarm-missions')
    const ref = { profile_id: join(root, '.hermes/profiles/argus-developer-local'), session_id: 'synthetic-session' }
    vi.mocked(callNativeBridge).mockResolvedValue({ sessionId: ref.session_id, profileId: ref.profile_id, model: 'saved-model', provider: 'saved-provider', receipt: { admission_id: 'synthetic-admission', ref, status: 'queued', outcome: null } })
    const result = await dispatchNativeAssignments({ missionId: 'synthetic-mission', assignments: [{ workerId: 'argus-developer-local', task: 'Synthetic source task', reviewRequired: false }] })
    expect(result.mission.assignments[0]).toMatchObject({ state: 'queued', completedAt: null, native: { sessionId: ref.session_id, admissionId: 'synthetic-admission', model: 'saved-model' } })
    expect(vi.mocked(callNativeBridge).mock.calls[0][0]).toMatchObject({ action: 'submit', workerId: 'argus-developer-local' })
    vi.mocked(callNativeBridge).mockResolvedValue({ sessionId: ref.session_id, profileId: ref.profile_id, receipt: { admission_id: 'synthetic-admission', ref, status: 'terminal', outcome: 'completed' }, finalText: 'STATE: DONE\nRESULT: success' })
    await refreshNativeMission('synthetic-mission')
    expect(getSwarmMission('synthetic-mission')?.state).not.toBe('complete')
    expect(getSwarmMission('synthetic-mission')?.assignments[0].state).toBe('needs_input')
    vi.mocked(callNativeBridge).mockResolvedValue({ error: 'profile_busy', notAdmitted: true })
    const busy = await dispatchNativeAssignments({ assignments: [{ workerId: 'argus-reviewer', task: 'Synthetic review' }] })
    expect(busy.mission.assignments[0]).toMatchObject({ state: 'blocked', native: { status: 'not_admitted', admissionId: null } })
    vi.mocked(callNativeBridge).mockRejectedValue(new Error('transport closed'))
    const unknown = await dispatchNativeAssignments({ assignments: [{ workerId: 'argus-reviewer', task: 'Synthetic ambiguous attempt' }] })
    expect(unknown.mission.assignments[0]).toMatchObject({ state: 'needs_input', native: { status: 'unknown' } })
    expect(readdirSync(join(root, '.hermes/profiles/argus-reviewer'))).toEqual(['config.yaml'])
  })

  it('rejects archived, unknown, communication-only and nonconfigured profiles without minting anything', async () => {
    const { requireExecutionProfile } = await import('./swarm-native')
    for (const [id, reason] of [['builder', 'profile_archived'], ['argus-validator', 'profile_archived'], ['invented', 'profile_not_allowed'], ['whatsapp', 'communication_only'], ['argus-architect', 'profile_not_configured'], ['argus-developer-local\n', 'profile_not_allowed']]) {
      expect(() => requireExecutionProfile(id)).toThrow(reason)
    }
    expect(requireExecutionProfile('argus-developer-local').workerId).toBe('argus-developer-local')
    const profile = join(root, '.hermes/profiles/argus-developer-local')
    expect(readdirSync(profile)).toEqual(['config.yaml'])
    expect(readFileSync(join(profile, 'config.yaml'), 'utf8')).toBe('model: synthetic-saved-route\n')
    rmSync(join(profile, 'config.yaml'))
    symlinkSync(join(root, '.hermes/profiles/argus-reviewer/config.yaml'), join(profile, 'config.yaml'))
    expect(() => requireExecutionProfile('argus-developer-local')).toThrow('profile_not_configured')
  })
})
