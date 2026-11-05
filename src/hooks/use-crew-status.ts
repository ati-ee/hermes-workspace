import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { NativeProfileStatus } from '@/server/swarm-native-status'
import type { TerminalContext } from '@/lib/argus-main'
import { ARGUS_EXECUTION_IDS, executionState } from '@/lib/argus-swarm-policy'

export type CrewPlatformInfo = {
  state: 'connected' | 'disconnected' | string
  updatedAt: string
}

export type CrewMember = {
  terminalContext?: TerminalContext
  reasoningEffort?: string | null
  nativeEvidence?: NativeProfileStatus
  id: string
  displayName: string
  humanLabel?: string
  role: string
  specialty?: string
  mission?: string
  skills?: Array<string>
  capabilities?: Array<string>
  profileFound: boolean
  gatewayState: 'running' | 'stopped' | 'unknown' | string
  processAlive: boolean
  platforms: Record<string, CrewPlatformInfo>
  model: string
  provider: string
  lastSessionTitle: string | null
  lastSessionAt: number | null
  sessionCount: number
  messageCount: number
  toolCallCount: number
  totalTokens: number
  estimatedCostUsd: number | null
  cronJobCount: number
  assignedTaskCount: number
}

export type CrewStatus = {
  crew: Array<CrewMember>
  fetchedAt: number
}

export type CrewOnlineStatus = 'online' | 'offline' | 'unknown'

export function getOnlineStatus(member: CrewMember): CrewOnlineStatus {
  const evidence = member.nativeEvidence
  if (!evidence || !evidence.observedAt || Date.now() - evidence.observedAt > 60_000) return 'unknown'
  return evidence.connected ? 'online' : evidence.state === 'offline' ? 'offline' : 'unknown'
}

export function getCrewExecutionState(member: CrewMember, now = Date.now()) {
  const evidence = member.nativeEvidence
  return executionState({ ...evidence, status: evidence?.state }, now)
}

const QUERY_KEY = ['crew', 'status'] as const
const POLL_INTERVAL_MS = 30_000

async function fetchCrewStatus(): Promise<CrewStatus> {
  const res = await fetch('/api/crew-status')
  if (!res.ok) throw new Error(`Failed to fetch crew status: ${res.status}`)
  return res.json() as Promise<CrewStatus>
}

export function useCrewStatus() {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchCrewStatus,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: 20_000,
  })

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () =>
      document.removeEventListener('visibilitychange', handleVisibility)
  }, [queryClient])

  return {
    crew: (query.data?.crew ?? []).filter((member, index, rows) => ARGUS_EXECUTION_IDS.includes(member.id) && rows.findIndex((row) => row.id === member.id) === index).map((member) => query.isError && member.nativeEvidence ? { ...member, nativeEvidence: { ...member.nativeEvidence, connected: false, state: 'unknown' as const, error: 'workspace_native_status_unavailable' } } : member),
    lastUpdated: query.data?.fetchedAt ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  }
}
