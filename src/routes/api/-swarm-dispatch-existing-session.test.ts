import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isAuthenticated, isPasswordProtectionEnabled } from '../../server/auth-middleware'
import { callNativeBridge } from '../../server/swarm-native-bridge'

// B2 route gates: the existing authenticated JSON route is the ONLY issuer of existing-session
// authority. Synthetic store/HOME, mocked login check and bridge; no RPC, network or service.
vi.mock('../../server/auth-middleware', () => ({ isAuthenticated: vi.fn(() => true), isPasswordProtectionEnabled: vi.fn(() => true) }))
vi.mock('../../server/swarm-native-bridge', () => ({
  callNativeBridge: vi.fn(),
  // C2 (labelled synthetic transport, NOT Native proof; the real-Native contract is
  // src/server/swarm-native-lookup-contract.test.ts): pure prepare returns a binding, lookup is unavailable.
  prepareNativeInput: vi.fn((request: { profileHome: string; sessionId?: string | null; requestId: string }) => Promise.resolve({
    profileId: request.profileHome, sessionId: request.sessionId,
    inputBinding: { version: 'original-input-lookup-v1', ref: { profile_id: request.profileHome, session_id: request.sessionId }, input_id: request.requestId, principal_binding: 'c'.repeat(64), payload_fingerprint: 'd'.repeat(64), idle_fence: { expected_generation: 3 } },
  })),
  lookupNativeInput: vi.fn(() => Promise.resolve({ error: 'native_lookup_unavailable' })),
}))
vi.mock('../../server/gateway-capabilities', () => ({ dashboardFetch: vi.fn(), ensureGatewayProbed: vi.fn(), getResolvedUrls: vi.fn(), BEARER_TOKEN: '', CLAUDE_API: 'http://synthetic.invalid' }))
vi.mock('../../server/openai-compat-api', () => ({ getBearerToken: vi.fn() }))
vi.mock('../../server/claude-api', () => ({ deleteSession: vi.fn() }))
vi.mock('../../server/kanban-dashboard-proxy', () => ({ fetchDashboardKanbanTask: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({ createFileRoute: () => (options: unknown) => ({ options }) }))

type Handler = (context: { request: Request }) => Promise<Response>
function handlers(route: unknown) { return (route as { options: { server: { handlers: { POST: Handler } } } }).options.server.handlers }
const SID = 'local-reviewer-synthetic-0001'
const ORIGIN = 'http://synthetic.invalid'
let root: string

beforeEach(() => {
  vi.clearAllMocks()
  root = mkdtempSync(join(tmpdir(), 'existing-session-route-'))
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  vi.stubEnv('HERMES_HOME', join(root, '.hermes'))
  writeFileSync(join(root, 'swarm.yaml'), 'workers:\n- id: argus-developer-local\n  profile: argus-developer-local\n- id: argus-reviewer\n  profile: argus-reviewer\n')
  for (const id of ['argus-developer-local', 'argus-reviewer']) {
    mkdirSync(join(root, '.hermes/profiles', id), { recursive: true })
    writeFileSync(join(root, '.hermes/profiles', id, 'config.yaml'), 'model: synthetic\n')
  }
  vi.mocked(isAuthenticated).mockReturnValue(true)
  vi.mocked(isPasswordProtectionEnabled).mockReturnValue(true)
  vi.resetModules()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { force: true, recursive: true }) })

function post(body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: ORIGIN }) {
  return { request: new Request(`${ORIGIN}/api/swarm-dispatch`, { method: 'POST', headers, body: JSON.stringify(body) }) }
}

// The complete six-field checkpoint: a terminal receipt without it never captures an artifact,
// so the dependency would (correctly) not be eligible for an existing-session review.
const DONE = 'STATE: DONE\nFILES_CHANGED: synthetic\nCOMMANDS_RUN: synthetic\nRESULT: frozen\nBLOCKER: none\nNEXT_ACTION: review'

async function developerArtifact() {
  const { dispatchNativeAssignments, refreshNativeMission } = await import('../../server/swarm-native')
  const { getSwarmMission } = await import('../../server/swarm-missions')
  const ref = { profile_id: join(root, '.hermes/profiles/argus-developer-local'), session_id: 'synthetic-developer' }
  const artifact = { revision: 'a'.repeat(40), sha256: 'b'.repeat(64), path: 'synthetic/frozen.patch' }
  vi.mocked(callNativeBridge).mockResolvedValueOnce({ profileId: ref.profile_id, sessionId: ref.session_id, receipt: { admission_id: 'dev-admission', ref, status: 'started', outcome: null } })
  const delivery = await dispatchNativeAssignments({ assignments: [{ workerId: 'argus-developer-local', task: 'Synthetic implementation' }] })
  vi.mocked(callNativeBridge).mockResolvedValueOnce({ profileId: ref.profile_id, sessionId: ref.session_id, receipt: { admission_id: 'dev-admission', ref, status: 'terminal', outcome: 'completed' }, finalText: `${DONE}\nSWARM_DELIVERY: ${JSON.stringify({ artifact })}` })
  await refreshNativeMission(delivery.missionId)
  // The real eligible dependency is persisted before any HTTP call.
  expect(getSwarmMission(delivery.missionId)!.assignments[0]).toMatchObject({ state: 'checkpointed', native: { status: 'terminal', outcome: 'completed', admissionId: 'dev-admission', artifact } })
  vi.mocked(callNativeBridge).mockReset()
  return { missionId: delivery.missionId, developerId: delivery.assignments[0].id }
}

