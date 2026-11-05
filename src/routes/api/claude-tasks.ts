import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import { createClaudeTask, getClaudeTasksBackendMeta, listClaudeTasks } from '../../server/claude-tasks-backend'
import { DashboardAuthError } from '../../server/dashboard-native-auth'
import type { TaskColumn, TaskPriority } from '../../server/claude-tasks-backend'

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function isTaskColumn(value: unknown): value is TaskColumn {
  return (
    value === 'backlog' ||
    value === 'todo' ||
    value === 'in_progress' ||
    value === 'review' ||
    value === 'blocked' ||
    value === 'done'
  )
}

function isTaskPriority(value: unknown): value is TaskPriority {
  return value === 'high' || value === 'medium' || value === 'low'
}

export const Route = createFileRoute('/api/claude-tasks')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return jsonResponse({ error: 'Unauthorized' }, 401)
        }

        const url = new URL(request.url)
        try {
          const tasks = await listClaudeTasks({
          column: url.searchParams.get('column'),
          assignee: url.searchParams.get('assignee'),
          priority: url.searchParams.get('priority'),
          includeDone: url.searchParams.get('include_done') === 'true',
        })

          // This existing proxy reads the Dashboard's default board, not every project.
          const backend = getClaudeTasksBackendMeta()
          return jsonResponse({ tasks, source: backend.id, boardId: backend.id === 'hermes-proxy' ? 'default' : null })
        } catch (error) {
          if (error instanceof DashboardAuthError) return jsonResponse({ error: 'Hermes Dashboard authentication required or unavailable', code: error.status === 401 ? 'dashboard_auth_required' : 'dashboard_auth_unavailable', needs_login: error.status === 401, login_url: '/dashboard-connect' }, error.status)
          return jsonResponse({ error: 'Task metadata unavailable', code: 'task_feed_unavailable' }, 502)
        }
      },

      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return jsonResponse({ error: 'Unauthorized' }, 401)
        }

        try {
          const body = (await request.json()) as Record<string, unknown>
          if (!body.title || typeof body.title !== 'string') {
            return jsonResponse({ error: 'title is required' }, 400)
          }

          const task = await createClaudeTask({
            title: body.title,
            description: typeof body.description === 'string' ? body.description : '',
            column: isTaskColumn(body.column) ? body.column : undefined,
            priority: isTaskPriority(body.priority) ? body.priority : undefined,
            assignee: typeof body.assignee === 'string' ? body.assignee : null,
            tags: Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : [],
            due_date: typeof body.due_date === 'string' ? body.due_date : null,
            created_by: typeof body.created_by === 'string' ? body.created_by : 'user',
          })

          return jsonResponse({ task }, 201)
        } catch (error) {
          if (error instanceof DashboardAuthError) return jsonResponse({ error: 'Hermes Dashboard authentication required or unavailable', code: error.status === 401 ? 'dashboard_auth_required' : 'dashboard_auth_unavailable', needs_login: error.status === 401, login_url: '/dashboard-connect' }, error.status)
          return jsonResponse({ error: 'Invalid request body' }, 400)
        }
      },
    },
  },
})
