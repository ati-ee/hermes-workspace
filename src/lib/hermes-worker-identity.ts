export type HermesProfileIdentity = { name: string; provider: string; model: string }
const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''

export function profileIdentities(payload: unknown): HermesProfileIdentity[] {
  const rows = payload && typeof payload === 'object' && 'profiles' in payload
    ? (payload as {profiles: unknown}).profiles : []
  if (!Array.isArray(rows)) return []
  return rows.flatMap((value: unknown) => {
    if (!value || typeof value !== 'object') return []
    const row = value as Record<string, unknown>
    const name = text(row.name)
    if (!name) return []
    const model = typeof row.model === 'object' && row.model
      ? row.model as Record<string, unknown> : {}
    return [{ name, provider: text(row.provider) || text(model.provider), model: text(row.model) || text(model.default) }]
  })
}

export function configuredRoute(profile?: HermesProfileIdentity): string {
  if (!profile) return 'Profile not found; provider/model unknown'
  return `${profile.provider || 'Provider not configured'} / ${profile.model || 'Model not configured'}`
}

export function workerRouteLabel(worker: {label: string; model?: string | null; raw?: unknown}, profiles: HermesProfileIdentity[]): string {
  if (worker.model && !['auto', 'native-swarm'].includes(worker.model)) {
    const raw = worker.raw && typeof worker.raw === 'object' ? worker.raw as Record<string, unknown> : {}
    const provider = text(raw.provider) || text(raw.modelProvider) || text(raw.billing_provider)
    return `Reported: ${provider || 'provider unreported'} / ${worker.model}`
  }
  const profile = profiles.find(p => p.name === worker.label)
  return profile ? `Configured: ${configuredRoute(profile)}; execution unverified` : configuredRoute()
}
