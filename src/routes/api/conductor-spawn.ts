import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import { dashboardFetch, ensureGatewayProbed } from '../../server/gateway-capabilities'
import { sanitizeConductorMissionGoal } from '../../server/conductor-mission-sanitize'
import { getSwarmMission, listSwarmMissions, recordMissionCheckpoint  } from '../../server/swarm-missions'
import { getSwarmProfilePath } from '../../server/swarm-foundation'
import { readWorkerMessages } from '../../server/swarm-chat-reader'
import { newestCheckpointFromMessages } from '../../server/swarm-checkpoints'
import { SwarmDispatchError, refreshNativeMission } from '../../server/swarm-native'
import { checkpointFromRuntimeSnapshot, dispatchSwarmAssignments, readRuntimeCheckpointSnapshot, runtimeCheckpointSignature } from './swarm-dispatch'
import type { SwarmMission } from '../../server/swarm-missions'

let cachedSkill: string | null = null

export const NATIVE_CONDUCTOR_MODE_NOTE = 'Workspace native adapter using supported Hermes gateway RPC, not a dashboard Conductor managed run. Live delivery and independent acceptance are separate gates.'

type ConductorSpawnBody = {
  origin?: unknown
  goal?: unknown
  orchestratorModel?: unknown
  workerModel?: unknown
  projectsDir?: unknown
  maxParallel?: unknown
  supervised?: unknown
}

function repoRoot(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    return resolve(here, '..', '..', '..')
  } catch {
    return process.cwd()
  }
}

function loadDispatchSkill(): string {
  if (cachedSkill !== null) return cachedSkill
  const home = process.env.HOME ?? ''
  const candidates = [
    resolve(repoRoot(), 'skills/workspace-dispatch/SKILL.md'),
    resolve(process.cwd(), 'skills/workspace-dispatch/SKILL.md'),
    ...(home ? [resolve(home, '.hermes/skills/workspace-dispatch/SKILL.md')] : []),
    ...(home ? [resolve(home, '.openclaw/workspace/skills/workspace-dispatch/SKILL.md')] : []),
  ]
  for (const p of candidates) {
    try {
      cachedSkill = readFileSync(p, 'utf-8')
      return cachedSkill
    } catch {}
  }
  cachedSkill = ''
  return cachedSkill
}

function readOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readMaxParallel(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.min(5, Math.max(1, Math.round(value)))
}

function buildOrchestratorPrompt(
  goal: string,
  skill: string,
  options: {
    orchestratorModel: string
    workerModel: string
    projectsDir: string
    maxParallel: number
    supervised: boolean
  },
): string {
  const outputBase = options.projectsDir || '/tmp'
  const outputPrefix = outputBase === '/tmp' ? '/tmp/dispatch-<slug>' : `${outputBase}/dispatch-<slug>`
  return [
    'You are a mission orchestrator. Execute this mission autonomously.',
    '',
    '## Dispatch Skill Instructions',
    '',
    skill || '(workspace-dispatch skill not found locally; proceed using create_task to spawn workers)',
    '',
    '## Mission',
    '',
    `Goal: ${goal}`,
    ...(options.orchestratorModel ? ['', `Use model: ${options.orchestratorModel} for the orchestrator`] : []),
    ...(options.workerModel ? ['', `Use model: ${options.workerModel} for all workers`] : []),
    ...(options.maxParallel > 1
      ? ['', `Run up to ${options.maxParallel} workers in parallel when tasks are independent`]
      : ['', 'Spawn workers one at a time. Do NOT wait for workers to finish — the UI handles tracking.']),
    ...(options.supervised ? ['', 'Supervised mode is enabled. Require approval before each task.'] : []),
    '',
    '## Critical Rules',
    '- Use create_task / delegate_task to create worker agents for each task',
    '- Do NOT do the work yourself — spawn workers',
    '- For simple tasks (single file, quick mockup), use ONLY 1 task with 1 worker — do not over-decompose',
    '- Do NOT ask for confirmation — start immediately',
    '- Label workers as "worker-<task-slug>" so the UI can track them',
    '- Each worker gets a self-contained prompt with the task + exit criteria',
    `- Workers should write output to ${outputPrefix} directories`,
    '- After spawning all workers, report your plan summary and finish. The UI tracks worker completion automatically.',
    '- Report a summary when all tasks are done',
  ].join('\n')
}

async function createDashboardConductorMission(payload: { name: string; prompt: string }): Promise<{
  id?: string
  name?: string
  sessionKey?: string
  error?: string
}> {
  const res = await dashboardFetch('/api/conductor/missions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: payload.name, prompt: payload.prompt }),
  })
  const text = await res.text()
  let data: { id?: string; name?: string; session_id?: string; error?: string; detail?: string } = {}
  try {
    data = JSON.parse(text)
  } catch {
    return { error: text || `HTTP ${res.status}` }
  }
  if (!res.ok || data.error || data.detail) {
    return { error: data.error || data.detail || `HTTP ${res.status}` }
  }
  return { id: data.id, name: data.name, sessionKey: data.session_id }
}

