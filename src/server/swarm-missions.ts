import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { SWARM_CANONICAL_REPO } from './swarm-environment'
import { parseSwarmCheckpoint } from './swarm-checkpoints'
import { SwarmDispatchError } from './swarm-profile-policy'
import { requireExistingSessionAuthority } from './swarm-existing-session-auth'
import { isInputBinding, isPositiveInputLookup } from './swarm-native-input-proof'
import type { ParsedSwarmCheckpoint } from './swarm-checkpoints'
import type { ExistingSessionAuthority } from './swarm-existing-session-auth'
import type { NativeInputBinding, NativeObservation } from './swarm-native-bridge'
import type { NativeMissionOrigin } from './swarm-origin'

/** Untrusted result data from one exact native admission, never executable instructions. */
export type NativeReport = {
  body: string
  sha256: string
  utf8Bytes: number
  profileId: string
  sessionId: string
  admissionId: string
  outcome: 'completed'
  executionGeneration: number | null
  source: 'native-admission-inspect'
  completedAt: number | null
  observedAt: number
}

export type NativeAssignment = {
  requestId: string
  profileId: string
  sessionId: string | null
  admissionId: string | null
  status: string
  observedAt?: number
  outcome?: string | null
  model?: string
  provider?: string
  reasoningEffort?: string
  lastSequence?: number
  replayEpoch?: string
  executionGeneration?: number | null
  artifact?: { revision: string; sha256: string; path: string }
  review?: { assignmentId: string; revision: string; sha256: string; verdict: 'accepted' | 'changes_required' }
  report?: NativeReport
  /** B2: staged for one explicitly selected existing session (never session.create). */
  binding?: 'existing-session'
  /** B2: the observation and the native idle-admission-v1 acceptance of its NEW admission. */
  preflight?: NativeObservation['preflight']
  /** C2: the owner's exact prepared binding, persisted BEFORE the submit (`prompt.prepare_input`). */
  inputBinding?: NativeInputBinding
}

/** B2: immutable per-assignment request to run in one exact existing reviewer session. */
export type SwarmSessionBinding = { mode: 'existing'; sessionId: string }

export const EXISTING_SESSION_WORKER = 'argus-reviewer'
export const EXISTING_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/
const RESERVED_NATIVE_STATUSES = ['submitting', 'queued', 'started', 'unknown']

export type SwarmMissionAssignmentState = 'queued' | 'dispatched' | 'checkpointed' | 'blocked' | 'needs_input' | 'reviewing' | 'done' | 'cancelled'
export type SwarmMissionState = 'planning' | 'dispatching' | 'executing' | 'reviewing' | 'blocked' | 'complete' | 'cancelled'

export type SwarmMissionAssignment = {
  deliveryKind?: 'report' | 'code'
  id: string
  workerId: string
  task: string
  rationale: string | null
  dependsOn: Array<string>
  reviewRequired: boolean
  state: SwarmMissionAssignmentState
  dispatchedAt: number | null
  completedAt: number | null
  reviewedAt: number | null
  reviewedBy: string | null
  checkpoint: ParsedSwarmCheckpoint | null
  native?: NativeAssignment
  sessionBinding?: SwarmSessionBinding
  producerIntent?: 'initial' | 'correction' | 'continuation'
}

export type SwarmMissionEvent = {
  id: string
  type: 'created' | 'assignment_dispatched' | 'checkpoint' | 'continuation' | 'review' | 'blocked' | 'assignment_cancelled' | 'mission_cancelled' | 'native_report' | 'report_reconciled'
  at: number
  workerId?: string
  assignmentId?: string
  message: string
  data?: Record<string, unknown>
}

export type SwarmCheckpointReport = {
  missionId: string
  assignmentId: string
  workerId: string
  recordedAt: number
  stateLabel: ParsedSwarmCheckpoint['stateLabel']
  checkpointStatus: ParsedSwarmCheckpoint['checkpointStatus']
  runtimeState: ParsedSwarmCheckpoint['runtimeState']
  filesChanged: string | null
  commandsRun: string | null
  result: string | null
  blocker: string | null
  nextAction: string | null
  source: string
}

export type SwarmMission = {
  origin?: NativeMissionOrigin
  executionMode?: 'native'
  id: string
  title: string
  state: SwarmMissionState
  createdAt: number
  updatedAt: number
  assignments: Array<SwarmMissionAssignment>
  events: Array<SwarmMissionEvent>
}

type SwarmMissionStore = {
  version: 1
  missions: Array<SwarmMission>
}

export const SWARM_MISSIONS_PATH = join(SWARM_CANONICAL_REPO, '.runtime', 'swarm-missions.json')

function now(): number {
  return Date.now()
}

function shortId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function readStore(): SwarmMissionStore {
  if (!existsSync(SWARM_MISSIONS_PATH)) return { version: 1, missions: [] }
  try {
    const parsed = JSON.parse(readFileSync(SWARM_MISSIONS_PATH, 'utf8')) as { version?: unknown; missions?: unknown } | null
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.missions)) throw new Error('invalid mission store')
    return { version: 1, missions: parsed.missions as Array<SwarmMission> }
  } catch {
    throw new Error('swarm_mission_store_unreadable; preserve existing store')
  }
}

