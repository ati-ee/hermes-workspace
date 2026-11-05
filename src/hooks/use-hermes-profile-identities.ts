import { useQuery } from '@tanstack/react-query'
import { profileIdentities } from '@/lib/hermes-worker-identity'

export function useHermesProfileIdentities() {
  return useQuery({
    queryKey: ['hermes', 'profile-identities'],
    queryFn: async () => {
      const response = await fetch('/api/profiles/list')
      if (!response.ok) throw new Error(`Hermes profile list failed (${response.status})`)
      return profileIdentities(await response.json())
    },
    staleTime: 30_000,
    retry: false,
  })
}