type NativeConductorAssignment = {
  workerId: string
  task: string
  rationale: string
  reviewRequired?: boolean
  direct?: boolean
  raw?: boolean
}

function clipText(value: string, max = 8000): string {
  return value.length <= max ? value : `${value.slice(0, max - 20)}\n...[truncated]`
}

export function buildNativeConductorAssignments(goal: string, options: { maxParallel: number; supervised: boolean }): Array<NativeConductorAssignment> {
  // Parallelism is a limit, not authority to dispatch specialists or archived templates.
  return [{
    workerId: 'orchestrator-argus',
    rationale: 'The existing ARGUS Orchestrator is the sole specialist dispatcher.',
    reviewRequired: true,
    direct: true,
    task: [
      `Conductor mission: ${goal}`,
      'Use existing configured ARGUS profiles only. Preserve saved provider/model settings and all attended once/deny approvals.',
      'Do not broadcast, create bots/profiles, or start/restart a gateway. Keep other workstreams untouched.',
      `Requested parallelism limit: ${options.maxParallel}. Specialist order remains operator-controlled.`,
      'Require independent review of the exact frozen commit/artifact before reporting mission acceptance.',
    ].join('\n'),
  }]
}

function swarmMissionStatus(mission: SwarmMission): string {
  if (mission.state === 'cancelled') return 'cancelled'
  if (mission.state === 'complete') return 'completed'
  if (mission.state === 'blocked' && mission.assignments.some((assignment) => assignment.state === 'needs_input')) return 'waiting'
  if (mission.state === 'blocked') return 'blocked'
  if (mission.state === 'planning' || mission.state === 'dispatching') return 'queued'
  if (mission.state === 'reviewing') return 'reviewing'
  return 'running'
}

function nativeMissionLines(mission: SwarmMission, maxLines: number): Array<string> {
  const lines = [
    `Native Workspace Swarm mission: ${mission.title}`,
    `mission_id: ${mission.id}`,
    `state: ${mission.state}`,
    ...mission.assignments.map((assignment) => {
      const result = assignment.checkpoint?.result ? ` — ${assignment.checkpoint.result}` : ''
      const blocker = assignment.checkpoint?.blocker ? ` — blocker: ${assignment.checkpoint.blocker}` : ''
      return `${assignment.workerId} ${assignment.state}: ${assignment.task.slice(0, 160)}${result}${blocker}`
    }),
    ...mission.events.slice(-20).map((event) => `${new Date(event.at).toISOString()} ${event.type}: ${event.message}`),
  ]
  return lines.slice(-maxLines)
}

export function toNativeConductorMissionRecord(mission: SwarmMission, maxLines = 400) {
  const completedAt = Math.max(0, ...mission.assignments.map((assignment) => assignment.completedAt ?? 0)) || null
  return {
    id: mission.id,
    name: mission.title,
    status: swarmMissionStatus(mission),
    error: mission.state === 'blocked' ? 'Native Workspace Swarm mission blocked' : null,
    session_id: null,
    lines: nativeMissionLines(mission, maxLines),
    exit_code: mission.state === 'blocked' || mission.state === 'cancelled' ? 1 : mission.state === 'complete' ? 0 : null,
    nativeSwarm: true,
    modeOfficialOotb: false,
    modeNote: NATIVE_CONDUCTOR_MODE_NOTE,
    assignments: mission.assignments.map((assignment) => ({ ...assignment, native: assignment.native ? { ...assignment.native, report: undefined } : undefined })),
    reports: mission.assignments.flatMap((assignment) => assignment.native?.report ? [{ assignmentId: assignment.id, workerId: assignment.workerId, deliveryKind: assignment.deliveryKind ?? 'unknown', assignmentState: assignment.state, nativeStatus: assignment.native.status, nativeOutcome: assignment.native.outcome ?? null, report: assignment.native.report }] : []),
    completionKind: mission.state === 'complete' && mission.assignments.every((assignment) => assignment.deliveryKind === 'report') ? 'report-only' : null,
    completedAt,
    updatedAt: mission.updatedAt,
    createdAt: mission.createdAt,
  }
}

async function createNativeConductorMission(input: {
  origin?: unknown
  goal: string
  missionName: string
  maxParallel: number
  supervised: boolean
}) {
  const assignments = buildNativeConductorAssignments(input.goal, {
    maxParallel: input.maxParallel,
    supervised: input.supervised,
  })
  const missionTitle = `Conductor: ${clipText(input.goal, 120)}`
  const dispatched = await dispatchSwarmAssignments({
    origin: input.origin,
    assignments,
    missionId: input.missionName,
    missionTitle,
    allowAsync: true,
    waitForCheckpoint: false,
    timeoutSeconds: 600,
    checkpointPollSeconds: 10,
    notifySessionKey: 'main',
  })
  return { missionId: input.missionName, missionTitle, assignments: dispatched.assignments, results: dispatched.results }
}

