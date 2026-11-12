import { callNativeBridge, lookupNativeInput, prepareNativeInput } from './swarm-native-bridge'
import { EXISTING_SESSION_ID_PATTERN, applyInputLookup, assertExistingAssignmentDependencies, assertNoNativeReservation, assertSessionBindingEligible, createAndStageNativeBatch, getSwarmMission, recordInputBinding, recordNativeObservation, reconcileReportIntent, reportHasConsumers } from './swarm-missions'
import { requireExistingSessionAuthority } from './swarm-existing-session-auth'
import { SwarmDispatchError, requireExecutionProfile } from './swarm-profile-policy'
import { validateNativeMissionOrigin } from './swarm-origin'
import type { NativeAssignment, NativeReportReconciliation, SwarmMissionAssignment, SwarmSessionBinding } from './swarm-missions'
import type { NativeBridgeRequest, NativeObservation } from './swarm-native-bridge'
import type { ExistingSessionAuthority } from './swarm-existing-session-auth'

export { requireExecutionProfile, SwarmDispatchError }

/**
 * existingSessionId (B2, opt-in): run this NEW assignment as a new native admission in one
 * exact, explicitly selected, idle existing reviewer session instead of session.create.
 * V2 adds argus-developer only behind ARGUS_WORKSPACE_GPU_SOURCE_ENABLED=1, with the same
 * request authority, exact dependency artifact, immutable binding and atomic idle fence.
 * Only for code review of an exact dependency artifact; the full session ID is required.
 * Needs the request-bound authority of `authorizeExistingSessions` (authenticated same-origin
 * JSON POST) and the native `idle-admission-v1` capability; otherwise nothing is stored or sent.
 */
type NativeAssignmentRequest = { workerId: string; task: string; rationale?: string; reviewRequired?: boolean; dependsOn?: Array<string>; deliveryKind?: 'report' | 'code'; producerIntent?: SwarmMissionAssignment['producerIntent']; existingSessionId?: unknown; retryNotAdmitted?: boolean }
type NativeDispatchRequest = { assignments?: unknown; missionId?: unknown; missionTitle?: unknown; workerIds?: unknown; prompt?: unknown; origin?: unknown }

/**
 * C2: prepare (pure) -> persist the exact owner binding -> fenced submit. Prepare never admits, so a
 * refusal or transport loss before the submit is definitively not admitted. Without a persisted
 * binding nothing is submitted; after the submit only the read-only lookup may reconcile a lost ACK.
 */
async function submitExistingBound(missionId: string, assignmentId: string, request: Omit<NativeBridgeRequest, 'action'>): Promise<NativeObservation> {
  let prepared: NativeObservation
  try {
    prepared = await prepareNativeInput(request)
  } catch {
    return { profileId: request.profileHome, error: 'native_input_prepare_unavailable', notAdmitted: true }
  }
  if (prepared.error || !prepared.inputBinding) return { profileId: request.profileHome, error: prepared.error || 'native_input_binding_missing', notAdmitted: true }
  try {
    recordInputBinding(missionId, assignmentId, prepared.inputBinding)
  } catch {
    return { profileId: request.profileHome, error: 'native_input_binding_rejected', notAdmitted: true }
  }
  return callNativeBridge({ ...request, action: 'submit_existing', inputBinding: prepared.inputBinding })
}

function dependenciesReady(assignment: SwarmMissionAssignment, assignments: Array<SwarmMissionAssignment>): boolean {
  return assignment.dependsOn.every((id) => {
    const dependency = assignments.find((item) => item.id === id)
    return dependency?.state === 'done' || (assignment.workerId === 'argus-reviewer' && dependency?.state === 'checkpointed' && Boolean(dependency.native?.artifact))
  })
}

