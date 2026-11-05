import { createHash } from 'node:crypto'
import { getRequest } from '@tanstack/react-start/server'
import { getSessionTokenFromCookie, isAuthenticated } from './auth-middleware'
import { dashboardNativeAuth } from './dashboard-native-auth'

export function dashboardOwner(request: Request): string | null {
  if (!isAuthenticated(request)) return null
  const token = getSessionTokenFromCookie(request.headers.get('cookie'))
  return token ? createHash('sha256').update(token).digest('hex') : null
}
export async function requestDashboardBearer(base: string, force = false) {
  let request: Request
  try {
    request = getRequest()
  } catch {
    return null
  } // background capability probes have no user
  const owner = dashboardOwner(request)
  return owner ? dashboardNativeAuth.bearer(owner, base, force) : null
}
