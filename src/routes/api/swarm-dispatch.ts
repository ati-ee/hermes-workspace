import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isAuthenticated } from '../../server/auth-middleware'
import { newestCheckpointFromMessages, parseSwarmCheckpoint, type ParsedSwarmCheckpoint } from '../../server/swarm-checkpoints'
import { readWorkerMessages } from '../../server/swarm-chat-reader'
import { createOrUpdateMission, getSwarmMission, markMissionAssignmentDispatched, recordMissionAssignmentBlocked, recordMissionCheckpoint } from '../../server/swarm-missions'
import { appendSwarmMemoryEvent, buildSwarmStartupSnapshot } from '../../server/swarm-memory'
import { rosterByWorkerId, type SwarmRosterWorker } from '../../server/swarm-roster'
import { publishSwarmCheckpointNotification } from '../../server/swarm-notifications'
import { SwarmDispatchError, dispatchNativeAssignments } from '../../server/swarm-native'
import { authorizeExistingSessions, selectedExistingSessionIds, type ExistingSessionAuthority } from '../../server/swarm-existing-session-auth'
import { requireJsonContentType } from '../../server/rate-limit'

type AssignmentRequest = {
  workerId: string
  task: string
  rationale?: string
  assignmentId?: string
  dependsOn?: Array<string>
  reviewRequired?: boolean
  direct?: boolean
}

type DispatchRequest = {
  origin?: unknown
  workerIds?: unknown
  prompt?: unknown
  assignments?: unknown
  timeoutSeconds?: unknown
  waitForCheckpoint?: unknown
  allowAsync?: unknown
  checkpointPollSeconds?: unknown
  missionId?: unknown
  missionTitle?: unknown
  direct?: unknown
  notifySessionKey?: unknown
}

type WorkerResult = {
  workerId: string
  ok: boolean
  output: string
  error: string | null
  durationMs: number
  exitCode: number | null
  delivery?: 'tmux' | 'oneshot'
  checkpoint?: ParsedSwarmCheckpoint | null
  checkpointStatus?: 'checkpointed' | 'timeout' | 'not-requested'
}

type RuntimeCheckpointSnapshot = {
  checkpointStatus: 'none' | 'in_progress' | 'done' | 'blocked' | 'handoff' | 'needs_input'
  state: string | null
  lastSummary: string | null
  lastResult: string | null
  nextAction: string | null
  blockedReason: string | null
  lastCheckIn: string | null
  lastOutputAt: number | null
  checkpointRaw: string | null
}

const MAX_PROMPT_CHARS = 32_000
const MAX_OUTPUT_CHARS = 200_000
const DEFAULT_TIMEOUT_S = 240
const MAX_TIMEOUT_S = 600

function getProfilesDir(): string {
  const base = process.env.HERMES_HOME ?? process.env.CLAUDE_HOME
  if (base) {
    const parts = base.split('/').filter(Boolean)
    if (parts.length >= 2 && parts.at(-2) === 'profiles') {
      return base.split('/').slice(0, -1).join('/')
    }
    return join(base, 'profiles')
  }
  return join(homedir(), '.hermes', 'profiles')
}

function getWrapperPath(workerId: string): string {
  const worker = rosterByWorkerId([workerId]).get(workerId)
  const wrapperName = worker?.wrapper?.trim() || workerId
  return join(homedir(), '.local', 'bin', wrapperName)
}

function getProfilePath(workerId: string): string {
  return join(getProfilesDir(), workerId)
}

function validateWorkerId(workerId: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(workerId)
}

const TMUX_BIN_CANDIDATES = [
  process.env.TMUX_BIN,
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  '/usr/bin/tmux',
  join(homedir(), '.local', 'bin', 'tmux'),
  'tmux',
].filter((value): value is string => Boolean(value))

