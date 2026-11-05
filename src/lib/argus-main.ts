import { ARGUS_EXECUTION_IDS, NATIVE_EVIDENCE_TTL_MS, executionState } from './argus-swarm-policy'
import type { CrewMember } from '../hooks/use-crew-status'

export const ARGUS_MAIN_ID = 'orchestrator-argus'
export const ARGUS_MAIN_DISPLAY_NAME = 'ARGUS · 00 Orchestrator'

export type TerminalContext = { backend: string | null; configuredCwd: string | null; remoteHost: string | null; effectiveRemoteContext: 'unverified' }
/** Project non-secret context only. A path missing locally says nothing about an SSH host. */
export function configuredTerminalContext(config: Record<string, unknown>): TerminalContext {
  const terminal = config.terminal && typeof config.terminal === 'object' ? config.terminal as Record<string, unknown> : {}
  return { backend: typeof terminal.backend === 'string' ? terminal.backend : null, configuredCwd: typeof terminal.cwd === 'string' ? terminal.cwd : null,
    remoteHost: typeof terminal.ssh_host === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(terminal.ssh_host) ? terminal.ssh_host : null, effectiveRemoteContext: 'unverified' }
}

/** Main binds an existing exact profile; a default session is never its fallback. */
export function argusMainIdentity(members: Array<CrewMember>, now = Date.now()) {
  const member = members.find((row) => row.id === ARGUS_MAIN_ID)
  const evidence = member?.nativeEvidence
  const fresh = Boolean(evidence?.observedAt && now - evidence.observedAt <= NATIVE_EVIDENCE_TTL_MS && evidence.observedAt <= now + 5_000)
  return { id: ARGUS_MAIN_ID, displayName: ARGUS_MAIN_DISPLAY_NAME, configured: Boolean(member?.profileFound),
    state: executionState({ ...evidence, status: evidence?.state }, now), connected: fresh && evidence?.connected === true,
    model: evidence?.model || member?.model || null, provider: evidence?.provider || member?.provider || null,
    routeSource: evidence?.model && evidence.provider ? 'Reported native' : 'Configured only',
    reasoningEffort: evidence?.reasoningEffort || member?.reasoningEffort || null,
    sessionId: evidence?.sessionId || null, admissionId: evidence?.admissionId || null,
  }
}

/** Connected/ready is not executing. Count each canonical existing profile once. */
export function nativeCrewCounts(members: Array<CrewMember>, now = Date.now()) {
  const rows = members.filter((row, index) => row.profileFound && ARGUS_EXECUTION_IDS.includes(row.id) && members.findIndex((other) => other.id === row.id) === index)
  return { configured: rows.length,
    connected: rows.filter((row) => row.nativeEvidence?.connected && row.nativeEvidence.observedAt <= now + 5_000 && now - row.nativeEvidence.observedAt <= NATIVE_EVIDENCE_TTL_MS).length,
    executing: rows.filter((row) => executionState({ ...row.nativeEvidence, status: row.nativeEvidence?.state }, now) === 'active').length,
    unknown: rows.filter((row) => executionState({ ...row.nativeEvidence, status: row.nativeEvidence?.state }, now) === 'unknown').length,
  }
}