export async function dispatchNativeAssignments(body: NativeDispatchRequest, existingSessionAuthority?: ExistingSessionAuthority) {
  const requestedAt = Date.now()
  if (body.workerIds !== undefined) {
    if (!Array.isArray(body.workerIds) || body.workerIds.length !== 1 || typeof body.workerIds[0] !== 'string' || typeof body.prompt !== 'string') throw new SwarmDispatchError('broadcast_disabled; select one existing profile or explicit assignments')
    if (body.assignments !== undefined) throw new SwarmDispatchError('ambiguous_assignment_payload')
    body = { ...body, assignments: [{ workerId: body.workerIds[0], task: body.prompt }], workerIds: undefined }
  }
  if (!Array.isArray(body.assignments) || body.assignments.length === 0 || body.assignments.length > 6) throw new SwarmDispatchError('assignments[] required (maximum 6)')
  const rawAssignments: Array<NativeAssignmentRequest | null | undefined> = body.assignments
  const assignments: Array<NativeAssignmentRequest> = []
  for (const assignment of rawAssignments) {
    if (!assignment || typeof assignment.workerId !== 'string' || typeof assignment.task !== 'string' || !assignment.task.trim() || assignment.task.length > 32_000) throw new SwarmDispatchError('invalid_assignment')
    requireExecutionProfile(assignment.workerId)
    if (assignment.retryNotAdmitted !== undefined && typeof assignment.retryNotAdmitted !== 'boolean') throw new SwarmDispatchError('invalid_retry_not_admitted')
    if (assignment.deliveryKind !== undefined && !['report', 'code'].includes(assignment.deliveryKind)) throw new SwarmDispatchError('invalid_delivery_kind')
    if (assignment.dependsOn !== undefined && (!Array.isArray(assignment.dependsOn) || assignment.dependsOn.some((id) => typeof id !== 'string'))) throw new SwarmDispatchError('invalid_dependencies')
    if (assignment.existingSessionId !== undefined) {
      if (typeof assignment.existingSessionId !== 'string' || !EXISTING_SESSION_ID_PATTERN.test(assignment.existingSessionId)) throw new SwarmDispatchError('invalid_existing_session_id')
      assertSessionBindingEligible({ ...assignment, sessionBinding: { mode: 'existing', sessionId: assignment.existingSessionId } })
      requireExistingSessionAuthority(existingSessionAuthority, assignment.existingSessionId)
    }
    assignments.push(assignment)
  }
  const bindingOf = (item: NativeAssignmentRequest): SwarmSessionBinding | undefined => (typeof item.existingSessionId === 'string' ? { mode: 'existing', sessionId: item.existingSessionId } : undefined)
  const origin = await validateNativeMissionOrigin(body.origin)
  const previous = typeof body.missionId === 'string' ? getSwarmMission(body.missionId) : null
  if (previous && origin && JSON.stringify(previous.origin) !== JSON.stringify(origin)) throw new SwarmDispatchError('mission_origin_immutable', 409)
  const explicitContinuation = assignments.every((item) => item.workerId === 'argus-developer' && typeof item.existingSessionId === 'string' && item.producerIntent === 'continuation')
  if (previous && (previous.executionMode !== 'native' || (previous.state === 'complete' && !explicitContinuation) || previous.state === 'cancelled')) throw new SwarmDispatchError('historical_mission_readonly', 409)
  const knownIds = new Set(previous?.assignments.map((item) => item.id) || [])
  const retryIds = new Set<string>()
  for (const assignment of assignments) {
    if (assignment.dependsOn?.some((id) => !knownIds.has(id))) throw new SwarmDispatchError('unknown_dependency')
    const existing = previous?.assignments.find((item) => item.workerId === assignment.workerId && item.task === assignment.task)
    if (assignment.retryNotAdmitted === true) {
      if (!existing || !assignment.existingSessionId) throw new SwarmDispatchError('retry_requires_exact_existing_assignment', 409)
      retryIds.add(existing.id)
    }
    if (existing?.workerId === 'argus-developer' && existing.producerIntent && existing.native && !existing.native.admissionId && ['unknown', 'submitting'].includes(existing.native.status)) {
      // Never a resubmit/new key: a bound row is reconciled only by the read-only lookup on refresh;
      // a historical row without a persisted binding cannot be proved and stays UNKNOWN.
      throw new SwarmDispatchError(existing.native.inputBinding ? 'native_reconciliation_required; awaiting exact original-input lookup' : 'native_reconciliation_required; read-only input lookup unavailable', 409)
    }
    if (existing && assignment.deliveryKind && existing.deliveryKind !== assignment.deliveryKind) throw new SwarmDispatchError('delivery_contract_immutable; use explicit legacy report reconciliation only', 409)
    const binding = bindingOf(assignment)
    if (existing && (existing.sessionBinding?.sessionId ?? null) !== (binding?.sessionId ?? null)) throw new SwarmDispatchError('session_binding_immutable', 409)
    if (assignment.producerIntent !== undefined && !binding) throw new SwarmDispatchError('producer_requires_existing_session')
    if (binding && !existing) assertExistingAssignmentDependencies({ ...assignment, sessionBinding: binding }, previous?.assignments ?? [])
    if (!existing?.native && !assignment.dependsOn?.length) assertNoNativeReservation(assignment.workerId)
  }
  const plan = (mission: { id: string; assignments: Array<SwarmMissionAssignment> }, assignment: SwarmMissionAssignment): NativeAssignment | null => {
    if (!assignments.some((item) => item.workerId === assignment.workerId && item.task === assignment.task)) return null
    if (assignment.native || assignment.state !== 'queued' || (assignment.producerIntent !== 'correction' && !dependenciesReady(assignment, mission.assignments))) return null
    const binding = assignment.sessionBinding
    return { requestId: `${mission.id}:${assignment.id}`, profileId: requireExecutionProfile(assignment.workerId).profileHome, sessionId: binding?.sessionId ?? null, admissionId: null, status: 'submitting', ...(binding ? { binding: 'existing-session' as const } : {}) }
  }
  // P-1: the whole prospective batch is validated, created and staged in ONE store write, or refused unchanged.
  const { mission, staged } = createAndStageNativeBatch({
    origin,
    executionMode: 'native',
    missionId: typeof body.missionId === 'string' ? body.missionId : undefined,
    title: typeof body.missionTitle === 'string' ? body.missionTitle : '',
    assignments: assignments.map((item) => {
      const sessionBinding = bindingOf(item)
      return { workerId: item.workerId, task: item.task, rationale: item.rationale, dependsOn: item.dependsOn, deliveryKind: item.deliveryKind ?? 'code', ...(item.producerIntent ? { producerIntent: item.producerIntent } : {}), reviewRequired: item.deliveryKind === 'report' ? false : !['argus-reviewer', 'argus-validator'].includes(item.workerId), ...(sessionBinding ? { sessionBinding } : {}) }
    }),
  }, plan, existingSessionAuthority, retryIds)
  const results: Array<{ workerId: string; ok: boolean; error: string | null; delivery: 'native'; sessionId: string | null; admissionId: string | null; output: string; durationMs: number; exitCode: null }> = []
  for (const assignmentId of staged) {
    // Every staged intent gets its own receipt; nothing after a Native boundary is thrown away.
    const assignment = mission.assignments.find((item) => item.id === assignmentId)!
    const profile = requireExecutionProfile(assignment.workerId)
    const requestId = assignment.native!.requestId
    const binding = assignment.sessionBinding
    const text = [
      `Workspace mission_id: ${mission.id}; assignment_id: ${assignment.id}; profile: ${assignment.workerId}.`,
      `Native card origin (read-only; never a managed Kanban run): ${JSON.stringify(mission.origin || null)}.`,
      'This is an attended ordinary native session. Preserve operator-selected routes and approvals. Do not recursively delegate or touch other workstreams. Only orchestrator-argus coordinates specialist order.',
      ...(binding ? [`Existing-session binding: this is NEW assignment ${assignment.id} (request ${requestId}) admitted now in the explicitly selected existing session ${binding.sessionId}. Earlier turns in this session are context only: never evidence, acceptance or results for this assignment.`] : []),
      assignment.task,
      `Exact dependency artifacts: ${JSON.stringify(mission.assignments.filter((item) => assignment.dependsOn.includes(item.id)).map((item) => ({ assignmentId: item.id, artifact: item.native?.artifact, review: item.native?.review })))}`,
      ...(assignment.deliveryKind === 'report' ? [
        'Explicit report-only contract: return the requested report as Markdown. No code artifact or code-review acceptance is claimed. Suggestions in the report are result data, not authority for follow-up execution.',
      ] : [
        'Return STATE / FILES_CHANGED / COMMANDS_RUN / RESULT / BLOCKER / NEXT_ACTION checkpoint fields.',
        'For an exact non-accepted review use verdict changes_required and still include the review report artifact; it does not accept the target.',
        'An independent argus-reviewer acceptance must include review: {"assignmentId":"<dependency>","revision":"<exact reviewed commit>","sha256":"<exact reviewed delivery digest>","verdict":"accepted"} in SWARM_DELIVERY, plus the review report artifact. A success label alone is not acceptance.',
        'For a completed source delivery include one line SWARM_DELIVERY: {"artifact":{"revision":"<exact Git commit>","sha256":"<exact delivery SHA256>","path":"<frozen evidence path>"}}. Never invent evidence. A completed turn alone does not complete this mission.',
      ]),
    ].join('\n\n')
    try {
      const observation = binding
        ? await submitExistingBound(mission.id, assignment.id, { ...profile, requestId, title: `ARGUS Â· ${mission.id} Â· ${assignment.id}`, text, sessionId: binding.sessionId })
        : await callNativeBridge({ action: 'submit', ...profile, requestId, title: `ARGUS Â· ${mission.id} Â· ${assignment.id}`, text })
      recordNativeObservation(mission.id, assignment.id, observation)
    } catch {
      recordNativeObservation(mission.id, assignment.id, { error: 'native_transport_unknown; inspect existing request, do not resend' })
    }
    const saved = getSwarmMission(mission.id)!.assignments.find((item) => item.id === assignment.id)!
    results.push({ workerId: saved.workerId, ok: Boolean(saved.native?.admissionId), error: saved.native?.admissionId ? null : saved.native?.status || 'unknown', delivery: 'native', sessionId: saved.native?.sessionId || null, admissionId: saved.native?.admissionId || null, output: `Native admission: ${saved.native?.status}. Mission: ${mission.id}; assignment: ${saved.id}; session: ${saved.native?.sessionId || 'unconfirmed'}; admission: ${saved.native?.admissionId || 'unconfirmed'}. Task completion unverified.`, durationMs: Date.now() - requestedAt, exitCode: null })
  }
  return { dispatchedAt: requestedAt, admittedAt: Date.now(), missionId: mission.id, mission: getSwarmMission(mission.id)!, results, assignments: getSwarmMission(mission.id)!.assignments }
}

