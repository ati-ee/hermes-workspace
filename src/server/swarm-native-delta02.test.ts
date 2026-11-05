import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({ error: null as null | (Error & { code?: string; killed?: boolean }), calls: vi.fn(), output: '' }))
vi.mock('node:child_process', () => ({ execFile: (...args: Array<unknown>) => { transport.calls(...args); const callback = args.at(-1); if (typeof callback === 'function') callback(transport.error, transport.output, 'synthetic stderr not exposed'); return { stdin: { end: vi.fn() } } } }))
vi.mock('./gateway-capabilities', () => ({ ensureGatewayProbed: vi.fn(), dashboardFetch: vi.fn(), BEARER_TOKEN: '', CLAUDE_API: 'http://synthetic.invalid' }))
vi.mock('./kanban-dashboard-proxy', () => ({ fetchDashboardKanbanTask: vi.fn() }))

let root: string
beforeEach(() => {
  vi.clearAllMocks(); vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'native-delta02-'))
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  vi.stubEnv('HERMES_HOME', join(root, '.hermes'))
  vi.stubEnv('HERMES_NATIVE_PYTHON', 'python3')
  mkdirSync(join(root, '.hermes/profiles/orchestrator-argus'), { recursive: true })
  writeFileSync(join(root, '.hermes/profiles/orchestrator-argus/config.yaml'), 'model: saved-synthetic\nterminal:\n  cwd: /synthetic-configured-workspace\n')
  writeFileSync(join(root, 'swarm.yaml'), 'workers:\n- id: orchestrator-argus\n  profile: orchestrator-argus\n')
  mkdirSync(join(root, 'src/server'), { recursive: true })
  writeFileSync(join(root, 'src/server/swarm-native-bridge.py'), '# synthetic transport fixture; never executed\n')
  transport.error = null
  transport.output = ''
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network prohibited') }))
})
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }) })

function queued() {
  const profile = join(root, '.hermes/profiles/orchestrator-argus')
  return { profileId: profile, sessionId: 'synthetic-session', receipt: { ref: { profile_id: profile, session_id: 'synthetic-session' }, admission_id: 'synthetic-admission', status: 'queued', outcome: null } }
}

it('guards direct legacy runtime projection writes to a native profile', async () => {
  const { patchSwarmRuntimeFile } = await import('./swarm-foundation')
  const home = join(root, '.hermes/profiles/orchestrator-argus')
  expect(() => patchSwarmRuntimeFile(home, 'orchestrator-argus', { state: 'idle' })).toThrow('native_control_required')
})

it('classifies missing absolute Python as proven not admitted, without a spawn', async () => {
  vi.stubEnv('HERMES_NATIVE_PYTHON', join(root, 'missing-python'))
  const { callNativeBridge } = await import('./swarm-native-bridge')
  await expect(callNativeBridge({ action: 'submit', workerId: 'orchestrator-argus', profileHome: join(root, '.hermes/profiles/orchestrator-argus'), cwd: root, requestId: 'synthetic', title: 'synthetic' })).resolves.toMatchObject({ notAdmitted: true })
  expect(transport.calls).not.toHaveBeenCalled()
})

it('does not permanently reserve a profile after spawn ENOENT; a new explicit task still admits natively', async () => {
  transport.error = Object.assign(new Error('synthetic missing executable'), { code: 'ENOENT' })
  const { dispatchNativeAssignments } = await import('./swarm-native')
  const before = readFileSync(join(root, '.hermes/profiles/orchestrator-argus/config.yaml'))
  const failed = await dispatchNativeAssignments({ assignments: [{ workerId: 'orchestrator-argus', task: 'Synthetic first task' }] })
  expect(failed.assignments[0].native?.status).toBe('not_admitted')
  expect(transport.calls).toHaveBeenCalledTimes(1)
  transport.error = null; transport.output = JSON.stringify(queued())
  const admitted = await dispatchNativeAssignments({ assignments: [{ workerId: 'orchestrator-argus', task: 'Synthetic explicit new task' }] })
  expect(admitted.assignments[0].native?.admissionId).toBe('synthetic-admission')
  expect(admitted.assignments[0].workerId).toBe('orchestrator-argus')
  expect(readFileSync(join(root, '.hermes/profiles/orchestrator-argus/config.yaml'))).toEqual(before)
  expect(transport.calls).toHaveBeenCalledTimes(2)
})

it('keeps timeout ambiguous and fenced, ignoring caller-provided release/non-admission flags', async () => {
  transport.error = Object.assign(new Error('synthetic timed out'), { code: 'ETIMEDOUT', killed: true })
  const { dispatchNativeAssignments } = await import('./swarm-native')
  const failed = await dispatchNativeAssignments({ assignments: [{ workerId: 'orchestrator-argus', task: 'Synthetic unknown outcome' }] })
  expect(failed.assignments[0].native?.status).toBe('unknown')
  const payload = { notAdmitted: true, release: true, assignments: [{ workerId: 'orchestrator-argus', task: 'Forbidden replay' }] }
  await expect(dispatchNativeAssignments(payload)).rejects.toThrow('profile_reserved')
  expect(transport.calls).toHaveBeenCalledTimes(1)
})

it.each([false, true])('requires actual exact artifact fields, not completion labels (artifact=%s)', async (withArtifact) => {
  const receipt = queued()
  transport.output = JSON.stringify({ ...receipt, receipt: { ...receipt.receipt, status: 'terminal', outcome: 'completed' }, finalText: `STATE: DONE\nFILES_CHANGED: synthetic\nCOMMANDS_RUN: synthetic\nRESULT: delivered\nBLOCKER: none\nNEXT_ACTION: review${withArtifact ? `\nSWARM_DELIVERY: ${JSON.stringify({ artifact: { revision: 'a'.repeat(40), sha256: 'b'.repeat(64), path: 'synthetic/frozen.patch' } })}` : ''}` })
  const { dispatchNativeAssignments } = await import('./swarm-native')
  const result = await dispatchNativeAssignments({ assignments: [{ workerId: 'orchestrator-argus', task: 'Synthetic artifact gate' }] })
  expect(result.assignments[0].state).toBe(withArtifact ? 'checkpointed' : 'needs_input')
  expect(result.mission.state).not.toBe('complete')
  expect(result.assignments[0].reviewedAt).toBeFalsy()
})
