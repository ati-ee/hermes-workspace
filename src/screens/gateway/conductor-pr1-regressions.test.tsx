// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { Root } from 'react-dom/client'

vi.mock('@/lib/gateway-api', async original => ({ ...await original<object>(), fetchSessions: vi.fn().mockResolvedValue({ sessions: [] }) }))
vi.mock('@tanstack/react-router', async original => ({ ...await original<object>(), useNavigate: () => vi.fn() }))
const { useConductorGateway } = await import('./hooks/use-conductor-gateway')
const { Conductor } = await import('./conductor')
let api: ReturnType<typeof useConductorGateway>
let root: Root | undefined
let client: QueryClient
let missionStatus: string
let missionReads: number
let posts: Array<Record<string, unknown>>
function Probe() { api = useConductorGateway(); return null }
function savedMission() {
  return { missionId: 'synthetic-current', missionJobId: null, goal: 'Synthetic current goal', phase: 'running',
    missionStartedAt: new Date().toISOString(), isPaused: false, pausedElapsedMs: 0, accumulatedPausedMs: 0,
    pauseStartedAt: null, workerKeys: [], workerLabels: [], workerOutputs: {}, streamText: '', planText: '', completedAt: null, tasks: [] }
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', (globalThis as typeof globalThis & { jsdom: { window: Window } }).jsdom.window.localStorage)
  localStorage.clear(); missionReads=0; posts=[]; missionStatus='waiting'
  client=new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    await Promise.resolve()
    const url=String(input)
    if (url==='/api/conductor-spawn' && init?.method==='POST') {
      const body=JSON.parse(String(init.body)) as Record<string, unknown>; posts.push(body)
      return body.orchestratorModel || body.workerModel ? Response.json({error:'profile_route_override_forbidden'},{status:400})
        : Response.json({ok:true,missionId:'synthetic-current',mode:'native-swarm',assignments:[]})
    }
    if (url.startsWith('/api/conductor-spawn?missionId=')) {
      missionReads++
      return Response.json({ok:true,mission:{id:'synthetic-current',nativeSwarm:true,status:missionStatus,
        updatedAt:Date.now(),error:missionStatus==='blocked'?'Synthetic native blocker':null,lines:[],
        assignments:[{id:'current',workerId:'argus-developer',task:'Synthetic current task',state:missionStatus==='waiting'?'needs_input':missionStatus==='blocked'?'blocked':missionStatus==='completed'?'done':'dispatched'}]}})
    }
    if (url==='/api/profiles/list') return Response.json({ok:true,profiles:[]})
    if (url==='/api/models') return Response.json({ok:true,models:[]})
    if (url.startsWith('/api/conductor-spawn?history=')) return Response.json({ok:true,missions:[]})
    if (url.startsWith('/api/sessions/')) return Response.json({messages:[]})
    throw new Error('Unowned synthetic fetch '+url)
  }))
})
afterEach(async () => {
  await act(async () => { root?.unmount(); await Promise.resolve() }); root=undefined; client.clear(); document.body.replaceChildren()
  localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})