function resolveTmuxBin(): string | null {
  // Allow operators on non-standard installs (Docker, NixOS, custom
  // package layouts) to point Swarm at the right tmux binary without
  // patching this list. See #244.
  const override = process.env.HERMES_TMUX_BIN || process.env.CLAUDE_TMUX_BIN
  if (override) {
    if (existsSync(override)) return override
    // If the override looks like a bare command (no slashes), trust it
    // and let execFile resolve it via PATH.
    if (!override.includes('/')) return override
  }
  for (const candidate of TMUX_BIN_CANDIDATES) {
    if (candidate.includes('/')) {
      if (
        candidate === process.env.TMUX_BIN ||
        candidate === '/opt/homebrew/bin/tmux' ||
        candidate === '/usr/local/bin/tmux' ||
        existsSync(candidate)
      ) {
        return candidate
      }
      continue
    }
    return candidate
  }
  return null
}

function tmuxHasSession(tmuxBin: string, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(tmuxBin, ['has-session', '-t', name], (error) => {
      resolve(!error)
    })
  })
}

function execFileAsync(
  cmd: string,
  args: Array<string>,
  timeout = 8_000,
  input?: string,
): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: MAX_OUTPUT_CHARS }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, error: stderr?.toString().trim() || error.message })
        return
      }
      resolve({
        ok: true,
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
      })
    })
    if (input !== undefined) {
      child.stdin?.end(input)
    }
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sessionNameFor(workerId: string): string {
  return `swarm-${workerId}`
}

