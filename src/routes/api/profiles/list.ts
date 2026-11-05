import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { dashboardAuthResponse } from '../../../server/dashboard-auth-response'
import { isAuthenticated } from '../../../server/auth-middleware'
import { listProfilesWithFallback } from '../../../server/profiles-browser'
import { configuredArgusProfiles } from '../../../server/swarm-profile-policy'
import { visibleArgusIdentities } from '../../../lib/argus-swarm-policy'

export const Route = createFileRoute('/api/profiles/list')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const { profiles, activeProfile } =
            await listProfilesWithFallback()
          const configured = new Set(configuredArgusProfiles({ includePrimary: true }).map((profile) => profile.workerId))
          return json({ profiles: visibleArgusIdentities(profiles).filter((profile) => configured.has(profile.name)), activeProfile })
        } catch (error) {
          const auth = dashboardAuthResponse(error)
          if (auth) return auth
          return json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to list profiles',
              profiles: [],
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
