import { beforeEach, describe, expect, it, vi } from 'vitest'
const store = vi.hoisted(() => ({text:''}))
vi.mock('node:fs', () => ({existsSync:()=>true,readFileSync:()=>store.text,writeFileSync:(_path:string,text:string)=>{store.text=text}}))
import { readSwarmRoster, upsertSwarmRosterWorker, rosterByWorkerId } from './swarm-roster'
beforeEach(()=>{store.text='version: 1\nworkers:\n  - id: builder\n    archived: true\n    wrapper: builder:task\n  - id: argus-developer\n    name: ARGUS Developer\n'})
describe('Reversible roster archiving',()=>{
  it('does not resurrect an archived worker from directory fallback',()=>{
    expect(readSwarmRoster(['builder','argus-reviewer']).workers.map(w=>w.id)).toEqual(['argus-developer','argus-reviewer'])
    expect(rosterByWorkerId(['builder'],{includeArchived:true}).get('builder')?.wrapper).toBe('builder:task')
  })
  it('preserves archived metadata across unrelated upserts and can restore visibility',()=>{
    upsertSwarmRosterWorker({id:'argus-reviewer',name:'Reviewer'} as never)
    expect(readSwarmRoster([],{includeArchived:true}).workers.find(w=>w.id==='builder')?.archived).toBe(true)
    expect(readSwarmRoster().workers.some(w=>w.id==='builder')).toBe(false)
    upsertSwarmRosterWorker({id:'builder',name:'Renamed legacy worker'} as never)
    expect(readSwarmRoster().workers.some(w=>w.id==='builder')).toBe(false)
    expect(readSwarmRoster([],{includeArchived:true}).workers.find(w=>w.id==='builder')?.wrapper).toBe('builder:task')
    upsertSwarmRosterWorker({id:'builder',archived:false,wrapper:'builder:task'} as never)
    expect(readSwarmRoster().workers.some(w=>w.id==='builder')).toBe(true)
  })
})