function shellEscapeSingle(value: string): string {
  return value.replace(/'/g, `'\\''`)
}

export function buildHermesTmuxLaunchCommand(input: {
  profilePath: string
  hermesBin: string
  ghToken?: string | null
}): string {
  const launchPrefix = [
    `HERMES_HOME='${shellEscapeSingle(input.profilePath)}'`,
    `HERMES_CLI_BIN='${shellEscapeSingle(input.hermesBin)}'`,
    input.ghToken ? `GH_TOKEN='${shellEscapeSingle(input.ghToken)}'` : '',
    input.ghToken ? `GITHUB_TOKEN='${shellEscapeSingle(input.ghToken)}'` : '',
  ].filter(Boolean).join(' ')
  const hermesBin = shellEscapeSingle(input.hermesBin)

  // Do not exec the Hermes process. Keeping the parent shell alive means a
  // failed worker startup leaves a readable tmux pane instead of destroying the
  // session and turning the real error into "can't find pane".
  return `${launchPrefix} '${hermesBin}' chat --tui; status=$?; printf '\n[Hermes worker exited with status %s]\n' "$status"`
}

function parseAssignments(value: unknown): Array<AssignmentRequest> {
  if (!Array.isArray(value)) return []
  const assignments: Array<AssignmentRequest> = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    const workerId = typeof obj.workerId === 'string' ? obj.workerId.trim() : ''
    const task = typeof obj.task === 'string' ? obj.task.trim() : ''
    const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim() : undefined
    const dependsOn = Array.isArray(obj.dependsOn) ? obj.dependsOn.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : undefined
    const reviewRequired = typeof obj.reviewRequired === 'boolean' ? obj.reviewRequired : undefined
    const direct = typeof obj.direct === 'boolean' ? obj.direct : undefined
    if (!workerId || !task || !validateWorkerId(workerId)) continue
    assignments.push({ workerId, task, rationale, dependsOn, reviewRequired, direct })
  }
  return assignments
}

function readRuntimeJson(profilePath: string): Record<string, unknown> {
  const runtimePath = join(profilePath, 'runtime.json')
  if (!existsSync(runtimePath)) return {}
  try {
    return JSON.parse(readFileSync(runtimePath, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeRuntimePatch(workerId: string, patch: Record<string, unknown>): void {
  const profilePath = getProfilePath(workerId)
  mkdirSync(profilePath, { recursive: true })
  const runtimePath = join(profilePath, 'runtime.json')
  const current = readRuntimeJson(profilePath)
  const next = {
    ...current,
    workerId,
    ...patch,
  }
  writeFileSync(runtimePath, JSON.stringify(next, null, 2) + '\n')
}

function cleanRuntimeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function cleanRuntimeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function cleanRuntimeCheckpointStatus(value: unknown): RuntimeCheckpointSnapshot['checkpointStatus'] {
  return value === 'in_progress' || value === 'done' || value === 'blocked' || value === 'handoff' || value === 'needs_input'
    ? value
    : 'none'
}

export function readRuntimeCheckpointSnapshot(profilePath: string): RuntimeCheckpointSnapshot {
  const raw = readRuntimeJson(profilePath)
  return {
    checkpointStatus: cleanRuntimeCheckpointStatus(raw.checkpointStatus),
    state: cleanRuntimeText(raw.state),
    lastSummary: cleanRuntimeText(raw.lastSummary),
    lastResult: cleanRuntimeText(raw.lastResult),
    nextAction: cleanRuntimeText(raw.nextAction),
    blockedReason: cleanRuntimeText(raw.blockedReason),
    lastCheckIn: cleanRuntimeText(raw.lastCheckIn),
    lastOutputAt: cleanRuntimeNumber(raw.lastOutputAt),
    checkpointRaw: cleanRuntimeText(raw.checkpointRaw),
  }
}

export function runtimeCheckpointSignature(snapshot: RuntimeCheckpointSnapshot): string {
  return JSON.stringify(snapshot)
}

function isoToMs(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function stateLabelForRuntimeSnapshot(snapshot: RuntimeCheckpointSnapshot): ParsedSwarmCheckpoint['stateLabel'] | null {
  switch (snapshot.checkpointStatus) {
    case 'done':
      return 'DONE'
    case 'blocked':
      return 'BLOCKED'
    case 'needs_input':
      return 'NEEDS_INPUT'
    case 'handoff':
      return 'HANDOFF'
    case 'in_progress':
      return 'IN_PROGRESS'
    default:
      break
  }
  const state = snapshot.state?.toLowerCase()
  if (state === 'blocked') return 'BLOCKED'
  if (state === 'waiting') return 'NEEDS_INPUT'
  if (state === 'executing' || state === 'thinking' || state === 'writing' || state === 'reviewing' || state === 'syncing') return 'IN_PROGRESS'
  if (state === 'idle') return 'DONE'
  return null
}

function runtimeSnapshotHasMeaningfulCheckpoint(snapshot: RuntimeCheckpointSnapshot): boolean {
  return Boolean(
    snapshot.checkpointRaw ||
    snapshot.lastSummary ||
    snapshot.lastResult ||
    snapshot.nextAction ||
    snapshot.blockedReason,
  )
}

export function runtimeSnapshotIsFresh(snapshot: RuntimeCheckpointSnapshot, baselineSignature: string, dispatchedAt: number): boolean {
  const changed = runtimeCheckpointSignature(snapshot) !== baselineSignature
  if (!changed) return false
  const outputAt = snapshot.lastOutputAt
  const checkInAt = isoToMs(snapshot.lastCheckIn)
  return Boolean(
    (typeof outputAt === 'number' && outputAt >= dispatchedAt) ||
    (typeof checkInAt === 'number' && checkInAt >= dispatchedAt),
  )
}

function formatRuntimeCheckpointRaw(checkpoint: ParsedSwarmCheckpoint): string {
  return [
    `STATE: ${checkpoint.stateLabel}`,
    `FILES_CHANGED: ${checkpoint.filesChanged ?? 'none'}`,
    `COMMANDS_RUN: ${checkpoint.commandsRun ?? 'none'}`,
    `RESULT: ${checkpoint.result ?? 'none'}`,
    `BLOCKER: ${checkpoint.blocker ?? 'none'}`,
    `NEXT_ACTION: ${checkpoint.nextAction ?? 'none'}`,
  ].join('\n')
}

export function checkpointFromRuntimeSnapshot(snapshot: RuntimeCheckpointSnapshot): ParsedSwarmCheckpoint | null {
  if (snapshot.checkpointRaw) {
    const parsed = newestCheckpointFromMessages([{ role: 'assistant', content: snapshot.checkpointRaw }])
    if (parsed) return parsed
  }
  const stateLabel = stateLabelForRuntimeSnapshot(snapshot)
  if (!stateLabel || !runtimeSnapshotHasMeaningfulCheckpoint(snapshot)) return null
  const result = snapshot.lastResult ?? snapshot.lastSummary
  const blocker = snapshot.blockedReason
  const checkpoint: ParsedSwarmCheckpoint = {
    stateLabel,
    runtimeState:
      stateLabel === 'DONE' || stateLabel === 'HANDOFF'
        ? 'idle'
        : stateLabel === 'BLOCKED'
          ? 'blocked'
          : stateLabel === 'NEEDS_INPUT'
            ? 'waiting'
            : 'executing',
    checkpointStatus:
      stateLabel === 'DONE'
        ? 'done'
        : stateLabel === 'BLOCKED'
          ? 'blocked'
          : stateLabel === 'NEEDS_INPUT'
            ? 'needs_input'
            : stateLabel === 'HANDOFF'
              ? 'handoff'
              : 'in_progress',
    filesChanged: null,
    commandsRun: null,
    result,
    blocker,
    nextAction: snapshot.nextAction,
    raw: '',
  }
  checkpoint.raw = formatRuntimeCheckpointRaw(checkpoint)
  return checkpoint
}

export function buildWorkerPrompt(input: {
  workerId: string
  task: string
  rationale?: string
  roster?: SwarmRosterWorker
  direct?: boolean
  raw?: boolean
  missionId?: string | null
  taskTitle?: string | null
}): string {
  if (input.direct && input.raw) return input.task
  const roster = input.roster
  const displayName = roster?.name?.trim() || input.workerId
  const role = roster?.role || 'Worker'
  const humanLabel = `${displayName} — ${role}`
  const skills = roster?.skills?.length ? roster.skills.join(', ') : 'swarm-worker-core'
  const capabilities = roster?.capabilities?.length ? roster.capabilities.join(', ') : 'not declared'
  const mission = roster?.mission || 'Execute assigned swarm tasks and checkpoint progress.'
  const specialty = roster?.specialty || 'General execution'

  let snapshotSection = ''
  try {
    const snapshot = buildSwarmStartupSnapshot({
      workerId: input.workerId,
      role,
      specialty,
      rosterMission: mission,
      taskTitle: input.taskTitle ?? null,
      missionId: input.missionId ?? null,
    })
    snapshotSection = snapshot.rendered
  } catch {
    snapshotSection = ''
  }

  const lines: Array<string> = [
    '## Swarm Orchestrator Dispatch',
    `Worker: ${humanLabel}`,
    `Machine ID: ${input.workerId}`,
    `Specialty: ${specialty}`,
    `Mission: ${mission}`,
    `Skills: ${skills}`,
    `Capabilities: ${capabilities}`,
    input.rationale ? `Routing rationale: ${input.rationale}` : '',
    '',
  ]
  if (snapshotSection) {
    lines.push(snapshotSection)
    lines.push('')
  }
  lines.push(
    '## Assigned Task',
    input.task,
    '',
    '## Operating Rules',
    '- Work in your persistent Hermes worker session and preserve your profile context.',
    `- The Worker Startup Memory Snapshot above is your authoritative starting context. If you have filesystem tools, also read \`~/.\u0068\u0065\u0072\u006d\u0065\u0073/profiles/${input.workerId}/MEMORY.md\`, \`SOUL.md\`, \`USER.md\`, and \`memory/IDENTITY.md\` for full detail.`,
    `- Search your own memory before starting if relevant: GET /api/swarm-memory/search?workerId=${input.workerId}&q=<term>.`,
    '- Do not blame a generic sandbox for missing access. Assume repo/filesystem/network are available unless a command proves otherwise. If auth or tools fail, report the exact failing command and exact missing token/tool/env.',
    '- Produce concrete artifacts or a concrete checkpoint; avoid vague status updates.',
    '- If you are blocked, say exactly what is missing and the smallest unblock action.',
    '- If this is part of a larger workflow, stop after your checkpoint and wait for orchestrator continuation.',
    '- If context pressure is high, write a structured handoff to your handoffs/ directory before /new and continue from it on resume.',
    '',
    '## Required Checkpoint Format',
    'STATE: DONE | BLOCKED | NEEDS_INPUT | HANDOFF | IN_PROGRESS',
    'FILES_CHANGED: exact paths or none',
    'COMMANDS_RUN: exact commands or none',
    'RESULT: concrete result/proof',
    'BLOCKER: blocker or none',
    'NEXT_ACTION: exact recommended next action',
  )
  return lines.filter(Boolean).join('\n')
}

