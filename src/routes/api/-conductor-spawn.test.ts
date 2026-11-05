import { describe, expect, it, vi } from 'vitest'
import { NATIVE_CONDUCTOR_MODE_NOTE, buildNativeConductorAssignments, toNativeConductorMissionRecord } from './conductor-spawn'
import type { SwarmMission } from '../../server/swarm-missions'

vi.mock('../../server/gateway-capabilities', () => ({ dashboardFetch: vi.fn(), ensureGatewayProbed: vi.fn() }))

describe('native Conductor fallback', () => {
  it('labels the actual adapter, not a fabricated official managed run', () => {
    expect(NATIVE_CONDUCTOR_MODE_NOTE).toContain('supported Hermes gateway RPC')
    expect(NATIVE_CONDUCTOR_MODE_NOTE).toContain('not a dashboard Conductor managed run')
  })

  it('routes any mission only to the real sole dispatcher, never archived stock lanes', () => {
    const assignments = buildNativeConductorAssignments('Fix conductor and make it production ready', {
      maxParallel: 4,
      supervised: false,
    })

    expect(assignments.map((assignment) => assignment.workerId)).toEqual(['orchestrator-argus'])
    expect(assignments[0].task).toContain('Conductor mission: Fix conductor')
    expect(assignments.every((assignment) => assignment.direct === true)).toBe(true)
    expect(assignments.every((assignment) => assignment.reviewRequired === true)).toBe(true)
  })

  it('does not substitute archived KM Agent for a documentation task', () => {
    const assignments = buildNativeConductorAssignments('Write docs and handoff for the release', {
      maxParallel: 3,
      supervised: true,
    })

    expect(assignments.map((assignment) => assignment.workerId)).toEqual(['orchestrator-argus'])
    expect(assignments[0].task).toContain('attended')
  })

  it('does not interpret a parallelism setting as permission for blanket broadcast', () => {
    const assignments = buildNativeConductorAssignments('Create a small UI prototype', {
      maxParallel: 2,
      supervised: false,
    })

    expect(assignments.map((assignment) => assignment.workerId)).toEqual(['orchestrator-argus'])
  })

  it('normalizes native swarm missions into the Conductor mission status contract', () => {
    const mission: SwarmMission = {
      id: 'conductor-test',
      title: 'Conductor: smoke',
      state: 'executing',
      createdAt: 1,
      updatedAt: 2,
      assignments: [
        {
          id: 'a1',
          workerId: 'builder',
          task: 'Run smoke',
          rationale: 'Builder',
          dependsOn: [],
          reviewRequired: false,
          state: 'dispatched',
          dispatchedAt: 1,
          completedAt: null,
          reviewedAt: null,
          reviewedBy: null,
          checkpoint: null,
        },
      ],
      events: [
        { id: 'e1', type: 'created', at: 1, message: 'Mission created' },
      ],
    }

    const record = toNativeConductorMissionRecord(mission)
    expect(record.id).toBe('conductor-test')
    expect(record.status).toBe('running')
    expect(record.nativeSwarm).toBe(true)
    expect(record.modeOfficialOotb).toBe(false)
    expect(record.modeNote).toBe(NATIVE_CONDUCTOR_MODE_NOTE)
    expect(record.lines.join('\n')).toContain('builder dispatched')
  })
})
