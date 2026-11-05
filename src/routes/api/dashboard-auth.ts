import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { dashboardOwner } from '../../server/dashboard-auth-context'
import {
  DashboardAuthError,
  dashboardNativeAuth,
} from '../../server/dashboard-native-auth'
import {
  CLAUDE_DASHBOARD_URL,
  dashboardFetch,
} from '../../server/gateway-capabilities'

const headers = { 'Cache-Control': 'no-store' }
export const Route = createFileRoute('/api/dashboard-auth')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const owner = dashboardOwner(request)
        if (!owner)
          return json(
            { error: 'Workspace sign-in required' },
            { status: 401, headers },
          )
        try {
          const r = await fetch(`${CLAUDE_DASHBOARD_URL}/api/status`, {
            signal: AbortSignal.timeout(5000),
            redirect: 'error',
          })
          if (!r.ok)
            return json(
              { error: 'Dashboard unavailable' },
              { status: 503, headers },
            )
          const s = await r.json()
          if (new URL(request.url).searchParams.get('verify') === '1') {
            const checks = []
            for (const path of [
              '/api/sessions?limit=1',
              '/api/profiles',
              '/api/plugins/kanban/boards',
            ]) {
              const result = await dashboardFetch(path, {
                signal: AbortSignal.timeout(10_000),
              })
              const data = await result.json().catch(() => ({}))
              checks.push({
                path,
                status: result.status,
                total: data.total ?? null,
                sessions: data.sessions?.length ?? null,
                profiles: data.profiles?.length ?? null,
                boards: data.boards?.length ?? null,
                tasks:
                  data.columns?.reduce(
                    (n: number, c: { tasks: Array<unknown> }) => n + c.tasks.length,
                    0,
                  ) ?? null,
              })
            }
            return json({ checks, authenticatedApiEvidence: true }, { headers })
          }
          return json(
            {
              authRequired: s.auth_required === true,
              ...dashboardNativeAuth.status(owner, CLAUDE_DASHBOARD_URL),
            },
            { headers },
          )
        } catch (error) {
          if (error instanceof DashboardAuthError)
            return json(
              { error: error.message },
              { status: error.status, headers },
            )
          return json(
            { error: 'Dashboard unavailable' },
            { status: 503, headers },
          )
        }
      },
      POST: async ({ request }) => {
        const owner = dashboardOwner(request)
        if (!owner)
          return json(
            { error: 'Workspace sign-in required' },
            { status: 401, headers },
          )
        if (
          request.headers.get('origin') !== new URL(request.url).origin ||
          !request.headers.get('content-type')?.startsWith('application/json')
        )
          return json(
            { error: 'Same-origin JSON request required' },
            { status: 403, headers },
          )
        try {
          if (Number(request.headers.get('content-length') || 0) > 1024)
            return json(
              { error: 'Request too large' },
              { status: 413, headers },
            )
          const raw = await request.text()
          if (raw.length > 1024)
            return json(
              { error: 'Request too large' },
              { status: 413, headers },
            )
          const body = JSON.parse(raw)
          if (body.action === 'start')
            return json(
              await dashboardNativeAuth.start(
                owner,
                CLAUDE_DASHBOARD_URL,
                body.port ?? 19300,
              ),
              { headers },
            )
          if (body.action === 'renew') {
            if (
              !(await dashboardNativeAuth.bearer(
                owner,
                CLAUDE_DASHBOARD_URL,
                true,
              ))
            )
              throw new DashboardAuthError(401)
            return json(
              {
                renewed: true,
                ...dashboardNativeAuth.status(owner, CLAUDE_DASHBOARD_URL),
              },
              { headers },
            )
          }
          if (body.action === 'disconnect') {
            dashboardNativeAuth.disconnect(owner)
            return json({ connected: false }, { headers })
          }
          return json({ error: 'Unknown action' }, { status: 400, headers })
        } catch (e) {
          return json(
            {
              error:
                e instanceof DashboardAuthError
                  ? e.message
                  : 'Authentication request failed',
            },
            {
              status: e instanceof DashboardAuthError ? e.status : 400,
              headers,
            },
          )
        }
      },
    },
  },
})
