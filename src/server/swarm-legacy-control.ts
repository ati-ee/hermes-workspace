import { realpathSync } from 'node:fs'
import { basename } from 'node:path'
import { ARGUS_IDENTITY_IDS } from '../lib/argus-swarm-policy'
import { SwarmDispatchError, requireExecutionProfile } from './swarm-profile-policy'

const NATIVE_CONTROL_REQUIRED = 'native_control_required; work preserved, use exact session/admission in Desktop'

/** Guard before any legacy process/paste/bootstrap/config effect, including direct callers. */
export function assertLegacyControlAllowed(workerId: string): void {
  if (ARGUS_IDENTITY_IDS.includes(workerId.replace(/^swarm-/, ''))) throw new SwarmDispatchError(NATIVE_CONTROL_REQUIRED, 409)
}

/** A legacy path alias must not make an existing native profile writable. */
export function assertLegacyProfileWriteAllowed(profilePath: string): void {
  assertLegacyControlAllowed(basename(profilePath))
  let canonical: string
  try { canonical = realpathSync(profilePath) } catch { return }
  assertLegacyControlAllowed(basename(canonical))
}

/** Preserve authentication at the route; refuse native IDs before validating legacy fallbacks. */
export function legacyControlRefusal(...targets: Array<string>): Response | null {
  try {
    for (const id of targets) assertLegacyControlAllowed(id)
    // The execution roster is native-only. Unknown/parked IDs cannot use a legacy side door.
    for (const id of targets) requireExecutionProfile(id)
    return null
  } catch (error) {
    if (!(error instanceof SwarmDispatchError)) throw error
    return Response.json({ ok: false, error: error.message }, { status: error.status })
  }
}
