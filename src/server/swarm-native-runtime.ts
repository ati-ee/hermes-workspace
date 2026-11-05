import { normalizeSwarmRuntime } from './swarm-foundation'
import { readNativeProfileStatus } from './swarm-native-status'
import { rosterByWorkerId } from './swarm-roster'
import { configuredProfile } from './swarm-profile-policy'

/** Compatibility envelope for Swarm consumers; lifecycle fields come only from native evidence. */
export async function nativeRuntimeEntry(workerId: string) {
  const evidence = await readNativeProfileStatus(workerId)
  const profile = configuredProfile(workerId)
  const worker = rosterByWorkerId().get(workerId)
  const state = evidence.state === 'active' ? 'executing' : evidence.state === 'review' ? 'reviewing' : evidence.state === 'completed' ? 'idle' : evidence.state === 'failed' ? 'blocked' : evidence.state === 'waiting' ? 'waiting' : evidence.state
  const runtime = normalizeSwarmRuntime(workerId, {
    role: worker?.role || 'ARGUS profile', state, phase: evidence.state,
    currentTask: evidence.task, sessionId: evidence.sessionId, sessionTitle: evidence.sessionTitle,
    lastOutputAt: null, lastCheckIn: new Date(evidence.observedAt).toISOString(),
    checkpointStatus: evidence.state === 'completed' ? 'done' : evidence.state === 'blocked' || evidence.state === 'failed' ? 'blocked' : evidence.state === 'active' ? 'in_progress' : 'none',
    needsHuman: evidence.state === 'waiting', blockedReason: evidence.error,
  })
  return { ...runtime, source: 'native' as const, displayName: worker?.name || workerId, humanLabel: `${worker?.name || workerId} — ${worker?.role || 'ARGUS profile'}`,
    profilePath: profile.profileHome, pid: null, tmuxSession: null, tmuxAttachable: false, terminalKind: 'none' as const,
    recentLogTail: null, lastSessionStartedAt: null, logPath: null, wrapperPath: null,
    nativeEvidence: evidence, executionState: evidence.state, observedAt: evidence.observedAt,
    session: { sessionId: evidence.sessionId, sessionTitle: evidence.sessionTitle, historySource: 'unavailable' as const, transport: 'unknown' as const, terminalKind: 'none' as const, logPath: null, recentLogTail: null, lastSessionStartedAt: null },
    dispatch: { preferredDelivery: 'native', supportsLiveDispatch: true, supportsOneShotDispatch: false, lastDispatchAt: null, lastDispatchMode: 'native', lastDispatchResult: null },
    lifecycle: { ...runtime, pid: null, tmuxSession: null, tmuxAttachable: false, terminalKind: 'none' as const },
  }
}
