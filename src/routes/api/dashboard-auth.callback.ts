import { createFileRoute } from '@tanstack/react-router'
import { dashboardNativeAuth } from '../../server/dashboard-native-auth'

export const Route = createFileRoute('/api/dashboard-auth/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const cookie =
          request.headers
            .get('cookie')
            ?.split(';')
            .map((x) => x.trim())
            .find((x) => x.startsWith('workspace-pkce-flow='))
            ?.slice('workspace-pkce-flow='.length) || ''
        let ok = false
        try {
          if (!url.searchParams.has('error')) {
            await dashboardNativeAuth.complete(
              url.searchParams.get('state') || '',
              url.searchParams.get('code') || '',
              cookie,
              url.origin,
            )
            ok = true
          }
        } catch {
          /* never render/log provider bodies, codes or tokens */
        }
        return new Response(
          `<!doctype html><meta charset="utf-8"><title>Hermes sign-in</title><p>${ok ? 'Sign-in completed. Close this tab and return to the LAN Workspace.' : 'Sign-in failed or expired. Close this tab and restart from the LAN Workspace.'}</p>`,
          {
            status: ok ? 200 : 400,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'Referrer-Policy': 'no-referrer',
              'Content-Security-Policy':
                "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
              'Set-Cookie':
                'workspace-pkce-flow=; HttpOnly; SameSite=Lax; Path=/api/dashboard-auth; Max-Age=0',
            },
          },
        )
      },
    },
  },
})