function markDispatchStarted(workerId: string, task: string, missionId?: string | null, assignmentId?: string | null, notifySessionKey?: string | null): void {
  const controlMessage = `Dispatched task: ${task.slice(0, 180)}`
  writeRuntimePatch(workerId, {
    state: 'executing',
    phase: 'dispatched',
    currentTask: task,
    currentMissionId: missionId ?? null,
    currentAssignmentId: assignmentId ?? null,
    checkpointStatus: 'in_progress',
    needsHuman: false,
    blockedReason: null,
    lastDispatchAt: Date.now(),
    lastDispatchMode: 'tmux',
    lastDispatchResult: 'Dispatch queued',
    lastCheckIn: new Date().toISOString(),
    lastSummary: controlMessage,
    lastControlMessage: controlMessage,
    nextAction: 'Worker should execute and return the required checkpoint format.',
    notifySessionKey: notifySessionKey ?? 'main',
  })
}

function markDispatchResult(workerId: string, result: WorkerResult): void {
  writeRuntimePatch(workerId, {
    lastDispatchAt: Date.now(),
    lastDispatchMode: result.delivery ?? 'none',
    lastDispatchResult: result.ok ? result.output.slice(0, 500) : (result.error ?? 'dispatch failed').slice(0, 500),
    state: result.ok ? 'executing' : 'blocked',
    checkpointStatus: result.ok ? 'in_progress' : 'blocked',
    blockedReason: result.ok ? null : result.error,
    lastCheckIn: new Date().toISOString(),
  })
}

