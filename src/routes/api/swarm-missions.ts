import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { SWARM_MISSIONS_PATH, cancelSwarmAssignment, cancelSwarmMission, getSwarmMission, listSwarmMissions, listSwarmReports } from '../../server/swarm-missions'
import { resetSwarmWorkerRuntime } from '../../server/swarm-runtime-reset'
import { SwarmDispatchError, reconcileNativeReport, refreshNativeMission } from '../../server/swarm-native'
import { requireJsonContentType } from '../../server/rate-limit'

type CancelPostBody = {
  profileId?: unknown
  sessionId?: unknown
  admissionId?: unknown
  expectedSha256?: unknown
  action?: unknown
  missionId?: unknown
  assignmentId?: unknown
  workerId?: unknown
  reason?: unknown
  actor?: unknown
  resetWorkers?: unknown
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export const Route = createFileRoute('/api/swarm-missions')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const url = new URL(request.url)
        const id = url.searchParams.get('id')?.trim()
        const limitRaw = Number(url.searchParams.get('limit') ?? 20)
        const limit = Number.isFinite(limitRaw) ? limitRaw : 20
        if (id) await refreshNativeMission(id)
        else for (const mission of listSwarmMissions(limit)) {
          if (mission.assignments.some((assignment) => assignment.native && !['done', 'cancelled'].includes(assignment.state))) await refreshNativeMission(mission.id)
        }
        return json({
          ok: true,
          path: SWARM_MISSIONS_PATH,
          mission: id ? getSwarmMission(id) : null,
          missions: id ? [] : listSwarmMissions(limit),
          reports: id ? listSwarmReports({ missionId: id, limit }) : [],
          fetchedAt: Date.now(),
        })
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        let body: CancelPostBody
        try {
          body = await request.json() as CancelPostBody
        } catch {
          return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
        }
        const action = cleanString(body.action)
        if (action === 'reconcile-report') {
          const csrf = requireJsonContentType(request)
          if (csrf) return csrf
          const fields = ['missionId', 'assignmentId', 'profileId', 'sessionId', 'admissionId', 'expectedSha256'] as const
          if (fields.some((key) => typeof body[key] !== 'string' || !body[key] || body[key].length > 512)) return json({ ok: false, error: 'exact_report_binding_required' }, { status: 400 })
          try {
            const mission = await reconcileNativeReport({ missionId: body.missionId as string, assignmentId: body.assignmentId as string, profileId: body.profileId as string, sessionId: body.sessionId as string, admissionId: body.admissionId as string, expectedSha256: body.expectedSha256 as string })
            return json({ ok: true, action, mission, codeAcceptance: 'NOT_ASSERTED_BY_REPORT' })
          } catch (error) {
            return json({ ok: false, error: error instanceof SwarmDispatchError ? error.message : 'native_report_readback_unavailable; no execution performed' }, { status: error instanceof SwarmDispatchError ? error.status : 409 })
          }
        }
        if (action !== 'cancel') return json({ ok: false, error: 'Unsupported action' }, { status: 400 })
        const missionId = cleanString(body.missionId)
        if (!missionId) return json({ ok: false, error: 'missionId required' }, { status: 400 })
        if (getSwarmMission(missionId)?.assignments.some((assignment) => assignment.native)) return json({ ok: false, error: 'native_control_required; no worker reset or interruption performed' }, { status: 409 })
        const actor = cleanString(body.actor) ?? 'workspace-cancel'
        const reason = cleanString(body.reason) ?? 'Cancelled from Workspace Swarm'
        const assignmentId = cleanString(body.assignmentId)
        const workerId = cleanString(body.workerId)
        const result = assignmentId || workerId
          ? cancelSwarmAssignment({ missionId, assignmentId, workerId, actor, reason })
          : cancelSwarmMission({ missionId, actor, reason })
        if (!result) return json({ ok: false, error: 'Mission or assignment not found' }, { status: 404 })

        const workerIds = new Set<string>()
        if ('assignment' in result) workerIds.add(result.assignment.workerId)
        if ('cancelledAssignmentIds' in result) {
          const cancelledIds = new Set(result.cancelledAssignmentIds)
          for (const assignment of result.mission.assignments) {
            if (cancelledIds.has(assignment.id)) workerIds.add(assignment.workerId)
          }
        }
        if (workerId) workerIds.add(workerId)
        const runtimeResets = body.resetWorkers !== false
          ? Array.from(workerIds).map((id) => resetSwarmWorkerRuntime(id, { actor, reason }))
          : []

        return json({
          ok: true,
          action,
          result,
          runtimeResets,
          cancelledAt: Date.now(),
        })
      },
    },
  },
})
