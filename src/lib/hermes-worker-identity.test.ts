import { describe, expect, it } from 'vitest'
import { configuredRoute, profileIdentities, workerRouteLabel } from './hermes-worker-identity'

const profiles = profileIdentities({profiles:[
  {name:'argus-developer',provider:'anthropic',model:'claude-opus-5-5',api_key:'never-project'},
  {name:'argus-reviewer',model:{provider:'antigravity',default:'gemini-4-argon-medium'}},
  {name:'parked'},
]})

describe('Hermes worker identity provenance', () => {
  it('uses real profile names and flat or nested provider settings only', () => {
    expect(profiles[0]).toEqual({name:'argus-developer',provider:'anthropic',model:'claude-opus-5-5'})
    expect(profiles[1]).toEqual({name:'argus-reviewer',provider:'antigravity',model:'gemini-4-argon-medium'})
    expect(JSON.stringify(profiles)).not.toContain('never-project')
  })
  it('does not assign an unrelated profile to missing template workers', () => {
    expect(workerRouteLabel({label:'builder',model:'native-swarm'},profiles)).toBe('Profile not found; provider/model unknown')
  })
  it('labels current configuration without claiming past execution', () => {
    expect(workerRouteLabel({label:'argus-developer',model:null},profiles)).toBe('Configured: anthropic / claude-opus-5-5; execution unverified')
  })
  it('prefers recorded runtime route over current configured route', () => {
    expect(workerRouteLabel({label:'argus-developer',model:'actual-fallback',raw:{provider:'other'}},profiles)).toBe('Reported: other / actual-fallback')
  })
  it('does not infer runtime provider from the current config', () => {
    expect(workerRouteLabel({label:'argus-developer',model:'runtime-model'},profiles)).toBe('Reported: provider unreported / runtime-model')
  })
  it('handles parked and unavailable profiles explicitly', () => {
    expect(configuredRoute(profiles[2])).toBe('Provider not configured / Model not configured')
    expect(profileIdentities({error:'auth required'})).toEqual([])
    expect(profileIdentities({profiles:[null,{},'fake']})).toEqual([])
  })
})
