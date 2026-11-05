import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** C2: `prompt.prepare_input` result (Native original-input-lookup-v1), persisted BEFORE the submit. */
export type NativeInputBinding = {
  version: 'original-input-lookup-v1'
  ref: { profile_id: string; session_id: string }
  input_id: string
  principal_binding: string
  payload_fingerprint: string
  idle_fence: { expected_generation: number } | null
}

/** C2: `prompt.lookup_input` envelope. Only `found`+`exact` with matching proof is positive evidence. */
export type NativeInputLookup = {
  version: string
  state: 'found' | 'not_found' | 'unavailable'
  reason: string | null
  ref: { profile_id: string; session_id: string }
  input_id: string
  principal_binding: string
  binding: 'exact' | 'mismatch' | null
  admission: { admission_id: string; sequence: number; status: string; outcome: string | null; authority_epoch: number; execution_generation: number | null } | null
  proof: { payload_fingerprint: string; idle_fence: { expected_generation: number } | null } | null
  settled: boolean
}

export type NativeObservation = {
  connected?: boolean
  status?: string
  sessions?: Array<{ sessionId: string; source: string; title: string; status: string; model?: string; provider?: string; reasoningEffort?: string; sessionCwd?: string }>
  error?: string
  notAdmitted?: boolean
  profileId?: string
  sessionId?: string
  model?: string
  provider?: string
  reasoningEffort?: string
  sessionCwd?: string
  lastSequence?: number
  replayEpoch?: string
  receipt?: {
    admission_id: string
    ref: { profile_id: string; session_id: string }
    status: string
    outcome: string | null
    execution_generation?: number | null
    authority_epoch?: number
  }
  finalText?: string
  awaitingHuman?: boolean
  /**
   * B2 existing-session submit only. `idleVerified`: the metadata-only attach observed the exact
   * session idle at `executionGeneration`. `atomicIdleFence`: the owner then ACCEPTED the
   * `idle-admission-v1` fenced submit, i.e. re-checked that generation with nothing queued,
   * started or unknown inside the admission's own write transaction.
   */
  preflight?: { source: string; executionGeneration: number; idleVerified: boolean; atomicIdleFence: boolean; capability: string }
  inputBinding?: NativeInputBinding
  lookup?: NativeInputLookup
}

export type NativeBridgeRequest = {
  action: 'submit' | 'submit_existing' | 'prepare_existing' | 'lookup' | 'inspect' | 'status'
  workerId: string
  profileHome: string
  cwd: string
  requestId: string
  title: string
  text?: string
  sessionId?: string | null
  admissionId?: string | null
  lastSequence?: number
  replayEpoch?: string
  /** C2: the persisted exact binding (`submit_existing` re-verifies it; `lookup` reads it). */
  inputBinding?: NativeInputBinding | null
}

/** One bounded attach-only operation. Neither the shell nor the Hermes CLI is invoked. */
export function callNativeBridge(request: NativeBridgeRequest): Promise<NativeObservation> {
  const agentRoot = process.env.HERMES_AGENT_PATH || join(homedir(), '.hermes/hermes-agent')
  const python = process.env.HERMES_NATIVE_PYTHON || 'python3'
  const packagedScript = join(process.cwd(), 'dist/server/assets/swarm-native-bridge.py')
  const script = existsSync(packagedScript) ? packagedScript : join(process.cwd(), 'src/server/swarm-native-bridge.py')
  const notAdmitted = (error: string): NativeObservation => ({ profileId: request.profileHome, error, notAdmitted: ['submit', 'submit_existing', 'prepare_existing'].includes(request.action) })
  if ((python.includes('/') && !existsSync(python)) || !existsSync(script)) return Promise.resolve(notAdmitted('native_bridge_unavailable'))
  const env = { ...process.env, HERMES_HOME: request.profileHome, HERMES_PROFILE: request.workerId, PYTHONDONTWRITEBYTECODE: '1' }
  // Do not leak a parent managed run's identity/approval mode into an ordinary GUI session.
  for (const key of Object.keys(env)) {
    if (key.startsWith('HERMES_KANBAN_') || ['HERMES_YOLO', 'HERMES_AUTO_APPROVE', 'HERMES_ACCEPT_HOOKS', 'HERMES_TUI_GATEWAY_URL'].includes(key)) delete (env as NodeJS.ProcessEnv)[key]
  }
  return new Promise((resolve, reject) => {
    const child = execFile(python, ['-B', script, agentRoot], { env, timeout: 30_000, maxBuffer: 512_000 }, (error, stdout) => {
      // Never return raw stderr: installed modules may include private settings in errors.
      if (error) {
        if (['ENOENT', 'EACCES', 'ENOTDIR'].includes(String(error.code))) resolve(notAdmitted('native_bridge_spawn_unavailable'))
        else reject(new Error('native_transport_unknown; inspect existing request, do not resend'))
        return
      }
      try { resolve(JSON.parse(stdout) as NativeObservation) } catch { reject(new Error('native_response_unknown; do not resend')) }
    })
    child.stdin?.end(JSON.stringify(request))
  })
}

/** C2: pure owner preparation of the exact existing-session submit (never submits or creates a session). */
export function prepareNativeInput(request: Omit<NativeBridgeRequest, 'action'>): Promise<NativeObservation> {
  return callNativeBridge({ ...request, action: 'prepare_existing' })
}

/** C2: read-only exact original-input lookup (no attach, list, create, submit, replay or resolve). */
export function lookupNativeInput(request: Omit<NativeBridgeRequest, 'action'>): Promise<NativeObservation> {
  return callNativeBridge({ ...request, action: 'lookup' })
}
