import { describe, expect, it } from 'vitest'
import { activeMission, executionState, visibleArgusIdentities } from './argus-swarm-policy'

describe('canonical ARGUS visibility and native evidence', () => {
  it('excludes cache, tombstone, archived, parked and duplicate aliases across screens', () => {
    const rows = ['.pytest_cache', '.deleted', '.hidden', 'hybrid', 'codex-mcp-pilot', 'builder', 'argus-developer-local', 'argus-developer-local', 'argus-reviewer', 'whatsapp', 'default'].map(name => ({ name }))
    expect(visibleArgusIdentities(rows).map(row => row.name)).toEqual(['argus-developer-local', 'argus-reviewer', 'whatsapp', 'default'])
    expect(visibleArgusIdentities([{ name: 'argus-reviewer', archived: true }, { name: 'argus-developer', exists: false }])).toEqual([])
  })
  it('does not infer execution from last message, stale runtime, or missing route', () => {
    expect(executionState({ status: 'started', observedAt: 1, connected: true, model: 'm', provider: 'p' }, 100_000)).toBe('unknown')
    expect(executionState({ status: 'started', observedAt: 100_000, connected: false, model: 'm', provider: 'p' }, 100_000)).toBe('offline')
    expect(executionState({ status: 'started', observedAt: 100_000, connected: true }, 100_000)).toBe('unknown')
    expect(executionState({ status: 'runtime.json', observedAt: 100_000, connected: true }, 100_000)).toBe('unknown')
    for (const [status, expected] of [['queued', 'queued'], ['started', 'active'], ['review', 'review'], ['completed', 'completed'], ['failed', 'failed'], ['cancelled', 'cancelled'], ['idle', 'idle']]) {
      expect(executionState({ status, observedAt: 100_000, connected: true, model: 'm', provider: 'p' }, 100_000)).toBe(expected)
    }
    expect(activeMission({ state: 'failed', updatedAt: 1 }, 100_000)).toBe(false)
    expect(activeMission({ state: 'blocked', updatedAt: 1 }, 100_000)).toBe(false)
    expect(activeMission({ state: 'executing', updatedAt: 100_000 }, 100_000)).toBe(true)
    expect(activeMission({ state: 'executing', updatedAt: 1 }, 100_000)).toBe(false)
  })
})
