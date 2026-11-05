import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { callNativeBridge, lookupNativeInput } from '../../server/swarm-native-bridge'
import {
  isAuthenticated,
  isPasswordProtectionEnabled,
} from '../../server/auth-middleware'

// Synthetic fixtures only: actual API/auth-grant/store/state machine, mocked bridge boundary and login.
// No genuine admission, live gateway, configuration, inference or Git proof is claimed.
vi.mock('../../server/auth-middleware', () => ({
  isAuthenticated: vi.fn(() => true),
  isPasswordProtectionEnabled: vi.fn(() => true),
}))
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
vi.mock('../../server/gateway-capabilities', () => ({
  dashboardFetch: vi.fn(),
  ensureGatewayProbed: vi.fn(),
  getResolvedUrls: vi.fn(),
  BEARER_TOKEN: '',
  CLAUDE_API: 'http://synthetic.invalid',
}))
vi.mock('../../server/openai-compat-api', () => ({ getBearerToken: vi.fn() }))
vi.mock('../../server/claude-api', () => ({ deleteSession: vi.fn() }))
vi.mock('../../server/kanban-dashboard-proxy', () => ({
  fetchDashboardKanbanTask: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}))
const SID = 'local-producer-synthetic-0001'
const ORIGIN = 'http://synthetic.invalid'
const DONE =
  'STATE: DONE\nFILES_CHANGED: synthetic\nCOMMANDS_RUN: synthetic\nRESULT: frozen\nBLOCKER: none\nNEXT_ACTION: review'
const artifact = {
  revision: 'a'.repeat(40),
  sha256: 'b'.repeat(64),
  path: 'synthetic/v1.patch',
}
let root: string
beforeEach(() => {
  vi.clearAllMocks()
  root = mkdtempSync(join(tmpdir(), 'producer-reconcile-'))
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  vi.stubEnv('HERMES_HOME', join(root, '.hermes'))
  vi.stubEnv('ARGUS_WORKSPACE_GPU_SOURCE_ENABLED', '1')
  writeFileSync(
    join(root, 'swarm.yaml'),
    'workers:\n- id: argus-developer\n  profile: argus-developer\n- id: argus-reviewer\n  profile: argus-reviewer\n',
  )
  for (const id of ['argus-developer', 'argus-reviewer']) {
    mkdirSync(join(root, '.hermes/profiles', id), { recursive: true })
    writeFileSync(
      join(root, '.hermes/profiles', id, 'config.yaml'),
      'model: synthetic-saved-route\n',
    )
  }
  vi.mocked(isAuthenticated).mockReturnValue(true)
  vi.mocked(isPasswordProtectionEnabled).mockReturnValue(true)
  vi.resetModules()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})
