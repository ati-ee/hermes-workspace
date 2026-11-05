export type SwarmTask = {
  id: string; title?: string | null; description?: string | null; column?: string | null; status?: string | null
  assignee?: string | null; priority?: string | null; createdAt?: number | null; updatedAt?: number | null
  boardId?: string | null; source?: string | null
}
export type SwarmTaskFeed = { tasks: Array<SwarmTask>; source: string; boardId: string | null }
export class TaskFeedError extends Error {
  constructor(public kind: 'auth_required' | 'offline' | 'error', public loginUrl: string | null = null) { super(kind); this.name = 'TaskFeedError' }
}

/** One bounded metadata read; errors cannot be reinterpreted as an empty healthy board. */
export async function fetchSwarmTaskFeed(workerId: string, signal?: AbortSignal): Promise<SwarmTaskFeed> {
  try {
    const timeout = AbortSignal.timeout(10_000)
    const response = await fetch(`/api/claude-tasks?assignee=${encodeURIComponent(workerId)}&include_done=true`, { cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    const data = await response.json().catch(() => null) as { tasks?: Array<SwarmTask>; source?: string; boardId?: string; login_url?: string } | null
    if (!response.ok) throw new TaskFeedError(response.status === 401 ? 'auth_required' : response.status === 503 ? 'offline' : 'error', data?.login_url === '/dashboard-connect' ? '/dashboard-connect' : response.status === 401 ? '/' : null)
    if (!Array.isArray(data?.tasks) || data.tasks.some((task: SwarmTask | null) => !task || typeof task.id !== 'string')) throw new TaskFeedError('error')
    const seen = new Set<string>()
    const tasks = data.tasks.filter((task) => { const key = JSON.stringify([task.boardId || data.boardId || null, task.id]); if (seen.has(key)) return false; seen.add(key); return true })
    return { tasks, source: data.source || 'existing-task-adapter (unreported backend)', boardId: data.boardId || null }
  } catch (error) {
    if (error instanceof TaskFeedError) throw error
    throw new TaskFeedError('offline')
  }
}