export function dispatchBlockReason(result: Pick<WorkerResult, 'ok' | 'error' | 'output' | 'checkpointStatus'>): string | null {
  if (!result.ok) return result.error?.trim() || result.output?.trim() || 'Dispatch failed before a worker checkpoint was recorded.'
  if (result.checkpointStatus === 'timeout') return 'No fresh checkpoint before poll timeout.'
  return null
}

function recordDispatchBlock(workerId: string, assignment: AssignmentRequest, result: WorkerResult, options?: { missionId?: string | null }): void {
  const reason = dispatchBlockReason(result)
  if (!reason) return
  recordMissionAssignmentBlocked({
    missionId: options?.missionId,
    assignmentId: assignment.assignmentId ?? null,
    workerId,
    reason,
    source: 'swarm-dispatch',
  })
  writeRuntimePatch(workerId, {
    state: 'blocked',
    phase: 'blocked',
    checkpointStatus: 'blocked',
    blockedReason: reason,
    lastDispatchResult: reason,
    lastCheckIn: new Date().toISOString(),
    lastOutputAt: Date.now(),
  })
}

function markCheckpointResult(workerId: string, checkpoint: ParsedSwarmCheckpoint, notifySessionKey?: string | null): void {
  // When the checkpoint reaches any terminal status (anything other than
  // 'in_progress' — i.e. done/blocked/needs_input/handoff) the worker is no
  // longer running this task, so clear currentTask the same way conductor-stop
  // resets it. While still in_progress we omit the key entirely so
  // writeRuntimePatch keeps the existing currentTask untouched.
  const clearCurrentTask = checkpoint.checkpointStatus !== 'in_progress'
  writeRuntimePatch(workerId, {
    state: checkpoint.runtimeState,
    phase: checkpoint.stateLabel.toLowerCase(),
    checkpointStatus: checkpoint.checkpointStatus,
    ...(clearCurrentTask ? { currentTask: null } : {}),
    lastCheckIn: new Date().toISOString(),
    lastOutputAt: Date.now(),
    lastSummary: checkpoint.result,
    lastResult: checkpoint.result,
    lastRealSummary: checkpoint.result,
    lastRealResult: checkpoint.result,
    lastControlMessage: null,
    nextAction: checkpoint.nextAction,
    blockedReason: checkpoint.stateLabel === 'BLOCKED' || checkpoint.stateLabel === 'NEEDS_INPUT' ? checkpoint.blocker : null,
    needsHuman: checkpoint.stateLabel === 'NEEDS_INPUT',
    checkpointRaw: checkpoint.raw,
    checkpointFilesChanged: checkpoint.filesChanged,
    checkpointCommandsRun: checkpoint.commandsRun,
    notifySessionKey: notifySessionKey ?? 'main',
  })
}

