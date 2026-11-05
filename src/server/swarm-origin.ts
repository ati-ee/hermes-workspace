import { fetchDashboardKanbanTask } from './kanban-dashboard-proxy'
import { DashboardAuthError } from './dashboard-native-auth'
import { SwarmDispatchError } from './swarm-profile-policy'

export type NativeMissionOrigin = { source: 'native-kanban'; boardId: string; cardId: string }

/** Read an exact existing card, never create/claim/assign/change its lifecycle. */
export async function validateNativeMissionOrigin(value: unknown): Promise<NativeMissionOrigin | undefined> {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object') throw new SwarmDispatchError('invalid_origin_identity')
  const origin = value as Record<string, unknown>
  const identity = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[^A-Za-z0-9_-]/.test(id)
  if (!identity(origin.boardId) || !identity(origin.cardId)) throw new SwarmDispatchError('invalid_origin_identity')
  try {
    const task = await fetchDashboardKanbanTask(origin.cardId, origin.boardId)
    if (!task || task.id !== origin.cardId) throw new SwarmDispatchError('native_origin_not_found', 404)
    if (!['ready', 'todo', 'backlog', 'triage'].includes(task.status)) throw new SwarmDispatchError('card_dispatch_excluded; tracking/history is not an execution admission', 409)
    return { source: 'native-kanban', boardId: origin.boardId, cardId: origin.cardId }
  } catch (error) {
    if (error instanceof DashboardAuthError) throw new SwarmDispatchError(error.status === 401 ? 'dashboard_auth_required; open /dashboard-connect' : 'dashboard_auth_unavailable', error.status)
    if (error instanceof SwarmDispatchError) throw error
    throw new SwarmDispatchError('native_origin_unavailable; no admission attempted', 503)
  }
}
