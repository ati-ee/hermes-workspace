import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ARGUS_EXECUTION_IDS } from '../lib/argus-swarm-policy'
import type { SwarmMission, SwarmMissionAssignment } from './swarm-missions'

const fixture = vi.hoisted(() => ({ missions: [] as Array<SwarmMission>, observe: vi.fn() }))
vi.mock('./swarm-native-bridge', () => ({ callNativeBridge: fixture.observe }))
vi.mock('./swarm-missions', () => ({ listSwarmMissions: () => fixture.missions }))
const sample = readFileSync(new URL('../../swarm.yaml', import.meta.url), 'utf8')
let root: string
let home: string
beforeEach(() => {
  vi.resetModules(); fixture.missions = []; fixture.observe.mockReset()
  root = mkdtempSync(join(tmpdir(), 'pr1-policy-'))
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  vi.stubEnv('HERMES_HOME', join(root, 'home'))
  writeFileSync(join(root, 'swarm.yaml'), sample)
  for (const id of ARGUS_EXECUTION_IDS) {
    mkdirSync(join(root, 'home/profiles', id), { recursive: true })
    writeFileSync(join(root, 'home/profiles', id, 'config.yaml'), 'model: synthetic-unused-route\n')
  }
  home = join(root, 'home/profiles/argus-developer')
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })
it('checked-in roster intersects exactly the allowed existing profiles without installing any', async () => {
  const { configuredArgusProfiles } = await import('./swarm-profile-policy')
  expect(configuredArgusProfiles({ executionOnly: true }).map(p => p.workerId)).toEqual([...ARGUS_EXECUTION_IDS])
})
it('missing, aliased and archived profiles still fail closed; legacy identities stay forbidden', async () => {
  const { configuredProfile } = await import('./swarm-profile-policy')
  expect(() => configuredProfile('builder', true)).toThrow('profile_not_allowed')
  rmSync(join(home, 'config.yaml'))
  expect(() => configuredProfile('argus-developer', true)).toThrow('profile_not_configured')
  writeFileSync(join(root, 'swarm.yaml'), 'workers:\n- id: argus-reviewer\n  profile: argus-developer\n')
  expect(() => configuredProfile('argus-reviewer', true)).toThrow('profile_not_configured')
  writeFileSync(join(root, 'swarm.yaml'), 'workers:\n- id: argus-reviewer\n  archived: true\n')
  expect(() => configuredProfile('argus-reviewer', true)).toThrow('profile_archived')
})
function assignment(id: string, state: SwarmMissionAssignment['state'], at: number, admissionStatus = 'started'): SwarmMissionAssignment {
  return { id, workerId: 'argus-developer', task: id, rationale: null, dependsOn: [], reviewRequired: true,
    state, dispatchedAt: at, completedAt: state === 'done' ? at : null, reviewedAt: null, reviewedBy: null,
    checkpoint: null, native: { requestId: id, profileId: home, sessionId: 'synthetic-reused-session', admissionId: id+'-admission',
      status: admissionStatus, observedAt: Date.now(), outcome: admissionStatus === 'terminal' ? 'completed' : null } }
}
function mission(assignments: Array<SwarmMissionAssignment>, id='mission', createdAt=1): SwarmMission {
  return { id, title: id, state: 'executing', createdAt, updatedAt: Date.now(), assignments, events: [] }
}
async function status(nativeStatus='started') {
  // The status tests use their own allowed metadata, independent of the sample-roster failure.
  writeFileSync(join(root, 'swarm.yaml'), 'workers:\n- id: argus-developer\n  profile: argus-developer\n')
  fixture.observe.mockResolvedValue({ profileId: home, connected: true, status: nativeStatus,
    sessions: [{ sessionId: 'synthetic-reused-session', source: 'desktop', title: 'Current native session', status: nativeStatus,
      model: 'synthetic-reported-model', provider: 'synthetic-reported-provider' }] })
  const { readNativeProfileStatus } = await import('./swarm-native-status')
  const result = await readNativeProfileStatus('argus-developer')
  expect(fixture.observe).toHaveBeenCalledTimes(1)
  expect(fixture.observe.mock.calls[0][0].action).toBe('status')
  return result
}
it.each(['correction', 'continuation'] as const)('selects the current %s, not the earlier accepted/review turn', async intent => {
  fixture.missions = [mission([assignment('initial', intent==='correction'?'blocked':'done', 1, 'terminal'),
    { ...assignment(intent, 'dispatched', 2), producerIntent: intent }])]
  expect(await status()).toMatchObject({ assignmentId: intent, admissionId: intent+'-admission', task: intent, state: 'active' })
})
it('selects the last appended admission even when dispatch timestamps tie', async () => {
  fixture.missions=[mission([assignment('old','done',1,'terminal'),assignment('current','dispatched',1)])]
  expect(await status()).toMatchObject({assignmentId:'current',state:'active'})
})
it('does not downgrade real running evidence to a queued store snapshot', async () => {
  fixture.missions=[mission([assignment('current','queued',2,'queued')])]
  expect(await status()).toMatchObject({assignmentId:'current',state:'active'})
})
it('does not attach a historical terminal admission to an uncorrelated live turn', async () => {
  fixture.missions=[mission([assignment('old','done',1,'terminal')])]
  expect(await status()).toMatchObject({state:'active',missionId:null,assignmentId:null,admissionId:null,task:'Current native session'})
})
it('preserves genuine waiting instead of older terminal completion', async () => {
  fixture.missions=[mission([assignment('old','done',1,'terminal')])]
  expect(await status('waiting')).toMatchObject({state:'waiting',missionId:null,assignmentId:null})
})
it('retains a current approval wait and a settled idle-session positive', async () => {
  fixture.missions=[mission([assignment('current','needs_input',2)])]
  expect(await status('idle')).toMatchObject({assignmentId:'current',state:'waiting'})
})
it('keeps a real settled accepted turn completed when native is idle', async () => {
  fixture.missions=[mission([assignment('accepted','done',1,'terminal')])]
  expect(await status('idle')).toMatchObject({assignmentId:'accepted',state:'completed'})
})
it('does not relabel unresolved UNKNOWN as idle or previous completed work', async () => {
  const ambiguous=assignment('ambiguous','queued',2,'unknown'); ambiguous.native!.admissionId=null
  fixture.missions=[mission([assignment('old','done',1,'terminal'),ambiguous])]
  expect(await status('idle')).toMatchObject({assignmentId:'ambiguous',admissionId:null,state:'unknown'})
})
it('ignores foreign profile bindings and compares current admissions across missions', async () => {
  const foreign=assignment('foreign','done',100,'terminal'); foreign.native!.profileId=join(root,'foreign')
  fixture.missions=[mission([foreign],'foreign',100),mission([assignment('old','done',1,'terminal')],'old',1),mission([assignment('new','dispatched',2)],'new',2)]
  expect(await status()).toMatchObject({missionId:'new',assignmentId:'new',state:'active'})
})

it('does not turn unavailable native evidence into a completed current status', async () => {
  fixture.missions=[mission([assignment('accepted','done',1,'terminal')])]
  expect(await status('unknown')).toMatchObject({state:'unknown'})
})
