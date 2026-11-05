import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isConfiguredSwarmProfile } from './swarm-foundation'
let root = ''
afterEach(() => { if (root) { rmSync(root, {recursive:true,force:true}); root = '' } })
describe('Configured profile discovery', () => {
  it('excludes cache/tombstone/empty directories even if they resemble profile storage', () => {
    root = mkdtempSync(join(tmpdir(),'swarm-discovery-'))
    for (const name of ['.deleted','.pytest_cache','hybrid','argus-developer']) mkdirSync(join(root,name))
    for (const name of ['.deleted','.pytest_cache','argus-developer']) writeFileSync(join(root,name,'config.yaml'),'model: configured')
    expect(isConfiguredSwarmProfile(root,'.deleted')).toBe(false)
    expect(isConfiguredSwarmProfile(root,'.pytest_cache')).toBe(false)
    expect(isConfiguredSwarmProfile(root,'hybrid')).toBe(false)
    expect(isConfiguredSwarmProfile(root,'argus-developer')).toBe(true)
    expect(isConfiguredSwarmProfile(root,'../elsewhere')).toBe(false)
  })
  it('preserves legitimate linked profiles and refuses non-file configuration', () => {
    root = mkdtempSync(join(tmpdir(),'swarm-discovery-'))
    mkdirSync(join(root,'actual'));writeFileSync(join(root,'actual','config.yaml'),'model: configured')
    symlinkSync(join(root,'actual'),join(root,'linked'),'dir')
    mkdirSync(join(root,'broken'));mkdirSync(join(root,'broken','config.yaml'))
    expect(isConfiguredSwarmProfile(root,'linked')).toBe(true)
    expect(isConfiguredSwarmProfile(root,'broken')).toBe(false)
  })
})
