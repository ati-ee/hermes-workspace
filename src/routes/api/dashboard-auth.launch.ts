import { createFileRoute } from '@tanstack/react-router'
import {
  DashboardAuthError,
  dashboardNativeAuth,
} from '../../server/dashboard-native-auth'

export const Route = createFileRoute('/api/dashboard-auth/launch')({
  server: {
    handlers: {
      GET: ({ request }) => {
        try {
          const url = new URL(request.url)
          const p = dashboardNativeAuth.launch(
            url.searchParams.get('flow') || '',
            url.origin,
          )
          return new Response(null, {
            status: 302,
            headers: {
              Location: p.location,
              'Cache-Control': 'no-store',
              'Referrer-Policy': 'no-referrer',
              'Set-Cookie': `workspace-pkce-flow=${p.cookie}; HttpOnly; SameSite=Lax; Path=/api/dashboard-auth; Max-Age=300`,
            },
          })
        } catch (e) {
          return new Response(
            e instanceof DashboardAuthError ? e.message : 'Login unavailable',
            { status: 400, headers: { 'Cache-Control': 'no-store' } },
          )
        }
      },
    },
  },
})