function writeStore(store: SwarmMissionStore): void {
  mkdirSync(dirname(SWARM_MISSIONS_PATH), { recursive: true })
  const tmp = `${SWARM_MISSIONS_PATH}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n')
  renameSync(tmp, SWARM_MISSIONS_PATH)
}

function event(type: SwarmMissionEvent['type'], message: string, extra?: Partial<SwarmMissionEvent>): SwarmMissionEvent {
  return { id: shortId('evt'), type, at: now(), message, ...extra }
}

function reportFromCheckpoint(input: {
  missionId: string
  assignmentId: string
  workerId: string
  checkpoint: ParsedSwarmCheckpoint
  source?: string | null
}): SwarmCheckpointReport {
  return {
    missionId: input.missionId,
    assignmentId: input.assignmentId,
    workerId: input.workerId,
    recordedAt: now(),
    stateLabel: input.checkpoint.stateLabel,
    checkpointStatus: input.checkpoint.checkpointStatus,
    runtimeState: input.checkpoint.runtimeState,
    filesChanged: input.checkpoint.filesChanged,
    commandsRun: input.checkpoint.commandsRun,
    result: input.checkpoint.result,
    blocker: input.checkpoint.blocker,
    nextAction: input.checkpoint.nextAction,
    source: input.source?.trim() || 'unknown',
  }
}

function deriveMissionState(assignments: Array<SwarmMissionAssignment>): SwarmMissionState {
  if (assignments.length > 0 && assignments.every((item) => item.state === 'cancelled')) return 'cancelled'
  if (assignments.some((item) => item.state === 'blocked' || item.state === 'needs_input')) return 'blocked'
  if (assignments.length > 0 && assignments.every((item) => item.state === 'done' || item.state === 'cancelled' || (item.state === 'checkpointed' && !item.reviewRequired))) return 'complete'
  if (assignments.some((item) => item.state === 'reviewing' || (item.state === 'checkpointed' && item.reviewRequired))) return 'reviewing'
  if (assignments.some((item) => item.state === 'dispatched' || item.state === 'checkpointed')) return 'executing'
  return 'planning'
}

function inferReviewRequired(task: string, rationale?: string | null): boolean {
  // Match intent-bearing task terms only. The previous loose alternation matched
  // substrings such as "patch" inside "dispatch" and left simple smoke runs in
  // review forever.
  return /\b(code|patch(?:es|ed|ing)?|implement(?:ation|ed|ing)?|pr|benchmarks?)\b/i.test(`${task} ${rationale ?? ''}`)
}

const TERMINAL_ASSIGNMENT_STATES = new Set<SwarmMissionAssignmentState>(['done', 'cancelled'])

function isTerminalAssignment(assignment: SwarmMissionAssignment): boolean {
  return TERMINAL_ASSIGNMENT_STATES.has(assignment.state)
}

export function listSwarmMissions(limit = 20): Array<SwarmMission> {
  return readStore().missions
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(1, Math.min(100, limit)))
}

export function getSwarmMission(missionId: string): SwarmMission | null {
  return readStore().missions.find((mission) => mission.id === missionId) ?? null
}

export function archiveStaleMissions(staleMs: number = 6 * 60 * 60 * 1000): { archivedIds: Array<string>; count: number } {
  const store = readStore()
  const now = Date.now()
  const archivedIds: Array<string> = []
  for (const mission of store.missions) {
    if (mission.assignments.some((assignment) => assignment.native)) continue
    if (mission.state !== 'executing' && mission.state !== 'planning') continue
    if ((now - mission.updatedAt) < staleMs) continue
    if (!mission.assignments.every(a => ['done', 'checkpointed', 'blocked', 'needs_input'].includes(a.state))) continue
    mission.state = 'complete'
    mission.events.push(event('continuation', `Archived as stale (>${Math.round(staleMs / 3600000)}h, all assignments terminal)`))
    archivedIds.push(mission.id)
  }
  if (archivedIds.length) {
    writeStore(store)
  }
  return { archivedIds, count: archivedIds.length }
}

export type CreateOrUpdateMissionResult = SwarmMission & { _created?: boolean }

function bindingKey(binding: SwarmSessionBinding | undefined): string {
  return binding ? `${binding.mode}:${binding.sessionId}` : 'new-session'
}

/** A dependency that is a real frozen code artifact (not a report, not a success label). */
export function hasExactArtifact(dependency: SwarmMissionAssignment | undefined): boolean {
  const artifact = dependency?.native?.artifact
  return Boolean(dependency && artifact && ['checkpointed', 'done'].includes(dependency.state)
    && dependency.deliveryKind !== 'report' && dependency.workerId !== EXISTING_SESSION_WORKER
    && /^[0-9a-f]{40}$/.test(artifact.revision) && /^[0-9a-f]{64}$/.test(artifact.sha256)
    && typeof artifact.path === 'string' && artifact.path.length > 0)
}

/** Eligibility of an existing-session request; refused before any store or native effect. */
export function assertSessionBindingEligible(assignment: { workerId: string; deliveryKind?: 'report' | 'code'; dependsOn?: Array<string>; producerIntent?: SwarmMissionAssignment['producerIntent']; sessionBinding?: SwarmSessionBinding }): void {
  const binding = assignment.sessionBinding
  if (!binding) return
  if (binding.mode !== 'existing' || typeof binding.sessionId !== 'string' || !EXISTING_SESSION_ID_PATTERN.test(binding.sessionId)
      || !(assignment.workerId === EXISTING_SESSION_WORKER || (assignment.workerId === 'argus-developer' && process.env.ARGUS_WORKSPACE_GPU_SOURCE_ENABLED === '1')) || (assignment.deliveryKind ?? 'code') !== 'code'
      || (!(assignment.workerId === 'argus-developer' && assignment.producerIntent === 'initial') && (!Array.isArray(assignment.dependsOn) || assignment.dependsOn.length === 0))) {
    throw new SwarmDispatchError('existing_session_not_eligible; explicit reviewer or opted-in Developer code assignment with exact dependency artifact only')
  }
}

/** Validate a reachable transition against the latest store, before creation AND staging. */
export function assertExistingAssignmentDependencies(assignment: { id?: string; workerId: string; producerIntent?: SwarmMissionAssignment['producerIntent']; dependsOn?: Array<string>; sessionBinding?: SwarmSessionBinding }, assignments: Array<SwarmMissionAssignment>): void {
  if (assignment.producerIntent !== undefined && (!['initial', 'correction', 'continuation'].includes(assignment.producerIntent) || assignment.workerId !== 'argus-developer')) throw new SwarmDispatchError('invalid_producer_intent')
  const dependencies = assignment.dependsOn ?? []
  if (assignment.producerIntent === 'initial') {
    if (dependencies.length || assignments.some((item) => item.workerId === 'argus-developer' && item.id !== assignment.id)) throw new SwarmDispatchError('initial_producer_requires_empty_developer_lineage', 409)
    return
  }
  if (assignment.producerIntent === 'correction') {
    const target = assignments.find((item) => dependencies.includes(item.id) && item.workerId === assignment.workerId)
    const reviewer = assignments.find((item) => dependencies.includes(item.id) && item.workerId === EXISTING_SESSION_WORKER)
    const review = reviewer?.native?.review
    if (dependencies.length !== 2 || new Set(dependencies).size !== 2 || !hasExactArtifact(target)
        || target?.state !== 'checkpointed' || target.native?.status !== 'terminal' || target.native.outcome !== 'completed'
        || !assignment.sessionBinding || target.sessionBinding?.sessionId !== assignment.sessionBinding.sessionId
        || reviewer?.state !== 'done' || reviewer.native?.status !== 'terminal' || reviewer.native.outcome !== 'completed'
        || !reviewer.native.artifact || reviewer.native.profileId === target.native.profileId
        || review?.verdict !== 'changes_required' || review.assignmentId !== target.id
        || review.revision !== target.native.artifact?.revision || review.sha256 !== target.native.artifact.sha256
        || !reviewer.dependsOn.includes(target.id)) throw new SwarmDispatchError('exact_changes_required_review_dependency', 409)
    return
  }
  if (assignment.producerIntent === 'continuation') {
    if (dependencies.length !== 1) throw new SwarmDispatchError('exact_accepted_continuation_required', 409)
    const target = assignments.find((item) => item.id === dependencies[0])
    if (!target || !hasExactArtifact(target) || target.state !== 'done' || target.workerId !== assignment.workerId
        || !assignment.sessionBinding || target.sessionBinding?.sessionId !== assignment.sessionBinding.sessionId
        || !target.native?.artifact) throw new SwarmDispatchError('exact_accepted_continuation_required', 409)
    const artifact = target.native.artifact
    const targetProfile = target.native.profileId
    const reviewer = assignments.find((item) => {
      const native = item.native
      const review = native?.review
      return Boolean(native && review && item.workerId === EXISTING_SESSION_WORKER && item.state === 'done'
        && native.status === 'terminal' && native.outcome === 'completed' && native.artifact
        && review.assignmentId === target.id && review.verdict === 'accepted'
        && review.revision === artifact.revision && review.sha256 === artifact.sha256
        && item.dependsOn.includes(target.id) && native.profileId !== targetProfile)
    })
    if (!reviewer) throw new SwarmDispatchError('exact_accepted_continuation_required', 409)
  }
  if (!dependencies.length || !dependencies.every((id) => {
    const item = assignments.find((entry) => entry.id === id)
    return hasExactArtifact(item) && (assignment.workerId === EXISTING_SESSION_WORKER || item?.state === 'done')
  })) throw new SwarmDispatchError(assignment.workerId === EXISTING_SESSION_WORKER ? 'existing_session_requires_exact_artifact_dependency' : 'existing_session_requires_dispatchable_artifact_dependency', 409)
}

export type MissionInput = {
  origin?: NativeMissionOrigin
  executionMode?: 'native'
  missionId?: string | null
  title: string
  assignments: Array<{ workerId: string; task: string; rationale?: string | null; dependsOn?: Array<string>; reviewRequired?: boolean; deliveryKind?: 'report' | 'code'; producerIntent?: SwarmMissionAssignment['producerIntent']; sessionBinding?: SwarmSessionBinding }>
}

export function createOrUpdateMission(input: MissionInput, existingSessionAuthority?: ExistingSessionAuthority): CreateOrUpdateMissionResult {
  const store = readStore()
  const { mission, created } = applyMissionInput(store, input, existingSessionAuthority)
  writeStore(store)
  return Object.assign(mission, { _created: created })
}

/** Validate and apply *input* to the in-memory *store* only; the caller decides whether to write it. */
function applyMissionInput(store: SwarmMissionStore, input: MissionInput, existingSessionAuthority?: ExistingSessionAuthority): { mission: SwarmMission; created: boolean } {
  const createdAt = now()
  const missionId = input.missionId?.trim() || shortId('mission')
  let mission = store.missions.find((item) => item.id === missionId)
  // B2 guards apply to every caller of this helper, before any mutation.
  for (const assignment of input.assignments) {
    assertSessionBindingEligible(assignment)
    if (assignment.sessionBinding) requireExistingSessionAuthority(existingSessionAuthority, assignment.sessionBinding.sessionId)
    const existing = mission?.assignments.find((item) => item.workerId === assignment.workerId && item.task === assignment.task)
    if (existing && bindingKey(existing.sessionBinding) !== bindingKey(assignment.sessionBinding)) throw new SwarmDispatchError('session_binding_immutable', 409)
    if (existing?.producerIntent && JSON.stringify(existing.dependsOn) !== JSON.stringify(assignment.dependsOn ?? [])) throw new SwarmDispatchError('producer_dependencies_immutable', 409)
    if (existing && existing.producerIntent !== assignment.producerIntent) throw new SwarmDispatchError('producer_intent_immutable', 409)
    if (assignment.sessionBinding && !existing) assertExistingAssignmentDependencies(assignment, mission?.assignments ?? [])
  }
  let createdMission = false
  if (!mission) {
    mission = {
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.executionMode ? { executionMode: input.executionMode } : {}),
      id: missionId,
      title: input.title || 'Untitled swarm mission',
      state: 'planning',
      createdAt,
      updatedAt: createdAt,
      assignments: [],
      events: [event('created', `Mission created: ${input.title || missionId}`)],
    }
    store.missions.push(mission)
    createdMission = true
  }

  mission.title = input.title || mission.title
  for (const assignment of input.assignments) {
    const existing = mission.assignments.find((item) => item.workerId === assignment.workerId && item.task === assignment.task)
    if (existing) continue
    const id = shortId('assign')
    mission.assignments.push({
      id,
      workerId: assignment.workerId,
      task: assignment.task,
      rationale: assignment.rationale ?? null,
      dependsOn: assignment.dependsOn ?? [],
      reviewRequired: assignment.reviewRequired ?? inferReviewRequired(assignment.task, assignment.rationale),
      state: 'queued',
      dispatchedAt: null,
      completedAt: null,
      reviewedAt: null,
      reviewedBy: null,
      checkpoint: null,
      ...(assignment.deliveryKind ? { deliveryKind: assignment.deliveryKind } : {}),
      ...(assignment.producerIntent ? { producerIntent: assignment.producerIntent } : {}),
      ...(assignment.sessionBinding ? { sessionBinding: { mode: 'existing' as const, sessionId: assignment.sessionBinding.sessionId } } : {}),
    })
  }
  mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  return { mission, created: createdMission }
}

/** P-1: which assignment of a prepared mission this request stages now (null: leave it queued). */
export type NativeStagePlan = (mission: SwarmMission, assignment: SwarmMissionAssignment) => NativeAssignment | null

/**
 * P-1 all-or-nothing preparation. Validates the WHOLE prospective batch against the latest store
 * (creation rules, combined lineage, one new dispatchable intent per profile and per session, every
 * profile/session reservation) and only then creates AND stages it in ONE synchronous store write.
 * Any refusal throws before the write: the store is byte-unchanged and no Native boundary is crossed.
 */
export function createAndStageNativeBatch(input: MissionInput, plan: NativeStagePlan, existingSessionAuthority?: ExistingSessionAuthority): { mission: SwarmMission; staged: Array<string> } {
  const store = readStore()
  const { mission } = applyMissionInput(store, input, existingSessionAuthority)
  const planned: Array<[SwarmMissionAssignment, NativeAssignment]> = []
  for (const requested of input.assignments) {
    const assignment = mission.assignments.find((item) => item.workerId === requested.workerId && item.task === requested.task)
    const native = assignment ? plan(mission, assignment) : null
    if (assignment && native) planned.push([assignment, native])
  }
  const workers = new Set<string>()
  const sessions = new Set<string>()
  for (const [assignment, native] of planned) {
    const session = native.sessionId ?? assignment.sessionBinding?.sessionId
    if (workers.has(assignment.workerId) || (session && sessions.has(session))) throw new SwarmDispatchError('batch_profile_reservation_conflict', 409)
    workers.add(assignment.workerId)
    if (session) sessions.add(session)
  }
  for (const [assignment, native] of planned) {
    assertStageable(store, mission, assignment, native, existingSessionAuthority)
    assignment.native = native
  }
  mission.updatedAt = now()
  writeStore(store)
  return { mission, staged: planned.map(([assignment]) => assignment.id) }
}

export function markMissionAssignmentDispatched(input: {
  missionId: string
  workerId: string
  task: string
  source?: string | null
  author?: string | null
}): SwarmMission | null {
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  if (mission.state === 'cancelled' || mission.state === 'complete') return mission
  const assignment = mission.assignments.find((item) => item.workerId === input.workerId && item.task === input.task)
  if (!assignment) return null
  if (isTerminalAssignment(assignment)) return mission
  assignment.state = 'dispatched'
  assignment.dispatchedAt = now()
  mission.events.push(event('assignment_dispatched', `Dispatched ${assignment.id} to ${input.workerId}`, {
    workerId: input.workerId,
    assignmentId: assignment.id,
    data: {
      task: assignment.task,
      source: input.source?.trim() || 'swarm-dispatch',
      author: input.author?.trim() || 'aurora',
    },
  }))
  mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return mission
}

export type RecordCheckpointResult = (SwarmMission & { _completed?: boolean; _ignoredReason?: string }) | null

export function recordMissionCheckpoint(input: {
  missionId?: string | null
  assignmentId?: string | null
  workerId: string
  checkpoint: ParsedSwarmCheckpoint
  source?: string | null
}): RecordCheckpointResult {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  if (mission.state === 'cancelled') return Object.assign(mission, { _ignoredReason: 'mission cancelled' })
  const assignment = (input.assignmentId
    ? mission.assignments.find((item) => item.id === input.assignmentId)
    : null)
    ?? [...mission.assignments].reverse().find((item) => item.workerId === input.workerId && item.state !== 'done')
    ?? [...mission.assignments].reverse().find((item) => item.workerId === input.workerId)
  if (!assignment) return null
  if (assignment.native) return Object.assign(mission, { _ignoredReason: 'native admission evidence required' })
  if (assignment.state === 'cancelled') return Object.assign(mission, { _ignoredReason: 'assignment cancelled' })
  if (assignment.state === 'done') return Object.assign(mission, { _ignoredReason: 'assignment done' })
  if (assignment.checkpoint?.raw === input.checkpoint.raw) {
    return Object.assign(mission, { _completed: mission.state === 'complete' })
  }
  assignment.checkpoint = input.checkpoint
  assignment.completedAt = now()
  assignment.state = input.checkpoint.stateLabel === 'BLOCKED'
    ? 'blocked'
    : input.checkpoint.stateLabel === 'NEEDS_INPUT'
      ? 'needs_input'
      : input.checkpoint.stateLabel === 'IN_PROGRESS'
        ? 'dispatched'
        : 'checkpointed'
  const report = reportFromCheckpoint({
    missionId: mission.id,
    assignmentId: assignment.id,
    workerId: input.workerId,
    checkpoint: input.checkpoint,
    source: input.source,
  })
  mission.events.push(event('checkpoint', `${input.workerId} checkpointed: ${input.checkpoint.stateLabel}`, {
    workerId: input.workerId,
    assignmentId: assignment.id,
    data: report,
  }))
  mission.updatedAt = now()
  const previousState = mission.state
  mission.state = deriveMissionState(mission.assignments)
  const completed = mission.state === 'complete' && previousState !== 'complete'
  writeStore(store)
  return Object.assign(mission, { _completed: completed })
}

export function recordMissionAssignmentBlocked(input: {
  missionId?: string | null
  assignmentId?: string | null
  workerId: string
  reason?: string | null
  source?: string | null
}): { mission: SwarmMission; assignment: SwarmMissionAssignment; changed: boolean } | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  if (mission.state === 'cancelled' || mission.state === 'complete') return null
  const assignment = (input.assignmentId
    ? mission.assignments.find((item) => item.id === input.assignmentId)
    : null)
    ?? [...mission.assignments].reverse().find((item) => item.workerId === input.workerId && !isTerminalAssignment(item))
    ?? [...mission.assignments].reverse().find((item) => item.workerId === input.workerId)
  if (!assignment) return null
  if (assignment.state === 'cancelled' || assignment.state === 'done') return { mission, assignment, changed: false }

  const reason = input.reason?.trim() || 'Dispatch failed before a worker checkpoint was recorded.'
  const blockedAt = now()
  const checkpoint: ParsedSwarmCheckpoint = {
    stateLabel: 'BLOCKED',
    runtimeState: 'blocked',
    checkpointStatus: 'blocked',
    filesChanged: 'none',
    commandsRun: 'none',
    result: null,
    blocker: reason,
    nextAction: 'Fix blocker and retry dispatch.',
    raw: `STATE: BLOCKED\nFILES_CHANGED: none\nCOMMANDS_RUN: none\nRESULT: none\nBLOCKER: ${reason}\nNEXT_ACTION: Fix blocker and retry dispatch.`,
  }
  const changed = assignment.state !== 'blocked' || assignment.checkpoint?.raw !== checkpoint.raw
  assignment.state = 'blocked'
  assignment.completedAt = blockedAt
  assignment.checkpoint = checkpoint
  const report = reportFromCheckpoint({
    missionId: mission.id,
    assignmentId: assignment.id,
    workerId: input.workerId,
    checkpoint,
    source: input.source,
  })
  if (changed) {
    mission.events.push(event('blocked', `${input.workerId} blocked: ${reason}`, {
      workerId: input.workerId,
      assignmentId: assignment.id,
      data: report,
    }))
  }
  mission.updatedAt = blockedAt
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return { mission, assignment, changed }
}

export function appendMissionContinuation(input: {
  missionId?: string | null
  workerId: string
  task: string
  rationale: string
}): SwarmMission | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  if (mission.state === 'cancelled') return null
  const id = shortId('assign')
  mission.assignments.push({
    id,
    workerId: input.workerId,
    task: input.task,
    rationale: input.rationale,
    dependsOn: [],
    reviewRequired: false,
    state: 'queued',
    dispatchedAt: null,
    completedAt: null,
    reviewedAt: null,
    reviewedBy: null,
    checkpoint: null,
  })
  mission.events.push(event('continuation', `Queued continuation ${id} for ${input.workerId}`, { workerId: input.workerId, assignmentId: id }))
  mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return mission
}

export function readyQueuedAssignments(missionId: string): Array<SwarmMissionAssignment> {
  const mission = getSwarmMission(missionId)
  if (!mission) return []
  const doneIds = new Set(mission.assignments.filter((item) => ['checkpointed', 'done'].includes(item.state)).map((item) => item.id))
  return mission.assignments.filter((item) => item.state === 'queued' && item.dependsOn.every((id) => doneIds.has(id)))
}

export function cancelSwarmAssignment(input: {
  missionId?: string | null
  assignmentId?: string | null
  workerId?: string | null
  actor?: string | null
  reason?: string | null
}): { mission: SwarmMission; assignment: SwarmMissionAssignment; changed: boolean } | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  const assignment = (input.assignmentId
    ? mission.assignments.find((item) => item.id === input.assignmentId)
    : null)
    ?? (input.workerId ? [...mission.assignments].reverse().find((item) => item.workerId === input.workerId && !isTerminalAssignment(item)) : null)
    ?? null
  if (!assignment) return null
  if (assignment.state === 'cancelled') return { mission, assignment, changed: false }
  const cancelledAt = now()
  assignment.state = 'cancelled'
  assignment.completedAt = cancelledAt
  assignment.reviewedAt = cancelledAt
  assignment.reviewedBy = input.actor?.trim() || 'system-cancel'
  mission.events.push(event('assignment_cancelled', `Cancelled ${assignment.id}${input.reason ? `: ${input.reason}` : ''}`, {
    workerId: assignment.workerId,
    assignmentId: assignment.id,
    data: {
      actor: input.actor?.trim() || 'system-cancel',
      reason: input.reason?.trim() || null,
    },
  }))
  mission.updatedAt = cancelledAt
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return { mission, assignment, changed: true }
}

export function cancelSwarmMission(input: {
  missionId?: string | null
  actor?: string | null
  reason?: string | null
}): { mission: SwarmMission; cancelledAssignmentIds: Array<string>; changed: boolean } | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  const cancelledAt = now()
  const cancelledAssignmentIds: Array<string> = []
  for (const assignment of mission.assignments) {
    if (isTerminalAssignment(assignment)) continue
    assignment.state = 'cancelled'
    assignment.completedAt = cancelledAt
    assignment.reviewedAt = cancelledAt
    assignment.reviewedBy = input.actor?.trim() || 'system-cancel'
    cancelledAssignmentIds.push(assignment.id)
  }
  mission.state = 'cancelled'
  mission.updatedAt = cancelledAt
  mission.events.push(event('mission_cancelled', `Cancelled mission${input.reason ? `: ${input.reason}` : ''}`, {
    data: {
      actor: input.actor?.trim() || 'system-cancel',
      reason: input.reason?.trim() || null,
      cancelledAssignmentIds,
    },
  }))
  writeStore(store)
  return { mission, cancelledAssignmentIds, changed: cancelledAssignmentIds.length > 0 }
}

export function markMissionAssignmentReviewed(input: { missionId?: string | null; assignmentId: string; reviewerId?: string }): SwarmMission | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  const assignment = mission.assignments.find((item) => item.id === input.assignmentId)
  if (!assignment) return null
  if (assignment.native) return mission
  assignment.state = 'done'
  assignment.reviewedAt = now()
  assignment.reviewedBy = input.reviewerId ?? null
  mission.events.push(event('review', `Reviewed ${assignment.id}${input.reviewerId ? ` by ${input.reviewerId}` : ''}`, { workerId: input.reviewerId, assignmentId: assignment.id }))
  mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return mission
}

export function markMissionAssignmentsReviewedByWorker(input: {
  missionId?: string | null
  reviewerId: string
  excludeAssignmentId?: string | null
}): { mission: SwarmMission; reviewedAssignmentIds: Array<string> } | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null

  const reviewedAt = now()
  const reviewed = mission.assignments.filter((assignment) => (
    assignment.id !== input.excludeAssignmentId
    && assignment.workerId !== input.reviewerId
    && assignment.reviewRequired
    && !assignment.native
    && assignment.state === 'checkpointed'
  ))

  if (reviewed.length === 0) return { mission, reviewedAssignmentIds: [] }

  for (const assignment of reviewed) {
    assignment.state = 'done'
    assignment.reviewedAt = reviewedAt
    assignment.reviewedBy = input.reviewerId
    mission.events.push(event('review', `Reviewed ${assignment.id} by ${input.reviewerId}`, {
      workerId: input.reviewerId,
      assignmentId: assignment.id,
    }))
  }

  mission.updatedAt = reviewedAt
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return { mission, reviewedAssignmentIds: reviewed.map((assignment) => assignment.id) }
}

/** Persist the attempt BEFORE crossing the admission boundary; an ambiguous attempt is never replayed. */
export function assertNoNativeReservation(workerId: string, exceptAssignmentId?: string): void {
  if (readStore().missions.some((entry) => entry.assignments.some((item) => item.id !== exceptAssignmentId && item.workerId === workerId && item.native && ['submitting', 'queued', 'started', 'unknown'].includes(item.native.status)))) throw new SwarmDispatchError(`profile_reserved; existing work preserved: ${workerId}`, 409)
}

/** Any non-terminal native work already bound to this exact session, in any mission. */
function sessionReserved(store: SwarmMissionStore, sessionId: string, exceptAssignmentId: string): boolean {
  return store.missions.some((entry) => entry.assignments.some((item) => item.id !== exceptAssignmentId
    && (item.native?.sessionId === sessionId || item.sessionBinding?.sessionId === sessionId)
    && item.native && RESERVED_NATIVE_STATUSES.includes(item.native.status)))
}

function admissionBoundElsewhere(store: SwarmMissionStore, admissionId: string, missionId: string, assignmentId: string): boolean {
  return store.missions.some((entry) => entry.assignments.some((item) => !(entry.id === missionId && item.id === assignmentId)
    && (item.native?.admissionId === admissionId || item.native?.report?.admissionId === admissionId)))
}

export function stageNativeAssignment(missionId: string, assignmentId: string, native: NativeAssignment, existingSessionAuthority?: ExistingSessionAuthority): void {
  const store = readStore()
  const mission = store.missions.find((item) => item.id === missionId)
  const assignment = mission?.assignments.find((item) => item.id === assignmentId)
  if (!mission || !assignment) throw new Error('native_assignment_not_dispatchable')
  assertStageable(store, mission, assignment, native, existingSessionAuthority)
  assignment.native = native
  mission.updatedAt = now()
  writeStore(store)
}

/** Every staging rule, checked against the latest store before anything is reserved. */
function assertStageable(store: SwarmMissionStore, mission: SwarmMission, assignment: SwarmMissionAssignment, native: NativeAssignment, existingSessionAuthority?: ExistingSessionAuthority): void {
  const assignmentId = assignment.id
  if (assignment.native || assignment.state !== 'queued') throw new Error('native_assignment_not_dispatchable')
  assertNoNativeReservation(assignment.workerId, assignmentId)
  // B2: recheck the LATEST store (after any awaited work) before reserving the session.
  const binding = assignment.sessionBinding
  if (binding) requireExistingSessionAuthority(existingSessionAuthority, binding.sessionId)
  if (Boolean(binding) !== (native.binding === 'existing-session')
      || (binding && (native.sessionId !== binding.sessionId || native.admissionId !== null))) throw new SwarmDispatchError('session_binding_immutable', 409)
  if (binding) {
    assertSessionBindingEligible(assignment)
    assertExistingAssignmentDependencies(assignment, mission.assignments)
    if (sessionReserved(store, binding.sessionId, assignmentId)) throw new SwarmDispatchError('existing_session_reserved; existing work preserved', 409)
  }
}

function sameFence(left: NativeInputBinding['idle_fence'] | undefined, right: NativeInputBinding['idle_fence'] | undefined): boolean {
  return left === null ? right === null : Boolean(left && right && Object.keys(left).length === 1 && Object.keys(right).length === 1
    && Number.isInteger(left.expected_generation) && left.expected_generation === right.expected_generation)
}

/**
 * C2: persist the owner's exact prepared binding for a staged, not-yet-submitted assignment. Only
 * the shape `prompt.prepare_input` returns for THIS request/profile/session is accepted; a binding is
 * written once and never replaced (an identical one is a no-op).
 */
export function recordInputBinding(missionId: string, assignmentId: string, binding: unknown): void {
  const store = readStore()
  const mission = store.missions.find((item) => item.id === missionId)
  const assignment = mission?.assignments.find((item) => item.id === assignmentId)
  const native = assignment?.native
  if (!isInputBinding(binding)) throw new SwarmDispatchError('input_binding_rejected', 409)
  const fence = binding.idle_fence
  if (!mission || !assignment || !native || mission.state === 'cancelled' || assignment.state === 'cancelled'
      || native.status !== 'submitting' || native.admissionId !== null || native.binding !== 'existing-session'
      || binding.input_id !== native.requestId
      || binding.ref.profile_id !== native.profileId || binding.ref.session_id !== native.sessionId
      || binding.ref.session_id !== assignment.sessionBinding?.sessionId
      || !fence || !Number.isInteger(fence.expected_generation) || fence.expected_generation < 0 || Object.keys(fence).length !== 1) {
    throw new SwarmDispatchError('input_binding_rejected', 409)
  }
  const exact: NativeInputBinding = {
    version: 'original-input-lookup-v1', ref: { profile_id: binding.ref.profile_id, session_id: binding.ref.session_id },
    input_id: binding.input_id, principal_binding: binding.principal_binding, payload_fingerprint: binding.payload_fingerprint,
    idle_fence: { expected_generation: fence.expected_generation },
  }
  if (native.inputBinding) {
    if (JSON.stringify(native.inputBinding) !== JSON.stringify(exact)) throw new SwarmDispatchError('input_binding_immutable', 409)
    return
  }
  native.inputBinding = exact
  mission.updatedAt = now()
  writeStore(store)
}

/**
 * C2 reconciliation of a lost ACK through the owner's read-only `prompt.lookup_input`. Binds the
 * admission id exactly once, and only on positive exact evidence for the persisted binding. A missing,
 * mismatched, not-found, unavailable, foreign or already-bound answer changes NOTHING (the row stays
 * sticky UNKNOWN with its reservation). Status/terminal transitions stay with the ordinary exact
 * receipt inspection that follows; this never unlocks, resubmits, mints a key or creates a session.
 */
export function applyInputLookup(missionId: string, assignmentId: string, observation: NativeObservation): boolean {
  const store = readStore()
  const mission = store.missions.find((item) => item.id === missionId)
  const assignment = mission?.assignments.find((item) => item.id === assignmentId)
  const native = assignment?.native
  const binding = native?.inputBinding
  const lookup = observation.lookup
  if (!isInputBinding(binding) || !isPositiveInputLookup(lookup)) return false
  const admission = lookup.admission
  if (!mission || !assignment || !native
      || mission.state === 'cancelled' || assignment.state === 'cancelled'
      || native.admissionId !== null || !['submitting', 'unknown'].includes(native.status) || native.binding !== 'existing-session'
      || observation.error || observation.profileId !== native.profileId || observation.sessionId !== binding.ref.session_id
      || lookup.ref.profile_id !== native.profileId || lookup.ref.session_id !== native.sessionId
      || lookup.ref.session_id !== assignment.sessionBinding?.sessionId || binding.ref.session_id !== native.sessionId
      || lookup.input_id !== native.requestId || binding.input_id !== native.requestId
      || lookup.principal_binding !== binding.principal_binding
      || lookup.proof.payload_fingerprint !== binding.payload_fingerprint || !sameFence(lookup.proof.idle_fence, binding.idle_fence)
      || typeof admission.admission_id !== 'string' || !admission.admission_id
      || !['queued', 'started', 'unknown', 'terminal'].includes(admission.status)
      || admissionBoundElsewhere(store, admission.admission_id, missionId, assignmentId)) return false
  native.admissionId = admission.admission_id
  native.executionGeneration = admission.execution_generation
  if (admission.status !== 'terminal') native.status = admission.status  // still reserved; terminal waits for exact inspection
  native.observedAt = now()
  mission.events.push(event('assignment_dispatched', `Lost ACK reconciled by exact original-input lookup for ${assignmentId}`, {
    assignmentId, workerId: assignment.workerId,
    data: { requestId: native.requestId, sessionId: native.sessionId, admissionId: admission.admission_id, source: 'original-input-lookup-v1', status: admission.status, settled: lookup.settled === true },
  }))
  mission.updatedAt = now()
  writeStore(store)
  return true
}

function captureNativeReport(mission: SwarmMission, assignment: SwarmMissionAssignment, observation: NativeObservation): boolean {
  const native = assignment.native!
  const body = observation.finalText
  // The bridge caps text at 200k characters. Reject that boundary rather than
  // accepting a potentially truncated body; never normalize the saved Markdown.
  if (native.report || observation.awaitingHuman || typeof body !== 'string' || !body.trim() || body.length >= 200_000 || Buffer.byteLength(body, 'utf8') > 200_000) return false
  const report: NativeReport = {
    body, sha256: createHash('sha256').update(body, 'utf8').digest('hex'), utf8Bytes: Buffer.byteLength(body, 'utf8'),
    profileId: native.profileId, sessionId: native.sessionId!, admissionId: native.admissionId!,
    outcome: 'completed', executionGeneration: observation.receipt?.execution_generation ?? native.executionGeneration ?? null,
    source: 'native-admission-inspect', completedAt: assignment.completedAt, observedAt: now(),
  }
  native.report = report
  mission.events.push(event('native_report', 'Native report captured; delivery/code acceptance is separate', {
    assignmentId: assignment.id, workerId: assignment.workerId,
    data: { sha256: report.sha256, utf8Bytes: report.utf8Bytes, profileId: report.profileId, sessionId: report.sessionId, admissionId: report.admissionId, executionGeneration: report.executionGeneration, completedAt: report.completedAt },
  }))
  return true
}

export type NativeReportReconciliation = { missionId: string; assignmentId: string; profileId: string; sessionId: string; admissionId: string; expectedSha256: string }

/** Existing graph/review references cannot be satisfied by retyping a legacy report. */
export function reportHasConsumers(mission: SwarmMission, assignment: SwarmMissionAssignment): boolean {
  return mission.assignments.some((other) => other.id !== assignment.id && (
    other.dependsOn.includes(assignment.id)
    // reviewedBy names a worker, not an assignment. Treat its recorded review
    // relationship conservatively rather than guessing which worker turn it used.
    || (other.reviewedAt != null && other.reviewedBy === assignment.workerId)
  )) || mission.events.some((entry) => entry.type === 'review' && (
    entry.assignmentId === assignment.id || entry.data?.reviewAssignmentId === assignment.id
    || (Boolean(assignment.native?.sessionId && assignment.native.admissionId)
      && entry.data?.sessionId === assignment.native?.sessionId && entry.data?.admissionId === assignment.native?.admissionId)
  ))
}

/** Explicit authenticated operator clarification of an untyped legacy contract, never text inference. */
export function reconcileReportIntent(input: NativeReportReconciliation): SwarmMission {
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  const assignment = mission?.assignments.find((item) => item.id === input.assignmentId)
  const native = assignment?.native
  const report = native?.report
  if (!mission || !assignment || !native || mission.executionMode !== 'native' || mission.state === 'cancelled' || assignment.state === 'cancelled'
      || reportHasConsumers(mission, assignment)
      || assignment.deliveryKind === 'code' || native.artifact || assignment.checkpoint || assignment.dependsOn.length || assignment.reviewedAt != null || assignment.reviewedBy != null
      || native.status !== 'terminal' || native.outcome !== 'completed'
      || native.profileId !== input.profileId || native.sessionId !== input.sessionId || native.admissionId !== input.admissionId
      || !report || !/^[a-f0-9]{64}$/.test(input.expectedSha256) || report.sha256 !== input.expectedSha256
      || report.profileId !== native.profileId || report.sessionId !== native.sessionId || report.admissionId !== native.admissionId
      || report.outcome !== 'completed' || typeof report.body !== 'string' || !report.body.trim() || report.body.length >= 200_000
      || report.utf8Bytes !== Buffer.byteLength(report.body, 'utf8') || report.utf8Bytes > 200_000
      || createHash('sha256').update(report.body, 'utf8').digest('hex') !== report.sha256
      || (native.executionGeneration != null && report.executionGeneration !== native.executionGeneration)
      || typeof assignment.completedAt !== 'number' || report.completedAt !== assignment.completedAt) throw new SwarmDispatchError('exact_report_only_reconciliation_required', 409)
  if (assignment.deliveryKind === 'report' && assignment.state === 'done') return mission
  assignment.deliveryKind = 'report'
  assignment.state = 'done'
  // Keep original completedAt, native observation/ownership and code-review fields.
  mission.events.push(event('report_reconciled', 'Operator explicitly reconciled report-only delivery; no code acceptance or new execution', { assignmentId: assignment.id, workerId: assignment.workerId, data: { sha256: report.sha256, admissionId: report.admissionId } }))
  mission.state = deriveMissionState(mission.assignments); mission.updatedAt = now()
  writeStore(store)
  return mission
}

export function recordNativeObservation(missionId: string, assignmentId: string, observation: NativeObservation, reconcilingReport = false): void {
  const store = readStore()
  const mission = store.missions.find((item) => item.id === missionId)
  const assignment = mission?.assignments.find((item) => item.id === assignmentId)
  if (!mission || !assignment?.native || mission.state === 'cancelled' || assignment.state === 'cancelled') return
  // Inspect is awaited: recheck this fresh store snapshot before reconciliation
  // can backfill a body/event. Ordinary result rendering remains unchanged.
  if (reconcilingReport && reportHasConsumers(mission, assignment)) throw new SwarmDispatchError('report_has_downstream_or_review_consumers', 409)
  const native = assignment.native
  const receipt = observation.receipt
  // B2: the exact requested session and a NEW admission, never one already bound elsewhere.
  const binding = assignment.sessionBinding
  // The first receipt must come from the accepted idle-admission-v1 fenced submit itself.
  const freshFence = Boolean(native.admissionId) || (observation.preflight?.atomicIdleFence === true
    && observation.preflight.idleVerified === true && observation.preflight.capability === 'idle-admission-v1'
    && typeof observation.preflight.executionGeneration === 'number')
  const bindingMatches = !binding || Boolean(receipt && native.binding === 'existing-session'
    && native.sessionId === binding.sessionId && observation.sessionId === binding.sessionId
    && receipt.ref?.session_id === binding.sessionId && freshFence
    && !admissionBoundElsewhere(store, receipt.admission_id, missionId, assignmentId))
  const identityMatches = bindingMatches && receipt && observation.profileId === native.profileId
    && receipt.ref?.profile_id === native.profileId && receipt.ref?.session_id === observation.sessionId
    && (!native.sessionId || native.sessionId === observation.sessionId)
    && (!native.admissionId || native.admissionId === receipt.admission_id)
    && (native.executionGeneration == null || native.executionGeneration === receipt.execution_generation)
  // Only missing result data may be backfilled on an exact immutable terminal
  // receipt. No reopened execution, changed time/owner/outcome or overwritten body.
  if (native.status === 'terminal' || isTerminalAssignment(assignment)) {
    if (!observation.error && identityMatches && receipt.status === 'terminal' && receipt.outcome === 'completed' && native.outcome === 'completed'
        && (native.executionGeneration == null || native.executionGeneration === receipt.execution_generation)
        && captureNativeReport(mission, assignment, observation)) {
      if (assignment.deliveryKind === 'report' && !native.artifact) assignment.state = 'done'
      mission.state = deriveMissionState(mission.assignments); mission.updatedAt = now(); writeStore(store)
    }
    return
  }
  const before = JSON.stringify({ state: assignment.state, status: native.status, outcome: native.outcome, checkpoint: assignment.checkpoint, admissionId: native.admissionId, lastSequence: native.lastSequence })
  if (observation.error || !identityMatches) {
    if (observation.profileId === native.profileId && typeof observation.sessionId === 'string' && !native.sessionId) native.sessionId = observation.sessionId
    native.status = observation.notAdmitted === true && !native.admissionId ? 'not_admitted' : 'unknown'
    assignment.state = native.status === 'not_admitted' ? 'blocked' : 'needs_input'
    mission.events.push(event('blocked', observation.error || (bindingMatches ? 'native_identity_mismatch' : 'existing_session_binding_mismatch'), { assignmentId, workerId: assignment.workerId }))
  } else {
    if (binding && observation.preflight && !native.preflight) {
      native.preflight = { ...observation.preflight }
      mission.events.push(event('assignment_dispatched', `New admission in existing session for ${assignmentId}`, {
        assignmentId, workerId: assignment.workerId,
        data: { requestId: native.requestId, sessionId: binding.sessionId, admissionId: receipt.admission_id, preflight: native.preflight },
      }))
    }
    native.sessionId = observation.sessionId!
    native.admissionId = receipt.admission_id
    native.status = receipt.status
    native.observedAt = now()
    native.outcome = receipt.outcome
    native.executionGeneration = receipt.execution_generation
    native.model = observation.model || native.model
    native.provider = observation.provider || native.provider
    native.reasoningEffort = observation.reasoningEffort || native.reasoningEffort
    native.lastSequence = observation.lastSequence ?? native.lastSequence
    native.replayEpoch = observation.replayEpoch ?? native.replayEpoch
    assignment.state = receipt.status === 'queued' ? 'queued' : receipt.status === 'started' ? 'dispatched' : 'needs_input'
    if (receipt.status === 'started') assignment.dispatchedAt ??= now()
    if (observation.awaitingHuman) assignment.state = 'needs_input'
    if (receipt.status === 'terminal') {
      const checkpoint = assignment.deliveryKind !== 'report' && observation.finalText ? parseSwarmCheckpoint(observation.finalText) : null
      assignment.checkpoint = checkpoint
      assignment.completedAt ??= now()
      // A completed model turn is not a completed task. Require its scoped checkpoint and artifact.
      assignment.state = receipt.outcome === 'completed' ? 'needs_input' : ['cancelled', 'interrupted'].includes(receipt.outcome || '') ? 'cancelled' : 'blocked'
      if (receipt.outcome === 'completed') {
        captureNativeReport(mission, assignment, observation)
        if (assignment.deliveryKind === 'report' && native.report && !observation.awaitingHuman) assignment.state = 'done'
      }
      if (receipt.outcome === 'completed' && checkpoint?.stateLabel === 'DONE') {
        let delivery: { artifact?: NativeAssignment['artifact']; review?: { assignmentId: string; revision: string; sha256: string; verdict: string } } = {}
        try { delivery = JSON.parse(observation.finalText?.match(/^SWARM_DELIVERY: (.+)$/m)?.[1] || '{}') } catch { /* missing evidence remains gated */ }
        const artifact = delivery.artifact
        if (artifact && /^[0-9a-f]{40}$/.test(artifact.revision) && /^[0-9a-f]{64}$/.test(artifact.sha256) && typeof artifact.path === 'string' && artifact.path.length > 0) {
          native.artifact ??= { revision: artifact.revision, sha256: artifact.sha256, path: artifact.path }
          assignment.state = assignment.reviewRequired ? 'checkpointed' : 'done'
          if (assignment.workerId === 'argus-reviewer' && assignment.dependsOn.length > 0) {
            assignment.state = 'needs_input'
            const review = delivery.review
            const target = mission.assignments.find((item) => item.id === review?.assignmentId)
            if (review && ['accepted', 'changes_required'].includes(review.verdict) && target?.native?.artifact && target.workerId !== assignment.workerId
                && native.profileId !== target.native.profileId
                && assignment.dependsOn.includes(target.id) && target.state === 'checkpointed'
                && target.native.status === 'terminal' && target.native.outcome === 'completed'
                && review.revision === target.native.artifact.revision && review.sha256 === target.native.artifact.sha256) {
              const exactReview = { assignmentId: target.id, revision: review.revision, sha256: review.sha256, verdict: review.verdict as 'accepted' | 'changes_required' }
              native.review ??= exactReview
              assignment.state = 'done'
              if (review.verdict === 'accepted') {
                target.state = 'done'
                target.reviewedAt = now()
                target.reviewedBy = assignment.workerId
                assignment.state = 'done'
                mission.events.push(event('review', `Exact artifact accepted by ${assignment.workerId}`, {
                  assignmentId: target.id, workerId: assignment.workerId,
                  data: { artifact: target.native.artifact, reviewAssignmentId: assignment.id, sessionId: native.sessionId, admissionId: native.admissionId },
              }))
              }
            }
          }
        }
      }
      if (checkpoint) mission.events.push(event('checkpoint', `${assignment.workerId}: ${checkpoint.stateLabel}`, {
        assignmentId, workerId: assignment.workerId,
        data: reportFromCheckpoint({ missionId, assignmentId, workerId: assignment.workerId, checkpoint, source: 'native-admission' }),
      }))
    }
  }
  const after = JSON.stringify({ state: assignment.state, status: native.status, outcome: native.outcome, checkpoint: assignment.checkpoint, admissionId: native.admissionId, lastSequence: native.lastSequence })
  if (before !== after) mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
}

export function listSwarmReports(input?: {
  missionId?: string | null
  workerId?: string | null
  limit?: number
}): Array<SwarmCheckpointReport> {
  const limit = Math.max(1, Math.min(500, input?.limit ?? 100))
  const mission = input?.missionId ? getSwarmMission(input.missionId) : null
  const missions = mission ? [mission] : readStore().missions

  return missions
    .flatMap((entry) => entry.events)
    .filter((event) => event.type === 'checkpoint' && event.data)
    .map((event) => event.data as SwarmCheckpointReport)
    .filter((report) => !input?.workerId || report.workerId === input.workerId)
    .sort((a, b) => b.recordedAt - a.recordedAt)
    .slice(0, limit)
}