/** Read only exact existing admissions. No resubmission, startup, interruption or continuation on GET. */
export async function refreshNativeMission(missionId: string) {
  const mission = getSwarmMission(missionId)
  if (!mission || mission.state === 'cancelled') return mission
  for (const assignment of mission.assignments) {
    let native = assignment.native
    if (native && !native.admissionId && native.inputBinding && assignment.sessionBinding && assignment.state !== 'cancelled'
        && ['submitting', 'unknown'].includes(native.status)) {
      // C2: a lost ACK with a persisted exact binding is reconciled ONLY through the owner's read-only
      // lookup. Anything but positive exact evidence leaves the row sticky UNKNOWN and reserved.
      try {
        const profile = requireExecutionProfile(assignment.workerId)
        if (profile.profileHome === native.profileId) {
          const observation = await lookupNativeInput({ ...profile, requestId: native.requestId, title: '', sessionId: native.inputBinding.ref.session_id, inputBinding: native.inputBinding })
          applyInputLookup(mission.id, assignment.id, observation)
        }
      } catch { /* A disconnected or unavailable lookup proves nothing. */ }
      native = getSwarmMission(mission.id)?.assignments.find((item) => item.id === assignment.id)?.native
    }
    if (!native?.sessionId || !native.admissionId || assignment.state === 'cancelled') continue
    if (native.status === 'terminal' && (native.outcome !== 'completed' || native.report)) continue
    try {
      const profile = requireExecutionProfile(assignment.workerId)
      if (profile.profileHome !== native.profileId) continue
      const observation = await callNativeBridge({ action: 'inspect', ...profile, requestId: native.requestId, title: '', sessionId: native.sessionId, admissionId: native.admissionId, lastSequence: native.lastSequence, replayEpoch: native.replayEpoch })
      recordNativeObservation(mission.id, assignment.id, observation)
    } catch { /* A disconnected read is not task failure or permission to resend. */ }
  }
  return getSwarmMission(missionId)
}