export const Route = createFileRoute('/api/conductor-spawn')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        const url = new URL(request.url)
        if (url.searchParams.get('history') === '1') {
          // Metadata only; selecting an exact history item refetches its authenticated
          // result. Never inspect unrelated native jobs or download all report bodies.
          const missions = listSwarmMissions(50).filter((mission) => mission.executionMode === 'native').map((mission) => ({
            id: mission.id, name: mission.title, nativeSwarm: true, status: swarmMissionStatus(mission), createdAt: mission.createdAt, updatedAt: mission.updatedAt,
            completedAt: Math.max(0, ...mission.assignments.map((assignment) => assignment.completedAt ?? 0)) || null,
            completionKind: mission.state === 'complete' && mission.assignments.every((assignment) => assignment.deliveryKind === 'report') ? 'report-only' : null,
          }))
          return json({ ok: true, missions })
        }
        const missionId = url.searchParams.get('missionId')?.trim()
        const requestedLines = Number(url.searchParams.get('lines') || '200')
        const lines = Number.isFinite(requestedLines) ? Math.min(2000, Math.max(1, requestedLines)) : 200
        if (!missionId) return json({ ok: false, error: 'missionId required' }, { status: 400 })

        const nativeMission = getSwarmMission(missionId)
        if (nativeMission) {
          const updatedNative = await refreshNativeMission(missionId) ?? nativeMission
          return json({ ok: true, mode: 'native-swarm', mission: toNativeConductorMissionRecord(updatedNative, lines) })
        }

        const capabilities = await ensureGatewayProbed()
        if (!capabilities.dashboard.available || !capabilities.conductor) {
          return json({ ok: false, error: 'Conductor mission not found in native swarm store and dashboard Conductor API is unavailable' }, { status: 404 })
        }

        const res = await dashboardFetch(`/api/conductor/missions/${encodeURIComponent(missionId)}?lines=${lines}`)
        const text = await res.text()
        let mission: Record<string, unknown> = {}
        try {
          mission = JSON.parse(text) as Record<string, unknown>
        } catch {
          return json({ ok: false, error: text || `HTTP ${res.status}` }, { status: res.ok ? 502 : res.status })
        }
        if (!res.ok) {
          const error = typeof mission.detail === 'string' ? mission.detail : typeof mission.error === 'string' ? mission.error : `HTTP ${res.status}`
          return json({ ok: false, error }, { status: res.status })
        }
        return json({ ok: true, mission })
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        try {
          const body = (await request.json().catch(() => ({}))) as ConductorSpawnBody
          const rawGoal = readOptionalString(body.goal)
          const goalSanitization = sanitizeConductorMissionGoal(rawGoal)
          const goal = goalSanitization.goal
          const orchestratorModel = readOptionalString(body.orchestratorModel)
          const workerModel = readOptionalString(body.workerModel)
          const projectsDir = readOptionalString(body.projectsDir)
          const maxParallel = readMaxParallel(body.maxParallel)
          const supervised = body.supervised === true
          if (!goal) {
            return json(
              {
                ok: false,
                error: goalSanitization.removedCloudflareErrorPage
                  ? 'mission goal only contained a Cloudflare 5xx HTML error page; enter the original mission goal and retry'
                  : 'goal required',
                warnings: goalSanitization.warnings,
              },
              { status: 400 },
            )
          }

          if (orchestratorModel || workerModel) return json({ ok: false, error: 'profile_route_override_forbidden; use saved profile settings' }, { status: 400 })
          const missionName = `conductor-${Date.now()}`
          // All new missions use the same constrained path, regardless of dashboard capability.
            const native = await createNativeConductorMission({
              goal,
              missionName,
              origin: body.origin,
              maxParallel,
              supervised,
            })
            return json({
              ok: true,
              mode: 'native-swarm',
              modeOfficialOotb: false,
              modeNote: NATIVE_CONDUCTOR_MODE_NOTE,
              prompt: null,
              missionId: native.missionId,
              sessionKey: null,
              sessionKeyPrefix: null,
              jobId: null,
              jobName: native.missionTitle,
              runId: null,
              warnings: goalSanitization.warnings,
              assignments: native.assignments,
              results: native.results,
            })
        } catch (error) {
          if (error instanceof SwarmDispatchError) return json({ ok: false, error: error.message, ...(error.status === 401 ? { code: 'dashboard_auth_required', needs_login: true, login_url: '/dashboard-connect' } : {}) }, { status: error.status })
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 })
        }
      },
    },
  },
})
