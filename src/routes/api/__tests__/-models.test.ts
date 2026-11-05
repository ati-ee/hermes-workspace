import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'

const { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } = vi.hoisted(() => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(''),
  writeFileSync: vi.fn().mockImplementation(() => {}),
  mkdirSync: vi.fn().mockImplementation(() => {}),
  statSync: vi.fn().mockReturnValue({ isFile: () => false, mtimeMs: 0 }),
  readdirSync: vi.fn().mockReturnValue([]),
}))

const catalogCapabilities = vi.hoisted(() => ({ models: false }))

vi.mock('node:fs', () => ({
  default: { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync },
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  readdirSync,
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (opts: any) => opts,
}))

vi.mock('@tanstack/react-start', () => ({
  json: (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...(init || {}),
      headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    }),
}))

vi.mock('../../../server/auth-middleware', () => ({
  isAuthenticated: () => true,
}))

vi.mock('../../../server/gateway-capabilities', () => ({
  BEARER_TOKEN: '',
  CLAUDE_API: 'http://127.0.0.1:8642',
  dashboardFetch: vi.fn(),
}))

vi.mock('../../../server/claude-api', () => ({
  ensureGatewayProbed: vi.fn(),
  getGatewayCapabilities: () => catalogCapabilities,
}))

vi.mock('../../../server/local-provider-discovery', () => ({
  ensureDiscovery: vi.fn(),
  getDiscoveredModels: () => [],
  ensureProviderInConfig: () => false,
}))

beforeEach(() => {
  vi.clearAllMocks()
  catalogCapabilities.models = false
  delete process.env.HERMES_HOME
  delete process.env.CLAUDE_HOME
})

describe('models route', () => {
  async function importModels() {
    vi.resetModules()
    const caps = await import('../../../server/gateway-capabilities')
    vi.mocked(caps.dashboardFetch).mockImplementation(async () => new Response(JSON.stringify({ providers: [] })))
    const mod = await import('../models')
    return mod
  }

  async function getHandler() {
    const mod = await importModels()
    const get = (mod as any).Route.server.handlers.GET
    return get
  }

  it('GET returns ok:true and empty models without config', async () => {
    const get = await getHandler()
    expect(typeof get).toBe('function')
    const request = new Request('http://localhost/api/models')
    const res = await get({ request })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.data).toEqual([])
  })

  it('reads default model from CLAUDE_HOME config using YAML.parse', async () => {
    const envHome = '/mock/profiles/jarvis'
    process.env.CLAUDE_HOME = envHome

    const configYaml = 'model: jarvis-model\nprovider: nous\n'
    const modelsJson = '[{"model":"x","provider":"y"}]'
    existsSync.mockImplementation((p: string) => {
      return p === `${envHome}/models.json` || p === `${envHome}/config.yaml`
    })
    readFileSync.mockImplementation((p: string) => {
      if (p === `${envHome}/config.yaml`) return configYaml
      if (p === `${envHome}/models.json`) return modelsJson
      return ''
    })

    const get = await getHandler()
    const request = new Request('http://localhost/api/models')
    const res = await get({ request })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.models[0].id).toBe('jarvis-model')
    expect(json.models[0].provider).toBe('nous')
    const caps = await import('../../../server/gateway-capabilities')
    expect(caps.dashboardFetch).not.toHaveBeenCalled()
  })

  it('reads nested model object syntax from config using YAML.parse', async () => {
    const envHome = '/mock/profiles/jarvis'
    process.env.CLAUDE_HOME = envHome

    const configYaml = 'model:\n  default: nest-model\n  provider: anthropic\n'
    existsSync.mockImplementation((p: string) => p === `${envHome}/config.yaml`)
    readFileSync.mockImplementation((p: string) => {
      if (p === `${envHome}/config.yaml`) return configYaml
      return ''
    })

    const get = await getHandler()
    const request = new Request('http://localhost/api/models')
    const res = await get({ request })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.models[0].id).toBe('nest-model')
    expect(json.models[0].provider).toBe('anthropic')
  })
})


describe('Dashboard model authentication', () => {
  it('uses the supported Dashboard session instead of unauthenticated gateway API', async () => {
    vi.resetModules()
    const caps = await import('../../../server/gateway-capabilities')
    catalogCapabilities.models = true
    vi.mocked(caps.dashboardFetch).mockResolvedValue(new Response(JSON.stringify({providers: [
      {slug: 'anthropic', authenticated: true, models: ['claude-opus'], token: 'must-not-forward'},
      {slug: 'unconfigured', authenticated: false, models: ['hidden']},
    ]})))
    const mod = await import('../models')
    const res = await (mod as any).Route.server.handlers.GET({request: new Request('http://localhost/api/models')})
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.models).toContainEqual({id: 'claude-opus', name: 'claude-opus', provider: 'anthropic'})
    expect(JSON.stringify(body)).not.toContain('must-not-forward')
    expect(JSON.stringify(body)).not.toContain('hidden')
    expect(caps.dashboardFetch).toHaveBeenCalledWith('/api/model/options?include_unconfigured=false', expect.objectContaining({signal: expect.any(AbortSignal)}))
  })

  it('fails visibly on rejected Dashboard authentication without credential fallback', async () => {
    vi.resetModules()
    const caps = await import('../../../server/gateway-capabilities')
    catalogCapabilities.models = true
    vi.mocked(caps.dashboardFetch).mockRejectedValue(new Error('Dashboard authentication required'))
    const mod = await import('../models')
    const res = await (mod as any).Route.server.handlers.GET({request: new Request('http://localhost/api/models')})
    expect(res.status).toBe(503)
    expect((await res.json()).error).toContain('Dashboard authentication required')
    expect(caps.dashboardFetch).toHaveBeenCalledTimes(1)
  })

  it('rejects a malformed catalog and excludes provider account details', async () => {
    const mod = await import('../models')
    expect(() => mod.normalizeDashboardModels({})).toThrow('invalid model catalog')
    expect(mod.normalizeDashboardModels({providers: [{slug:'test',models:[{id:'model',name:'Model',api_key:'secret'}]}]})).toEqual([{id:'model',name:'Model',provider:'test'}])
  })
})
