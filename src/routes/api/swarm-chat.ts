import { join } from 'node:path'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { getProfilesDir } from '../../server/claude-paths'
import { readWorkerMessages } from '../../server/swarm-chat-reader'
import { readNativeProfileStatus } from '../../server/swarm-native-status'
import { SwarmDispatchError, requireExecutionProfile } from '../../server/swarm-profile-policy'
import type { SwarmChatMessage } from '../../server/swarm-chat-reader'

type ChatResponse = {
  workerId: string
  sessionId: string | null
  sessionTitle: string | null
  messages: Array<SwarmChatMessage>
  source: 'state.db' | 'unavailable'
  fetchedAt: number
  error?: string
}

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 30

function isValidWorkerId(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)
}

export const Route = createFileRoute('/api/swarm-chat')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const url = new URL(request.url)
        const workerIdRaw = url.searchParams.get('workerId') ?? ''
        if (!workerIdRaw || !isValidWorkerId(workerIdRaw)) {
          return json({ error: 'workerId required' }, { status: 400 })
        }
        const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
        const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT))
        try {
          requireExecutionProfile(workerIdRaw)
          const evidence = await readNativeProfileStatus(workerIdRaw)
          return json({ workerId: workerIdRaw, sessionId: evidence.sessionId, sessionTitle: evidence.sessionTitle, messages: [], source: 'native', nativeEvidence: evidence, fetchedAt: Date.now(), note: 'Scalar native metadata only. Open this profile/session in Desktop for transcript and attended approvals.' })
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : 'native_status_unavailable' }, { status: error instanceof SwarmDispatchError ? error.status : 503 })
        }
      },
    },
  },
})