const missionsPath = () => join(root, '.runtime/swarm-missions.json')

describe('POST /api/swarm-dispatch existingSessionId', () => {
  it('admits through the authenticated same-origin JSON route (exact operator payload shape)', async () => {
    const { missionId, developerId } = await developerArtifact()
    const reviewerHome = join(root, '.hermes/profiles/argus-reviewer')
    vi.mocked(callNativeBridge).mockResolvedValueOnce({ profileId: reviewerHome, sessionId: SID, receipt: { admission_id: 'review-admission-new', ref: { profile_id: reviewerHome, session_id: SID }, status: 'queued', outcome: null }, preflight: { source: 'desktop', executionGeneration: 3, idleVerified: true, atomicIdleFence: true, capability: 'idle-admission-v1' } })
    const { Route } = await import('./swarm-dispatch')
    const response = await handlers(Route).POST(post({ missionId, assignments: [{ workerId: 'argus-reviewer', task: 'Review exact artifact', dependsOn: [developerId], existingSessionId: SID }] }))
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.assignments[1]).toMatchObject({ sessionBinding: { mode: 'existing', sessionId: SID }, native: { admissionId: 'review-admission-new', sessionId: SID } })
    const actions = vi.mocked(callNativeBridge).mock.calls.map(([request]) => request.action)
    expect(actions).toEqual(['submit_existing'])
    expect(JSON.stringify(data)).not.toContain('claude-auth')
    const saved = JSON.parse(readFileSync(missionsPath(), 'utf8')) as { missions: Array<{ assignments: Array<{ id: string; native?: { admissionId: string | null } }> }> }
    const counts = {
      missions: saved.missions.length,
      assignments: saved.missions[0].assignments.length,
      admissionIds: saved.missions[0].assignments.map((item) => item.native?.admissionId ?? null),
      nativeCreates: actions.filter((action) => action !== 'submit_existing').length,
      existingSessionSubmits: actions.filter((action) => action === 'submit_existing').length,
    }
    console.log('COUNTERS route_positive', JSON.stringify(counts))
    expect(counts).toEqual({ missions: 1, assignments: 2, admissionIds: ['dev-admission', 'review-admission-new'], nativeCreates: 0, existingSessionSubmits: 1 })
    expect(saved.missions[0].assignments[0].id).toBe(developerId)
  })

  it.each([
    ['unauthenticated', () => vi.mocked(isAuthenticated).mockReturnValue(false), undefined, 401],
    ['no password protection (login disabled)', () => vi.mocked(isPasswordProtectionEnabled).mockReturnValue(false), undefined, 401],
    ['non-JSON content type', () => undefined, { 'Content-Type': 'text/plain', Origin: ORIGIN }, 415],
    ['JSON-looking but not exact content type', () => undefined, { 'Content-Type': 'application/jsonx', Origin: ORIGIN }, 415],
    ['missing Origin', () => undefined, { 'Content-Type': 'application/json' }, 403],
    ['cross Origin', () => undefined, { 'Content-Type': 'application/json', Origin: 'http://attacker.invalid' }, 403],
    ['cross-site fetch metadata', () => undefined, { 'Content-Type': 'application/json', Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' }, 403],
  ])('denies %s with zero store writes and zero native effects', async (_label, arrange, headers, status) => {
    const { missionId, developerId } = await developerArtifact()
    const before = readFileSync(missionsPath(), 'utf8')
    arrange()
    const { Route } = await import('./swarm-dispatch')
    const response = await handlers(Route).POST(post({ missionId, assignments: [{ workerId: 'argus-reviewer', task: 'Review exact artifact', dependsOn: [developerId], existingSessionId: SID }] }, headers))
    expect(response.status).toBe(status)
    expect(readFileSync(missionsPath(), 'utf8')).toBe(before)
    expect(callNativeBridge).not.toHaveBeenCalled()
  })

  it('cannot be authorized by body fields such as authenticated/approved/sessionId flags', async () => {
    const { missionId, developerId } = await developerArtifact()
    const before = readFileSync(missionsPath(), 'utf8')
    vi.mocked(isAuthenticated).mockReturnValue(false)
    const { Route } = await import('./swarm-dispatch')
    const response = await handlers(Route).POST(post({ missionId, authenticated: true, approved: true, existingSessionAuthority: { sessionIds: [SID] }, assignments: [{ workerId: 'argus-reviewer', task: 'Review exact artifact', dependsOn: [developerId], existingSessionId: SID, authorized: true }] }))
    expect(response.status).toBe(401)
    expect(readFileSync(missionsPath(), 'utf8')).toBe(before)
    expect(callNativeBridge).not.toHaveBeenCalled()
  })

  it('keeps the default route path without existingSessionId free of the new gates', async () => {
    const { Route } = await import('./swarm-dispatch')
    const reviewerHome = join(root, '.hermes/profiles/argus-reviewer')
    vi.mocked(callNativeBridge).mockResolvedValueOnce({ profileId: reviewerHome, sessionId: 'fresh', receipt: { admission_id: 'fresh-admission', ref: { profile_id: reviewerHome, session_id: 'fresh' }, status: 'queued', outcome: null } })
    const response = await handlers(Route).POST(post({ assignments: [{ workerId: 'argus-reviewer', task: 'Ordinary review' }] }, { 'Content-Type': 'application/json' }))
    expect(response.status).toBe(200)
    expect(vi.mocked(callNativeBridge).mock.calls[0][0]).toMatchObject({ action: 'submit' })
    expect(existsSync(missionsPath())).toBe(true)
  })
})
