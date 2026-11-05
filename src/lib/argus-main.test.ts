import { describe, expect, it } from 'vitest'
import { argusMainIdentity, configuredTerminalContext, nativeCrewCounts } from './argus-main'
import type { CrewMember } from '../hooks/use-crew-status'

const member = (id: string, state = 'idle', observedAt = 100_000) => ({ id, displayName: id, profileFound: true, model: 'configured-model', provider: 'configured-provider', nativeEvidence: { workerId: id, profileId: `/synthetic/${id}`, profileReady: true, connected: true, state, observedAt, sessionId: 'synthetic-session', model: 'effective-model', provider: 'effective-provider', reasoningEffort: 'saved-effort' } }) as CrewMember

describe('Main is the existing sole dispatcher, not a renamed default', () => {
  it('keeps configured remote cwd separate from unverified remote execution context', () => {
    const config = { terminal: { backend: 'ssh', cwd: '/synthetic/remote/project', ssh_host: 'synthetic-vps', ssh_key: 'private-field-must-not-project' } }
    const before = JSON.stringify(config)
    expect(configuredTerminalContext(config)).toEqual({ backend: 'ssh', configuredCwd: '/synthetic/remote/project', remoteHost: 'synthetic-vps', effectiveRemoteContext: 'unverified' })
    expect(JSON.stringify(config)).toBe(before)
  })
  it('binds the canonical orchestrator and reports its effective native route/effort', () => {
    expect(argusMainIdentity([member('default', 'active'), member('orchestrator-argus', 'queued')], 100_000)).toMatchObject({ id: 'orchestrator-argus', displayName: 'ARGUS · 00 Orchestrator', state: 'queued', provider: 'effective-provider', model: 'effective-model', reasoningEffort: 'saved-effort', sessionId: 'synthetic-session' })
  })
  it('never falls back to default or treats another worker executing as Main executing', () => {
    expect(argusMainIdentity([member('default', 'active'), member('argus-developer-local', 'active')], 100_000)).toMatchObject({ id: 'orchestrator-argus', state: 'unknown', sessionId: null, model: null })
    expect(argusMainIdentity([member('orchestrator-argus'), member('argus-developer-local', 'active')], 100_000).state).toBe('idle')
  })
  it('separates configured, connected and executing counts, excludes aliases and expires evidence', () => {
    const rows = [member('orchestrator-argus'), member('argus-developer-local', 'active'), member('argus-reviewer', 'queued'), member('argus-validator', 'active', 1), member('.deleted', 'active'), member('argus-developer-local', 'active')]
    expect(nativeCrewCounts(rows, 100_000)).toEqual({ configured: 4, connected: 3, executing: 1, unknown: 1 })
    expect(argusMainIdentity([member('orchestrator-argus', 'active', 1)], 100_000).state).toBe('unknown')
  })
})
