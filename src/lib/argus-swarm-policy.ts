/** Shared identity and evidence rules for ARGUS displays and server discovery. */
export const ARGUS_EXECUTION_IDS: ReadonlyArray<string> = ['orchestrator-argus', 'argus-architect', 'argus-developer', 'argus-developer-local', 'argus-reviewer', 'argus-validator']
export const ARGUS_IDENTITY_IDS: ReadonlyArray<string> = [...ARGUS_EXECUTION_IDS, 'whatsapp', 'default']
export const NATIVE_EVIDENCE_TTL_MS = 60_000

export function visibleArgusIdentities<T extends { name: string; archived?: boolean; exists?: boolean }>(rows: Array<T>): Array<T> {
  const seen = new Set<string>()
  return rows.filter((row) => {
    if (!ARGUS_IDENTITY_IDS.includes(row.name) || row.archived || row.exists === false || seen.has(row.name)) return false
    seen.add(row.name)
    return true
  })
}

export type ExecutionState = 'queued' | 'waiting' | 'active' | 'review' | 'blocked' | 'completed' | 'failed' | 'cancelled' | 'idle' | 'offline' | 'unknown'
export type ExecutionEvidence = { status?: string; observedAt?: number; connected?: boolean; model?: string | null; provider?: string | null }

export function executionState(evidence: ExecutionEvidence, now = Date.now()): ExecutionState {
  if (!evidence.observedAt || now - evidence.observedAt > NATIVE_EVIDENCE_TTL_MS || evidence.observedAt > now + 5_000) return 'unknown'
  if (evidence.status === 'unknown') return 'unknown'
  if (evidence.connected === false) return 'offline'
  if (!evidence.connected) return 'unknown'
  if (evidence.status === 'started' || evidence.status === 'active') return evidence.model && evidence.provider ? 'active' : 'unknown'
  const known: Array<ExecutionState> = ['queued', 'waiting', 'review', 'blocked', 'completed', 'failed', 'cancelled', 'idle']
  return known.includes(evidence.status as ExecutionState) ? evidence.status as ExecutionState : 'unknown'
}

/** Terminal, blocked tracking cards and expired snapshots never inflate active mission counts. */
export function activeMission(mission: { state: string; updatedAt?: number }, now = Date.now()): boolean {
  return ['planning', 'dispatching', 'executing', 'reviewing'].includes(mission.state)
    && Boolean(mission.updatedAt && now - mission.updatedAt <= NATIVE_EVIDENCE_TTL_MS)
}