async function waitForFreshCheckpoint(
  workerId: string,
  previousRaw: string | null,
  baselineRuntimeSignature: string,
  dispatchedAt: number,
  timeoutMs: number,
): Promise<ParsedSwarmCheckpoint | null> {
  const started = Date.now()
  const profilePath = getProfilePath(workerId)
  while (Date.now() - started < timeoutMs) {
    const runtimeSnapshot = readRuntimeCheckpointSnapshot(profilePath)
    if (runtimeSnapshotIsFresh(runtimeSnapshot, baselineRuntimeSignature, dispatchedAt)) {
      const runtimeCheckpoint = checkpointFromRuntimeSnapshot(runtimeSnapshot)
      if (runtimeCheckpoint && runtimeCheckpoint.raw !== previousRaw) return runtimeCheckpoint
    }

    const chat = readWorkerMessages(profilePath, 50)
    if (chat.ok) {
      const checkpoint = newestCheckpointFromMessages(chat.messages)
      if (checkpoint && checkpoint.raw !== previousRaw) return checkpoint
    }
    await sleep(2_000)
  }
  return null
}

function resolveWorkerCwd(workerId: string): string {
  const wrapperPath = getWrapperPath(workerId)
  if (existsSync(wrapperPath)) {
    try {
      const text = readFileSync(wrapperPath, 'utf8')
      const m = text.match(/cd\s+([^\n]+?)\s+\|\|\s+exit\s+1/)
      if (m?.[1]) {
        const raw = m[1].trim().replace(/^['"]|['"]$/g, '')
        if (raw && existsSync(raw)) return raw
      }
    } catch {
      /* noop */
    }
  }
  return homedir()
}

async function captureTmuxPane(tmuxBin: string, sessionName: string): Promise<string> {
  const captured = await execFileAsync(tmuxBin, ['capture-pane', '-p', '-t', sessionName, '-S', '-200'], 8_000)
  return captured.ok ? captured.stdout.trim() : ''
}

function redactStartupOutput(output: string): string {
  return output
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, '[REDACTED]')
    .replace(/(gh[pousr]_[A-Za-z0-9_]{12,})/g, '[REDACTED]')
}

async function ensureLiveTmuxSession(workerId: string): Promise<{ ok: true; tmuxBin: string; sessionName: string } | { ok: false; error: string }> {
  return { ok: false, error: 'legacy_swarm_startup_disabled; use native admission' }
}

async function sendPromptToLiveSession(workerId: string, prompt: string): Promise<WorkerResult | null> {
  const startedAt = Date.now()
  const ensured = await ensureLiveTmuxSession(workerId)
  if (!ensured.ok) return null

  const { tmuxBin, sessionName } = ensured
  const normalizedPrompt = prompt.replace(/\r\n/g, '\n')

  // Use tmux paste-buffer instead of send-keys -l line-by-line. This is more
  // reliable for live TUI delivery because it preserves multiline content and
  // avoids key translation/terminal timing issues. Enter submits the composed
  // prompt after paste.
  const loaded = await execFileAsync(tmuxBin, [
    'load-buffer',
    '-b',
    `swarm-dispatch-${workerId}`,
    '-',
  ], 8_000, normalizedPrompt)
  if (!loaded.ok) {
    return {
      workerId,
      ok: false,
      output: '',
      error: loaded.error,
      durationMs: Date.now() - startedAt,
      exitCode: null,
      delivery: 'tmux',
    }
  }

  // Ensure we are sending a fresh prompt, not appending onto a partially typed
  // line left in the agent TUI. Ctrl-U clears readline-style input in the
  // current prompt without disrupting the session.
  const cleared = await execFileAsync(tmuxBin, ['send-keys', '-t', sessionName, 'C-u'])
  if (!cleared.ok) {
    return {
      workerId,
      ok: false,
      output: '',
      error: cleared.error,
      durationMs: Date.now() - startedAt,
      exitCode: null,
      delivery: 'tmux',
    }
  }

  const pasted = await execFileAsync(tmuxBin, [
    'paste-buffer',
    '-d',
    '-b',
    `swarm-dispatch-${workerId}`,
    '-t',
    sessionName,
  ])
  if (!pasted.ok) {
    return {
      workerId,
      ok: false,
      output: '',
      error: pasted.error,
      durationMs: Date.now() - startedAt,
      exitCode: null,
      delivery: 'tmux',
    }
  }

  // Give the TUI enough time to ingest the paste before submitting. The Hermes
  // prompt can visually contain the pasted text before prompt_toolkit is ready
  // to accept Enter; sending a confirmation Enter shortly after the first one
  // prevents the user-visible failure mode where the task sits at the prompt.
  await sleep(2000)
  const enter = await execFileAsync(tmuxBin, ['send-keys', '-t', sessionName, 'C-m'])
  if (!enter.ok) {
    return {
      workerId,
      ok: false,
      output: '',
      error: enter.error,
      durationMs: Date.now() - startedAt,
      exitCode: null,
      delivery: 'tmux',
    }
  }
  await sleep(1000)
  const confirmEnter = await execFileAsync(tmuxBin, ['send-keys', '-t', sessionName, 'C-m'])
  if (!confirmEnter.ok) {
    return {
      workerId,
      ok: false,
      output: '',
      error: confirmEnter.error,
      durationMs: Date.now() - startedAt,
      exitCode: null,
      delivery: 'tmux',
    }
  }

  return {
    workerId,
    ok: true,
    output: `Delivered to live tmux session ${sessionName}`,
    error: null,
    durationMs: Date.now() - startedAt,
    exitCode: 0,
    delivery: 'tmux',
  }
}

export function buildHermesChatQueryArgs(prompt: string): string[] {
  // `hermes chat -q` requires the query as the *immediate* next argv item.
  // Keeping the prompt adjacent to -q prevents argparse from interpreting
  // following flags (for example -Q) as a missing query and failing with:
  // "argument -q/--query: expected one argument".
  return ['chat', '-q', prompt, '-Q', '--yolo', '--ignore-rules', '--source', 'swarm-dispatch']
}

export { SwarmDispatchError }

export async function dispatchSwarmAssignments(body: DispatchRequest, existingSessionAuthority?: ExistingSessionAuthority) {
  return dispatchNativeAssignments(body, existingSessionAuthority)
}

export const Route = createFileRoute('/api/swarm-dispatch')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        let body: DispatchRequest
        try {
          body = (await request.json()) as DispatchRequest
        } catch {
          return json({ error: 'Invalid JSON body' }, { status: 400 })
        }

        try {
          // B2: an explicit existing-session selection is authorized by THIS authenticated
          // same-origin JSON request only, before any store write or native effect.
          const selected = selectedExistingSessionIds(body)
          const authority = selected.length > 0 ? await authorizeExistingSessions(request, selected) : undefined
          return json(await dispatchSwarmAssignments(body, authority))
        } catch (error) {
          if (error instanceof SwarmDispatchError) {
            return json({ error: error.message }, { status: error.status })
          }
          return json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
        }
      },
    },
  },
})
