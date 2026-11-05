import { DashboardAuthError } from './dashboard-native-auth'
import { dashboardFetch } from './gateway-capabilities'

/** Access authentication is not inference selection. Never expose upstream/private error text. */
export function dashboardAuthResponse(error: unknown): Response | null {
  if (!(error instanceof DashboardAuthError)) return null
  const needsLogin = error.status === 401
  return Response.json({ ok: false, error: needsLogin ? 'Hermes Dashboard authentication required' : 'Hermes Dashboard authentication unavailable', code: needsLogin ? 'dashboard_auth_required' : 'dashboard_auth_unavailable', needs_login: needsLogin, login_url: needsLogin ? '/dashboard-connect' : null }, { status: error.status, headers: { 'Cache-Control': 'no-store' } })
}

/** Only for raw pass-through proxies: preserve structured auth errors and non-auth failures. */
export async function dashboardProxyFetch(path: string, init?: RequestInit): Promise<Response> {
  try { return await dashboardFetch(path, init) } catch (error) {
    const response = dashboardAuthResponse(error)
    if (response) return response
    throw error
  }
}
