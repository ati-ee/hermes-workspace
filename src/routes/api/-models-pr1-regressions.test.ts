import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture=vi.hoisted(() => ({ models:[] as Array<string>, dashboard:false, token:'', authenticated:true,
  dashboardFetch:vi.fn(), writes:vi.fn(), fetch:vi.fn() }))
vi.mock('node:fs', () => ({default:{existsSync:(p:string)=>p.endsWith('/models.json'),readFileSync:(p:string)=>{
  if(!p.endsWith('/models.json')) throw new Error('Synthetic missing config')
  return JSON.stringify(fixture.models.map(model=>({model,provider:'synthetic-local'})))
},writeFileSync:fixture.writes}}))
vi.mock('@tanstack/react-router', () => ({createFileRoute:()=> (options:unknown)=>options}))
vi.mock('@tanstack/react-start', () => ({json:(value:unknown,init?:ResponseInit)=>Response.json(value,init)}))
vi.mock('../../server/auth-middleware', () => ({isAuthenticated:()=>fixture.authenticated}))
vi.mock('../../server/claude-api', () => ({ensureGatewayProbed:vi.fn(),getGatewayCapabilities:()=>({models:true,dashboard:{available:fixture.dashboard}})}))
vi.mock('../../server/gateway-capabilities', () => ({get BEARER_TOKEN(){return fixture.token},CLAUDE_API:'https://synthetic-gateway.invalid',dashboardFetch:fixture.dashboardFetch}))
vi.mock('../../server/local-provider-discovery', () => ({ensureDiscovery:vi.fn(),getDiscoveredModels:()=>[],ensureProviderInConfig:fixture.writes}))
beforeEach(() => {
  vi.resetModules();fixture.models=[];fixture.dashboard=false;fixture.token='';fixture.authenticated=true
  fixture.dashboardFetch.mockReset();fixture.writes.mockReset();fixture.fetch.mockReset()
  vi.stubGlobal('fetch',fixture.fetch)
})
afterEach(() => vi.unstubAllGlobals())
async function get(){
  const {Route}=await import('./models')
  const route=Route as unknown as {server:{handlers:{GET:(arg:{request:Request})=>Promise<Response>}}}
  const result=await route.server.handlers.GET({request:new Request('https://synthetic-workspace.invalid/api/models')})
  expect(fixture.writes).not.toHaveBeenCalled()
  return result
}
it('discovers the credential-free gateway without Dashboard, retaining known local models',async()=>{
  fixture.models=['local-known'];fixture.fetch.mockResolvedValue(Response.json({data:[{id:'gateway-known',owned_by:'gateway',api_key:'synthetic-private-field'}]}))
  const result=await get();expect(result.status).toBe(200);const body=await result.json()
  expect(body.models.map((m:{id:string})=>m.id)).toEqual(['local-known','gateway-known'])
  expect(JSON.stringify(body)).not.toContain('synthetic-private-field')
  expect(fixture.fetch).toHaveBeenCalledWith('https://synthetic-gateway.invalid/v1/models',expect.objectContaining({headers:{}}))
  expect(fixture.dashboardFetch).not.toHaveBeenCalled()
})
it('uses Dashboard only in the advertised available no-API-key context',async()=>{
  fixture.dashboard=true;fixture.dashboardFetch.mockResolvedValue(Response.json({providers:[{slug:'synthetic',authenticated:true,models:['catalog-model'],token:'synthetic-private-field'}]}))
  const result=await get();expect(result.status).toBe(200);expect(JSON.stringify(await result.json())).not.toContain('synthetic-private-field')
  expect(fixture.fetch).not.toHaveBeenCalled();expect(fixture.dashboardFetch).toHaveBeenCalledTimes(1)
})
it.each(['network','503'])('retains legitimate local models on optional gateway %s failure',async kind=>{
  fixture.models=['local-known']
  if(kind==='network')fixture.fetch.mockRejectedValue(new TypeError('Synthetic unreachable transport'))
  else fixture.fetch.mockResolvedValue(Response.json({private:'not-for-renderer'},{status:503}))
  const result=await get();expect(result.status).toBe(200);const body=await result.json()
  expect(body.models.map((m:{id:string})=>m.id)).toEqual(['local-known'])
  expect(body.warnings).toContain('model_catalog_unavailable');expect(fixture.dashboardFetch).not.toHaveBeenCalled()
})
it.each([401,403])('does not hide actual gateway auth %i behind local data or credential fallback',async status=>{
  fixture.models=['local-known'];fixture.fetch.mockResolvedValue(Response.json({detail:'synthetic-private-field'},{status}))
  const result=await get();expect(result.status).toBe(status);expect(JSON.stringify(await result.json())).not.toContain('synthetic-private-field')
  expect(fixture.dashboardFetch).not.toHaveBeenCalled()
})
it('keeps an explicitly configured gateway API credential server-only',async()=>{
  fixture.token='synthetic-fixture-only';fixture.dashboard=true;fixture.fetch.mockResolvedValue(Response.json({data:['gateway-model']}))
  const result=await get();expect(result.status).toBe(200)
  expect(fixture.fetch).toHaveBeenCalledWith('https://synthetic-gateway.invalid/v1/models',expect.objectContaining({headers:{Authorization:`Bearer ${fixture.token}`}}))
  expect(JSON.stringify(await result.json())).not.toContain(fixture.token);expect(fixture.dashboardFetch).not.toHaveBeenCalled()
})
it('preserves genuine Dashboard auth denial even with known local models',async()=>{
  const {DashboardAuthError}=await import('../../server/dashboard-native-auth')
  fixture.models=['local-known'];fixture.dashboard=true;fixture.dashboardFetch.mockRejectedValue(new DashboardAuthError(401,'synthetic-private-field'))
  const result=await get();expect(result.status).toBe(401);const body=await result.json()
  expect(body.code).toBe('dashboard_auth_required');expect(JSON.stringify(body)).not.toContain('synthetic-private-field');expect(fixture.fetch).not.toHaveBeenCalled()
})
it('does not fabricate catalog success when no local or remote models exist during failure',async()=>{
  fixture.fetch.mockRejectedValue(new TypeError('Synthetic unreachable transport'))
  expect((await get()).status).toBe(503)
})
it('retains Workspace authentication before any discovery',async()=>{
  fixture.authenticated=false;expect((await get()).status).toBe(401)
  expect(fixture.fetch).not.toHaveBeenCalled();expect(fixture.dashboardFetch).not.toHaveBeenCalled()
})