async function mount(component=<Probe />) {
  root=createRoot(document.body.appendChild(document.createElement('div')))
  await act(async () => { root!.render(<QueryClientProvider client={client}>{component}</QueryClientProvider>); await Promise.resolve() })
}
it.each(['waiting','blocked'])('keeps %s resumable, polling, and out of successful history until actual completion', async state => {
  missionStatus=state; localStorage.setItem('conductor:active-mission',JSON.stringify(savedMission()))
  await mount(); await waitFor(() => expect(missionReads).toBeGreaterThan(0))
  expect(api.phase).toBe('running'); expect(api.completedAt).toBeNull(); expect(api.missionHistory).toEqual([])
  expect(api.workers[0].status).toBe(state)
  expect(localStorage.getItem('conductor:active-mission')).not.toBeNull()
  await waitFor(() => expect(missionReads).toBeGreaterThan(1),{timeout:4000})
  expect(api.phase).toBe('running'); expect(api.missionHistory).toEqual([])
  missionStatus='running'
  await act(async () => { await client.invalidateQueries({queryKey:['conductor','mission-status']}) })
  await waitFor(() => expect(api.workers[0].status).toBe('running'))
  expect(api.streamError).toBeNull()
  missionStatus='completed'
  await act(async () => { await client.invalidateQueries({queryKey:['conductor','mission-status']}) })
  await waitFor(() => expect(api.phase).toBe('complete'))
  await waitFor(() => expect(api.missionHistory[0]?.status).toBe('completed'))
  expect(posts).toEqual([])
})
it('migrates legacy persisted overrides and launches using only supported saved-profile settings', async () => {
  localStorage.setItem('conductor-settings',JSON.stringify({orchestratorModel:'obsolete-orchestrator',workerModel:'obsolete-worker',projectsDir:'/synthetic/project',maxParallel:3,supervised:true}))
  await mount()
  expect(api.conductorSettings).toEqual({projectsDir:'/synthetic/project',maxParallel:3,supervised:true})
  await waitFor(() => expect(JSON.parse(localStorage.getItem('conductor-settings')!)).toEqual(api.conductorSettings))
  await act(async () => { await api.sendMission('Synthetic bounded launch') })
  expect(posts).toEqual([{goal:'Synthetic bounded launch',projectsDir:'/synthetic/project',maxParallel:3,supervised:true}])
})
it('settings UI explains saved routes instead of exposing rejected model selectors', async () => {
  await mount(<Conductor />)
  fireEvent.click(await screen.findByRole('button',{name:'Open conductor settings'}))
  expect(screen.queryByText('Orchestrator Model')).toBeNull()
  expect(screen.queryByText('Worker Model')).toBeNull()
  expect(screen.getByText(/existing profile.*provider.*model/i)).toBeTruthy()
})

function historyWrites(): Array<Array<{ status?: string; error?: string }>> {
  const writes: Array<Array<{ status?: string; error?: string }>> = []
  // JSDOM Storage instance properties are storage keys; observe the real prototype method.
  const proto = Object.getPrototypeOf(localStorage) as Storage
  const setItem = proto.setItem
  vi.spyOn(proto, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === 'conductor:history') writes.push(JSON.parse(value) as Array<{ status?: string; error?: string }>)
    setItem.call(this, key, value)
  })
  return writes
}
it('clears an obsolete native blocker when the next real poll reports completed directly', async () => {
  missionStatus='blocked'; localStorage.setItem('conductor:active-mission',JSON.stringify(savedMission()))
  const writes=historyWrites()
  await mount(<><Probe /><Conductor /></>)
  await waitFor(() => expect(missionReads).toBeGreaterThan(0))
  await waitFor(() => expect(api.streamError).toBe('Synthetic native blocker'))
  expect(api.phase).toBe('running')
  // The active board has no error panel; the complete view renders streamError as Mission Stopped.
  const reads=missionReads
  missionStatus='completed' // No queued/running/reviewing observation in between.
  await waitFor(() => expect(api.phase).toBe('complete'),{timeout:4000})
  expect(missionReads).toBeGreaterThan(reads)
  expect(api.streamError).toBeNull()
  await waitFor(() => expect(screen.getByText('Mission Complete')).toBeTruthy())
  expect(screen.queryByText('Mission Stopped')).toBeNull(); expect(document.body.textContent).not.toContain('Synthetic native blocker')
  await waitFor(() => expect(api.missionHistory).toHaveLength(1))
  expect(api.missionHistory[0]).toMatchObject({status:'completed'}); expect(api.missionHistory[0].error).toBeUndefined()
  const saved=JSON.parse(localStorage.getItem('conductor:history')!) as Array<{status:string}>
  expect(saved).toHaveLength(1); expect(saved[0].status).toBe('completed')
  expect(writes.length).toBeGreaterThan(0)
  expect(writes.flat().some(entry => entry.status === 'failed' || entry.error === 'Synthetic native blocker')).toBe(false)
  expect(posts).toEqual([])
})
it('keeps a direct blocked to failed transition failed with its real terminal error', async () => {
  missionStatus='blocked'; localStorage.setItem('conductor:active-mission',JSON.stringify(savedMission()))
  await mount(); await waitFor(() => expect(api.streamError).toBe('Synthetic native blocker'))
  missionStatus='failed'
  await waitFor(() => expect(api.phase).toBe('complete'),{timeout:4000})
  expect(api.streamError).toBe('Conductor mission failed')
  await waitFor(() => expect(api.missionHistory[0]?.status).toBe('failed'))
  expect(api.missionHistory).toHaveLength(1); expect(api.missionHistory[0].error).toBe('Conductor mission failed')
  expect(posts).toEqual([])
})