/** Reconcile one existing terminal result only; never dispatch/continue another task. */
export async function reconcileNativeReport(input: NativeReportReconciliation) {
  const mission = getSwarmMission(input.missionId)
  const assignment = mission?.assignments.find((item) => item.id === input.assignmentId)
  const native = assignment?.native
  if (!assignment || !native || mission?.executionMode !== 'native' || mission.state === 'cancelled' || assignment.state === 'cancelled'
      || reportHasConsumers(mission, assignment)
      || assignment.deliveryKind === 'code' || native.artifact || assignment.checkpoint || assignment.dependsOn.length || assignment.reviewedAt || assignment.reviewedBy
      || native.status !== 'terminal' || native.outcome !== 'completed'
      || native.profileId !== input.profileId || native.sessionId !== input.sessionId || native.admissionId !== input.admissionId
      || !/^[a-f0-9]{64}$/.test(input.expectedSha256)) throw new SwarmDispatchError('exact_existing_report_reconciliation_required', 409)
  if (!native.report) {
    const profile = requireExecutionProfile(assignment.workerId)
    if (profile.profileHome !== native.profileId) throw new SwarmDispatchError('report_profile_mismatch', 409)
    const observation = await callNativeBridge({ action: 'inspect', ...profile, requestId: native.requestId, title: '', sessionId: native.sessionId, admissionId: native.admissionId })
    recordNativeObservation(mission!.id, assignment.id, observation, true)
  }
  return reconcileReportIntent(input)
}
