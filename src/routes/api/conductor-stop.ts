import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import { deleteSession } from '../../server/claude-api'
import { dashboardFetch, ensureGatewayProbed } from '../../server/gateway-capabilities'
import { cancelSwarmMission, getSwarmMission, listSwarmMissions } from '../../server/swarm-missions'
import { resetSwarmWorkerRuntime } from '../../server/swarm-runtime-reset'
import type { SwarmRuntimeResetResult } from '../../server/swarm-runtime-reset'

export const Route = createFileRoute('/api/conductor-stop')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        try {
          const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
          const sessionKeys = Array.isArray(body.sessionKeys)
            ? body.sessionKeys.filter(
                (value): value is string =>
                  typeof value === 'string' && value.trim().length > 0,
              )
            : []
          const missionIds = Array.isArray(body.missionIds)
            ? body.missionIds.filter(
                (value): value is string =>
                  typeof value === 'string' && value.trim().length > 0,
              )
            : []

          let deleted = 0
          let stoppedMissions = 0
          let cancelledNativeMissions = 0
          const runtimeResets: Array<SwarmRuntimeResetResult> = []
          const nativeMissions = listSwarmMissions(100).filter((mission) => mission.assignments.some((assignment) => assignment.native))
          if (missionIds.some((id) => getSwarmMission(id)?.assignments.some((assignment) => assignment.native))
              || nativeMissions.some((mission) => mission.assignments.some((assignment) => assignment.native?.sessionId && sessionKeys.includes(assignment.native.sessionId)))) {
            return json({ ok: false, error: 'native_control_required; work preserved, use exact session/admission in Desktop' }, { status: 409 })
          }
          const capabilities = await ensureGatewayProbed()
          for (const missionId of missionIds) {
            try {
              const cancelled = cancelSwarmMission({
                missionId,
                actor: 'conductor-stop',
                reason: 'Conductor mission stopped by user',
              })
              if (cancelled) {
                cancelledNativeMissions += 1
                for (const workerId of Array.from(new Set(cancelled.mission.assignments.map((assignment) => assignment.workerId)))) {
                  try {
                    runtimeResets.push(resetSwarmWorkerRuntime(workerId, {
                      actor: 'conductor-stop',
                      reason: `Cancelled native Conductor mission ${missionId}`,
                    }))
                  } catch {
                    // Runtime reset is best-effort; cancellation state is still durable.
                  }
                }
                continue
              }
            } catch {
              // Fall through to dashboard cleanup.
            }

            if (capabilities.dashboard.available && capabilities.conductor) {
              try {
                const res = await dashboardFetch(
                  `/api/conductor/missions/${encodeURIComponent(missionId)}`,
                  { method: 'DELETE' },
                )
                if (res.ok) stoppedMissions += 1
              } catch {
                // Ignore per-mission stop errors so session cleanup still runs.
              }
            }
          }

          for (const sessionKey of sessionKeys) {
            try {
              await deleteSession(sessionKey)
              deleted += 1
            } catch {
              // Ignore per-session delete errors so one bad key doesn't block the rest.
            }
          }

          return json({ ok: true, deleted, stoppedMissions, cancelledNativeMissions, runtimeResets })
        } catch (error) {
          return json(
            {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
