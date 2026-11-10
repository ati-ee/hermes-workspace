import { executionState } from '../lib/argus-swarm-policy'
import { callNativeBridge } from './swarm-native-bridge'
import { configuredProfile } from './swarm-profile-policy'
import { listSwarmMissions } from './swarm-missions'
import type { ExecutionState } from '../lib/argus-swarm-policy'

export type NativeProfileStatus = {
  workerId: string; profileId: string; profileReady: boolean; connected: boolean
  state: ExecutionState; observedAt: number; source: 'native-session-list'
  sessionId: string | null; sessionTitle: string | null; sessionSource: string | null
  missionId: string | null; assignmentId: string | null; admissionId: string | null
  model: string | null; provider: string | null; task: string | null; error: string | null
  reasoningEffort?: string | null
  sessionCwd?: string | null
  boardId?: string | null; cardId?: string | null
}
const cache = new Map<string, { at: number; value: Promise<NativeProfileStatus> }>()

/** Coalesced bounded reads, not a background poller. No attachment to other workstreams. */
export function readNativeProfileStatus(workerId: string): Promise<NativeProfileStatus> {
  const cached = cache.get(workerId)
  if (cached && Date.now() - cached.at < 5_000) return cached.value
  const value = readStatus(workerId)
  cache.set(workerId, { at: Date.now(), value })
  return value
}

async function readStatus(workerId: string): Promise<NativeProfileStatus> {
  const profile = configuredProfile(workerId)
  const base: NativeProfileStatus = { workerId, profileId: profile.profileHome, profileReady: true, connected: false, state: 'unknown', observedAt: Date.now(), source: 'native-session-list', sessionId: null, sessionTitle: null, sessionSource: null, missionId: null, assignmentId: null, admissionId: null, model: null, provider: null, task: null, error: null }
  try {
    const observed = await callNativeBridge({ action: 'status', ...profile, requestId: '', title: '' })
    if (observed.error || observed.profileId !== profile.profileHome || observed.connected !== true) return { ...base, state: observed.error === 'gateway_not_ready' ? 'offline' : 'unknown', error: observed.error || 'native_identity_unverified' }
    const session = observed.sessions?.find((item) => item.status === 'started') || observed.sessions?.[0]
    const now = Date.now()
    const result = { ...base, observedAt: now, connected: true, sessionId: session?.sessionId || null, sessionTitle: session?.title || null, sessionSource: session?.source || null, model: session?.model || null, provider: session?.provider || null, reasoningEffort: session?.reasoningEffort || null, sessionCwd: session?.sessionCwd || null, task: session?.title || null }
    result.state = executionState({ status: observed.status, observedAt: now, connected: true, model: result.model, provider: result.provider }, now)
    // Only an exact stored native binding can attach a Workspace mission identity to a GUI session.
    // Histories append corrections/continuations. First choose the last exact binding in
    // each mission, then the newest applicable dispatch across missions (not latest review time).
    const candidates = listSwarmMissions(100).flatMap((mission) => {
      const assignment = [...mission.assignments].reverse().find((item) => item.workerId === workerId
        && item.native?.profileId === profile.profileHome && item.native.sessionId === result.sessionId)
      return assignment?.native ? [{ mission, assignment }] : []
    }).sort((a, b) => (b.assignment.dispatchedAt ?? b.mission.createdAt) - (a.assignment.dispatchedAt ?? a.mission.createdAt))
    const current = candidates.at(0)
    if (current?.assignment.native) {
      const { mission, assignment } = current
      const native = assignment.native!
      const live = session?.status === 'started' || ['started', 'active', 'waiting'].includes(observed.status || '')
      // session.list cannot identify a new admission behind a historical terminal turn.
      if (live && native.status === 'terminal') return result
      result.missionId = mission.id
      result.boardId = mission.origin?.boardId || null
      result.cardId = mission.origin?.cardId || null
      result.assignmentId = assignment.id
      result.admissionId = native.admissionId
      result.task = assignment.task
      if (native.status === 'unknown' || native.status === 'submitting') result.state = 'unknown'
      else if (assignment.state === 'needs_input') result.state = 'waiting'
      else if (!live && result.state === 'idle') {
        if (assignment.state === 'checkpointed' && assignment.reviewRequired) result.state = 'review'
        else if (assignment.state === 'done') result.state = 'completed'
        else if (assignment.state === 'cancelled') result.state = 'cancelled'
        else if (native.status === 'terminal') result.state = native.outcome === 'completed' ? 'blocked' : ['cancelled', 'interrupted'].includes(native.outcome || '') ? 'cancelled' : 'failed'
        else if (now - (native.observedAt || mission.updatedAt) <= 60_000 && native.status === 'queued') result.state = 'queued'
      }
    }
    return result
  } catch { return { ...base, error: 'native_status_unavailable' } }
}
