import { accessSync, constants, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { ARGUS_EXECUTION_IDS, ARGUS_IDENTITY_IDS } from '../lib/argus-swarm-policy'
import { getHermesRoot, getProfilesDir } from './claude-paths'

export class SwarmDispatchError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'SwarmDispatchError' }
}

/** Read-only: metadata can hide a profile, but cannot mint one or select its runtime route. */
export function configuredProfile(workerId: string, execution = false): { workerId: string; profileHome: string; cwd: string } {
  if (execution && workerId === 'whatsapp') throw new SwarmDispatchError('communication_only: whatsapp')
  type Entry = { id: string; profile?: string; archived?: boolean; defaultCwd?: string }
  let workers: Array<Entry | null>
  try {
    workers = parse(readFileSync(join(process.cwd(), 'swarm.yaml'), 'utf8')).workers
    if (!Array.isArray(workers)) throw new Error('invalid roster')
  } catch { throw new SwarmDispatchError('execution_roster_unavailable', 503) }
  const entries = workers.filter((entry): entry is Entry => entry?.id === workerId)
  if (entries.some((entry) => entry.archived === true)) throw new SwarmDispatchError(`profile_archived: ${workerId}`)
  if (!(execution ? ARGUS_EXECUTION_IDS : ARGUS_IDENTITY_IDS).includes(workerId)) throw new SwarmDispatchError(`profile_not_allowed: ${workerId}`)
  if (workerId !== 'default' && (entries.length !== 1 || (entries[0].profile && entries[0].profile !== workerId))) throw new SwarmDispatchError(`profile_not_configured: ${workerId}`)
  const profileHome = resolve(workerId === 'default' ? getHermesRoot() : join(getProfilesDir(), workerId))
  try {
    if (realpathSync(profileHome) !== profileHome || !lstatSync(profileHome).isDirectory()) throw new Error('profile alias')
    const config = join(profileHome, 'config.yaml')
    if (!lstatSync(config).isFile() || lstatSync(config).isSymbolicLink()) throw new Error('config alias')
    accessSync(config, constants.R_OK)
  } catch { throw new SwarmDispatchError(`profile_not_configured: ${workerId}`) }
  // Native policy selects configured terminal.cwd; metadata must never impose Workspace cwd.
  return { workerId, profileHome, cwd: profileHome }
}

export function requireExecutionProfile(workerId: string) { return configuredProfile(workerId, true) }

export function configuredArgusProfiles(options: { executionOnly?: boolean; includePrimary?: boolean } = {}) {
  const ids = options.executionOnly ? ARGUS_EXECUTION_IDS : ARGUS_IDENTITY_IDS.filter((id) => id !== 'default' || options.includePrimary)
  return ids.flatMap((id) => { try { return [configuredProfile(id, options.executionOnly)] } catch { return [] } })
}