function observation(
  worker = 'argus-developer',
  sid = SID,
  aid = 'synthetic-v1',
  terminal = false,
  delivery: unknown = { artifact },
) {
  const home = join(root, '.hermes/profiles', worker)
  return {
    profileId: home,
    sessionId: sid,
    receipt: {
      admission_id: aid,
      ref: { profile_id: home, session_id: sid },
      status: terminal ? 'terminal' : 'queued',
      outcome: terminal ? 'completed' : null,
    },
    preflight: {
      source: 'desktop',
      executionGeneration: 3,
      idleVerified: true,
      atomicIdleFence: true,
      capability: 'idle-admission-v1',
    },
    ...(terminal
      ? { finalText: `${DONE}\nSWARM_DELIVERY: ${JSON.stringify(delivery)}` }
      : {}),
  }
}
async function api(
  assignments: Array<unknown>,
  missionId?: string,
  origin = ORIGIN,
) {
  const { Route } = await import('./swarm-dispatch')
  const post = (
    Route as unknown as {
      options: {
        server: {
          handlers: { POST: (c: { request: Request }) => Promise<Response> }
        }
      }
    }
  ).options.server.handlers.POST
  return post({
    request: new Request(`${ORIGIN}/api/swarm-dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ assignments, missionId }),
    }),
  })
}
const initial = () => ({
  workerId: 'argus-developer',
  task: 'Synthetic initial producer',
  existingSessionId: SID,
  producerIntent: 'initial',
})
const stored = () =>
  readFileSync(join(root, '.runtime/swarm-missions.json'), 'utf8')
it('admits an explicit INITIAL producer in the selected session through the real API/store, never creates a session', async () => {
  vi.mocked(callNativeBridge).mockResolvedValueOnce(observation())
  const response = await api([initial()])
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.results).toHaveLength(1)
  expect(body.assignments[0]).toMatchObject({
    producerIntent: 'initial',
    sessionBinding: { sessionId: SID },
    native: { admissionId: 'synthetic-v1' },
  })
  expect(vi.mocked(callNativeBridge).mock.calls.map(([r]) => r.action)).toEqual(
    ['submit_existing'],
  )
  expect(vi.mocked(callNativeBridge).mock.calls[0][0].requestId).toBe(
    `${body.missionId}:${body.assignments[0].id}`,
  )
  expect(JSON.parse(stored()).missions[0].assignments[0].id).toBe(
    body.assignments[0].id,
  )
})

async function reviewed(
  verdict = 'changes_required',
  reviewOverride: Record<string, unknown> = {},
) {
  vi.mocked(callNativeBridge).mockResolvedValueOnce(observation())
  const first = await api([initial()])
  expect(first.status).toBe(200)
  const body = await first.json()
  const target = body.assignments[0]
  const { refreshNativeMission } = await import('../../server/swarm-native')
  vi.mocked(callNativeBridge).mockResolvedValueOnce(
    observation('argus-developer', SID, 'synthetic-v1', true),
  )
  await refreshNativeMission(body.missionId)
  const reviewerSID = 'local-reviewer-synthetic-0002'
  vi.mocked(callNativeBridge).mockResolvedValueOnce(
    observation('argus-reviewer', reviewerSID, 'synthetic-review'),
  )
  const response = await api(
    [
      {
        workerId: 'argus-reviewer',
        task: 'Synthetic exact review',
        dependsOn: [target.id],
        existingSessionId: reviewerSID,
      },
    ],
    body.missionId,
  )
  expect(response.status).toBe(200)
  const review = (await response.json()).assignments[1]
  vi.mocked(callNativeBridge).mockResolvedValueOnce(
    observation('argus-reviewer', reviewerSID, 'synthetic-review', true, {
      artifact: {
        revision: 'c'.repeat(40),
        sha256: 'd'.repeat(64),
        path: 'synthetic/review.md',
      },
      review: {
        assignmentId: target.id,
        revision: artifact.revision,
        sha256: artifact.sha256,
        verdict,
        ...reviewOverride,
      },
    }),
  )
  await refreshNativeMission(body.missionId)
  vi.mocked(callNativeBridge).mockClear()
  return { missionId: body.missionId, target, review }
}
it('dispatches changes_required correction with exact producer+different-reviewer dependencies; never silently queues', async () => {
  const { missionId, target, review } = await reviewed()
  vi.mocked(callNativeBridge).mockResolvedValueOnce(
    observation('argus-developer', SID, 'synthetic-v2'),
  )
  const response = await api(
    [
      {
        ...initial(),
        task: 'Synthetic corrected v2',
        producerIntent: 'correction',
        dependsOn: [target.id, review.id],
      },
    ],
    missionId,
  )
  expect(response.status).toBe(200)
  const result = await response.json()
  expect(result.results).toHaveLength(1)
  expect(result.assignments[0]).toMatchObject({
    state: 'checkpointed',
    native: { artifact },
  })
  expect(result.assignments[1]).toMatchObject({
    state: 'done',
    native: {
      review: {
        assignmentId: target.id,
        verdict: 'changes_required',
        revision: artifact.revision,
        sha256: artifact.sha256,
      },
    },
  })
  expect(result.assignments[2]).toMatchObject({
    producerIntent: 'correction',
    sessionBinding: { sessionId: SID },
    native: { admissionId: 'synthetic-v2' },
  })
  expect(vi.mocked(callNativeBridge).mock.calls.map(([r]) => r.action)).toEqual(
    ['submit_existing'],
  )
})

it('explicit accepted continuation reopens only its exact native mission and dispatches in the same selected session', async () => {
  const { missionId, target } = await reviewed('accepted')
  vi.mocked(callNativeBridge).mockResolvedValueOnce(
    observation('argus-developer', SID, 'synthetic-continuation'),
  )
  const response = await api(
    [
      {
        ...initial(),
        task: 'Synthetic accepted continuation',
        producerIntent: 'continuation',
        dependsOn: [target.id],
      },
    ],
    missionId,
  )
  expect(response.status).toBe(200)
  const result = await response.json()
  expect(result.results).toHaveLength(1)
  expect(result.assignments.at(-1).native.admissionId).toBe(
    'synthetic-continuation',
  )
  expect(vi.mocked(callNativeBridge).mock.calls.map(([r]) => r.action)).toEqual(
    ['submit_existing'],
  )
})
it.each(['missing review', 'wrong verdict', 'foreign digest'])(
  'refuses %s correction at creation, with no silent stored queue',
  async (kind) => {
    const { missionId, target, review } = await reviewed(
      kind === 'wrong verdict' ? 'not_a_verdict' : 'changes_required',
      kind === 'foreign digest' ? { sha256: 'e'.repeat(64) } : {},
    )
    const before = stored()
    const dependsOn =
      kind === 'missing review' ? [target.id] : [target.id, review.id]
    const response = await api(
      [
        {
          ...initial(),
          task: 'Invalid correction',
          producerIntent: 'correction',
          dependsOn,
        },
      ],
      missionId,
    )
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    expect(stored()).toBe(before)
    expect(callNativeBridge).not.toHaveBeenCalled()
  },
)
it.each(['no login', 'no password', 'wrong origin', 'opt out'])(
  'refuses initial %s before store/admission',
  async (kind) => {
    if (kind === 'no login') vi.mocked(isAuthenticated).mockReturnValue(false)
    if (kind === 'no password')
      vi.mocked(isPasswordProtectionEnabled).mockReturnValue(false)
    if (kind === 'opt out')
      vi.stubEnv('ARGUS_WORKSPACE_GPU_SOURCE_ENABLED', '0')
    const response = await api(
      [initial()],
      undefined,
      kind === 'wrong origin' ? 'http://foreign.invalid' : ORIGIN,
    )
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    expect(callNativeBridge).not.toHaveBeenCalled()
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(root, '.runtime/swarm-missions.json'))).toBe(false)
  },
)
it.each(['foreign profile', 'foreign session', 'missing fence'])(
  'keeps initial %s receipt UNKNOWN; no imported admission acceptance',
  async (kind) => {
    const receipt = observation()
    if (kind === 'foreign profile')
      receipt.receipt.ref.profile_id = join(
        root,
        '.hermes/profiles/argus-reviewer',
      )
    if (kind === 'foreign session')
      receipt.receipt.ref.session_id = 'local-foreign-synthetic-0003'
    if (kind === 'missing fence') receipt.preflight.atomicIdleFence = false
    vi.mocked(callNativeBridge).mockResolvedValueOnce(receipt)
    const response = await api([initial()])
    expect(response.status).toBe(200)
    const assignment = (await response.json()).assignments[0]
    expect(assignment).toMatchObject({
      state: 'needs_input',
      native: { status: 'unknown', admissionId: null },
    })
    expect(
      vi.mocked(callNativeBridge).mock.calls.map(([r]) => r.action),
    ).toEqual(['submit_existing'])
  },
)
it('lost ACK stays sticky across refresh/restart; retry has a typed refusal with ZERO resubmit/new key', async () => {
  vi.mocked(callNativeBridge).mockRejectedValueOnce(
    new Error('synthetic ACK lost'),
  )
  const response = await api([initial()])
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.assignments[0]).toMatchObject({
    state: 'needs_input',
    native: {
      status: 'unknown',
      admissionId: null,
      requestId: `${body.missionId}:${body.assignments[0].id}`,
    },
  })
  // C2: the exact owner binding was persisted BEFORE the submit whose ACK was lost.
  expect(body.assignments[0].native.inputBinding.input_id).toBe(
    body.assignments[0].native.requestId,
  )
  const before = stored()
  vi.mocked(callNativeBridge).mockClear()
  const { refreshNativeMission } = await import('../../server/swarm-native')
  await refreshNativeMission(body.missionId)
  // Refresh asks only the read-only lookup; 'unavailable' proves nothing and changes nothing.
  expect(vi.mocked(lookupNativeInput).mock.calls.map(([r]) => r.requestId)).toEqual(
    [body.assignments[0].native.requestId],
  )
  expect(stored()).toBe(before)
  expect(callNativeBridge).not.toHaveBeenCalled()
  vi.resetModules()
  const retry = await api([initial()], body.missionId)
  expect(retry.status).toBe(409)
  expect((await retry.json()).error).toBe(
    'native_reconciliation_required; awaiting exact original-input lookup',
  )
  expect(stored()).toBe(before)
  expect(callNativeBridge).not.toHaveBeenCalled()
  const other = await api([{ ...initial(), task: 'Other mission' }])
  expect(other.status).toBe(409)
  expect(stored()).toBe(before)
  expect(callNativeBridge).not.toHaveBeenCalled()
})

it('requires a genuine WeakSet grant even for initial producer direct helper calls', async () => {
  const { dispatchNativeAssignments } =
    await import('../../server/swarm-native')
  const forged = Object.freeze({ sessionIds: Object.freeze([SID]) })
  for (const grant of [undefined, forged])
    await expect(
      dispatchNativeAssignments({ assignments: [initial()] }, grant),
    ).rejects.toThrow('existing_session_authorization_required')
  expect(callNativeBridge).not.toHaveBeenCalled()
  const { existsSync } = await import('node:fs')
  expect(existsSync(join(root, '.runtime/swarm-missions.json'))).toBe(false)
})
it('rejects changed producer dependencies without mutating the stored contract', async () => {
  const { missionId, target, review } = await reviewed()
  const before = stored()
  // Same producer task and identity, but a different dependency contract: not a new admission.
  const response = await api(
    [{ ...initial(), dependsOn: [target.id, review.id] }],
    missionId,
  )
  expect(response.status).toBe(409)
  expect((await response.json()).error).toBe('producer_dependencies_immutable')
  expect(stored()).toBe(before)
  expect(callNativeBridge).not.toHaveBeenCalled()
})
it('ignores conflicting terminal artifact evidence without overwriting a frozen binding', async () => {
  const { missionId, target } = await reviewed()
  const before = stored()
  const { recordNativeObservation } =
    await import('../../server/swarm-missions')
  recordNativeObservation(
    missionId,
    target.id,
    observation('argus-developer', SID, 'synthetic-v1', true, {
      artifact: { ...artifact, sha256: 'e'.repeat(64) },
    }),
  )
  expect(stored()).toBe(before)
  expect(callNativeBridge).not.toHaveBeenCalled()
})
it('a concurrent profile reservation yields a typed refusal and only ONE bridge admission', async () => {
  let entered!: () => void
  const reached = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: (value: ReturnType<typeof observation>) => void
  vi.mocked(callNativeBridge).mockImplementationOnce(() => {
    entered()
    return new Promise((resolve) => {
      release = resolve
    })
  })
  const first = api([initial()])
  await reached
  const second = await api([{ ...initial(), task: 'Concurrent other mission' }])
  expect(second.status).toBe(409)
  expect(vi.mocked(callNativeBridge).mock.calls).toHaveLength(1)
  release(observation())
  expect((await first).status).toBe(200)
  expect(JSON.parse(stored()).missions).toHaveLength(1)
})
