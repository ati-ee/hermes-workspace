import { SwarmDispatchError } from './swarm-profile-policy'

// Server-only, non-serializable authority. Neither a JSON field nor an auth=true flag can
// authorize a direct helper call. No credential is exported, reflected or newly generated.
const grants = new WeakSet<object>()
export type ExistingSessionAuthority = Readonly<{ sessionIds: ReadonlyArray<string> }>

/**
 * The only issuer of existing-session authority: the existing Workspace login check on THIS
 * request (a password-protected deployment and a valid session cookie), an exact JSON POST and
 * an explicit same-origin browser request. The login module is loaded lazily so store helpers
 * that only verify a grant never read the token store.
 */
export async function authorizeExistingSessions(request: Request | undefined, sessionIds: Array<string>): Promise<ExistingSessionAuthority> {
  const { isAuthenticated, isPasswordProtectionEnabled } = await import('./auth-middleware')
  if (!(request instanceof Request) || request.method !== 'POST' || !isPasswordProtectionEnabled() || !isAuthenticated(request)) throw new SwarmDispatchError('Unauthorized', 401)
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new SwarmDispatchError('JSON content type required', 415)
  // This opt-in needs an explicit same-origin authenticated browser request, including
  // for direct dispatch helper callers. Never infer approval from task text or JSON.
  if (request.headers.get('origin') !== new URL(request.url).origin
      || request.headers.get('sec-fetch-site') === 'cross-site') throw new SwarmDispatchError('same_origin_required', 403)
  if (sessionIds.length === 0 || sessionIds.some((id) => typeof id !== 'string')) throw new SwarmDispatchError('invalid_existing_session_id')
  const authority = Object.freeze({ sessionIds: Object.freeze([...new Set(sessionIds)]) })
  grants.add(authority)
  return authority
}

/** Every reachable existing-session helper path calls this before any store or native effect. */
export function requireExistingSessionAuthority(authority: ExistingSessionAuthority | undefined, sessionId: string): void {
  if (!authority || typeof authority !== 'object' || !grants.has(authority) || !authority.sessionIds.includes(sessionId)) throw new SwarmDispatchError('existing_session_authorization_required', 403)
}

/** The explicitly selected session IDs of a dispatch body (validated again by the dispatcher). */
export function selectedExistingSessionIds(body: unknown): Array<string> {
  const assignments = (body as { assignments?: unknown } | null)?.assignments
  if (!Array.isArray(assignments)) return []
  return assignments.flatMap((item) => (item && typeof item === 'object' && 'existingSessionId' in item ? [(item as { existingSessionId: unknown }).existingSessionId as string] : []))
}
