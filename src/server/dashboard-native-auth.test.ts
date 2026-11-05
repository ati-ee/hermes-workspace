import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DashboardNativeAuth } from './dashboard-native-auth'

const base = 'http://dashboard.test:9119'
const origin = 'http://127.0.0.1:19300'
function fixture() {
  let clock = 1_800_000_000_000
  let refreshStatus = 200
  let refreshCount = 0
  const calls: Array<{ url: string; body: any }> = []
  const grant = () => ({
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh',
    expires_at: clock / 1000 + 60,
    provider: 'nous',
  })
  const http = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ url: u, body })
      if (u.endsWith('/auth/login?provider=nous'))
        return new Response(null, {
          status: 302,
          headers: {
            location:
              'https://portal.test/oauth/authorize?redirect_uri=https%3A%2F%2Fpublic-dashboard.test%2Fauth%2Fcallback',
          },
        })
      if (u === 'https://public-dashboard.test/auth/callback')
        return new Response(null, {
          status: 307,
          headers: { location: '/hermes/auth/callback' },
        })
      if (u === 'https://public-dashboard.test/hermes/auth/callback')
        return Response.json({ detail: 'Missing PKCE cookie' }, { status: 400 })
      if (u.endsWith('/api/auth/providers'))
        return Response.json({ providers: [{ name: 'nous' }] })
      if (u.endsWith('/auth/native/token')) return Response.json(grant())
      if (u.endsWith('/auth/native/refresh')) {
        refreshCount++
        return refreshStatus === 200
          ? Response.json({
              ...grant(),
              access_token: 'rotated-access',
              refresh_token: 'rotated-refresh',
            })
          : Response.json(
              { error: 'synthetic failure' },
              { status: refreshStatus },
            )
      }
      throw new Error('unexpected test request')
    },
  )
  const broker = new DashboardNativeAuth(http as typeof fetch, () => clock)
  async function connect(owner = 'owner') {
    const start = await broker.start(owner, base, 19300)
    const id = new URL(start.launchUrl).searchParams.get('flow')!
    const launch = broker.launch(id, origin)
    await broker.complete(id, 'one-use-synthetic-code', launch.cookie, origin)
    return { id, launch }
  }
  return {
    broker,
    calls,
    connect,
    http,
    advance: (n: number) => {
      clock += n
    },
    failRefresh: (s: number) => {
      refreshStatus = s
    },
    refreshCount: () => refreshCount,
  }
}

describe('Dashboard native PKCE connection boundary', () => {
  it('uses the existing public callback authority and valid S256, exposing no grant to the browser', async () => {
    const f = fixture()
    const { launch } = await f.connect()
    const u = new URL(launch.location)
    expect(u.origin).toBe('https://public-dashboard.test')
    expect(u.pathname).toBe('/hermes/auth/native/authorize')
    expect(u.searchParams.get('redirect_uri')).toBe(
      `${origin}/api/dashboard-auth/callback`,
    )
    const exchange = f.calls.find((x) => x.url.endsWith('/auth/native/token'))!
    expect(
      createHash('sha256')
        .update(exchange.body.code_verifier)
        .digest('base64url'),
    ).toBe(u.searchParams.get('code_challenge'))
    expect(JSON.stringify(f.broker.status('owner', base))).not.toMatch(
      /synthetic|rotated|code_verifier/,
    )
    expect(await f.broker.bearer('owner', base)).toBe('synthetic-access')
  })
  it('never shares one browser owner grant with another owner or Dashboard origin', async () => {
    const f = fixture()
    await f.connect()
    expect(await f.broker.bearer('other-owner', base)).toBeNull()
    expect(await f.broker.bearer('owner', 'http://other.test')).toBeNull()
  })
  it('requires the one-use state, exact localhost origin and callback cookie', async () => {
    const f = fixture()
    const start = await f.broker.start('owner', base, 19300)
    const id = new URL(start.launchUrl).searchParams.get('flow')!
    expect(() => f.broker.launch(id, 'http://10.0.0.25:3000')).toThrow()
    const launch = f.broker.launch(id, origin)
    expect(() => f.broker.launch(id, origin)).toThrow()
    await expect(
      f.broker.complete(id, 'code', 'wrong', origin),
    ).rejects.toThrow()
    expect(
      f.calls.filter((x) => x.url.endsWith('/auth/native/token')),
    ).toHaveLength(0)
    await f.broker.complete(id, 'code', launch.cookie, origin)
    await expect(
      f.broker.complete(id, 'code', launch.cookie, origin),
    ).rejects.toThrow()
  })
  it('expires pending sign-in instead of replaying an old code', async () => {
    const f = fixture()
    const start = await f.broker.start('owner', base, 19300)
    const id = new URL(start.launchUrl).searchParams.get('flow')!
    const p = f.broker.launch(id, origin)
    f.advance(300_001)
    await expect(
      f.broker.complete(id, 'code', p.cookie, origin),
    ).rejects.toThrow()
  })
  it('coalesces renewal and uses only the rotated refresh token on later renewals', async () => {
    const f = fixture()
    await f.connect()
    f.advance(31_000)
    expect(
      await Promise.all([
        f.broker.bearer('owner', base),
        f.broker.bearer('owner', base),
      ]),
    ).toEqual(['rotated-access', 'rotated-access'])
    expect(f.refreshCount()).toBe(1)
    await f.broker.bearer('owner', base, true)
    expect(
      f.calls
        .filter((x) => x.url.endsWith('/auth/native/refresh'))
        .map((x) => x.body.refresh_token),
    ).toEqual(['synthetic-refresh', 'rotated-refresh'])
  })
  it('clears a rejected refresh session and requires interactive reauthentication', async () => {
    const f = fixture()
    await f.connect()
    f.failRefresh(401)
    await expect(f.broker.bearer('owner', base, true)).rejects.toMatchObject({
      status: 401,
    })
    expect(f.broker.status('owner', base).connected).toBe(false)
    expect(await f.broker.bearer('owner', base)).toBeNull()
    expect(f.refreshCount()).toBe(1)
  })
  it('retains the session on temporary refresh service failure without retrying', async () => {
    const f = fixture()
    await f.connect()
    f.failRefresh(503)
    await expect(f.broker.bearer('owner', base, true)).rejects.toMatchObject({
      status: 503,
    })
    expect(f.broker.status('owner', base).connected).toBe(true)
    expect(f.refreshCount()).toBe(1)
  })
  it('does not restore a grant when a pending refresh completes after disconnect', async () => {
    const f = fixture()
    await f.connect()
    const renewal = f.broker.bearer('owner', base, true)
    f.broker.disconnect('owner')
    await expect(renewal).rejects.toMatchObject({ status: 401 })
    expect(f.broker.status('owner', base).connected).toBe(false)
  })
  it('rejects invalid port selection before contacting the provider', async () => {
    const f = fixture()
    await expect(f.broker.start('owner', base, 22)).rejects.toMatchObject({
      status: 400,
    })
    expect(f.calls).toHaveLength(0)
  })
})

describe('Native refresh ambiguity', () => {
  it('clears the session after a lost refresh response instead of replaying a possibly rotated token', async () => {
    const f = fixture()
    await f.connect()
    f.http.mockImplementationOnce(async () => {
      throw new Error('synthetic transport failure')
    })
    await expect(f.broker.bearer('owner', base, true)).rejects.toMatchObject({
      status: 503,
    })
    expect(f.broker.status('owner', base).connected).toBe(false)
  })
  it('clears the session after a malformed successful refresh response', async () => {
    const f = fixture()
    await f.connect()
    f.http.mockImplementationOnce(async () =>
      Response.json({ malformed: true }),
    )
    await expect(f.broker.bearer('owner', base, true)).rejects.toMatchObject({
      status: 502,
    })
    expect(f.broker.status('owner', base).connected).toBe(false)
  })
  it('rejects a callback redirect to another authority before opening a login', async () => {
    const f = fixture()
    f.http.mockImplementationOnce(
      async () =>
        new Response(null, {
          status: 302,
          headers: {
            location:
              'https://portal.test/?redirect_uri=https%3A%2F%2Fpublic-dashboard.test%2Fauth%2Fcallback',
          },
        }),
    )
    f.http.mockImplementationOnce(
      async () =>
        new Response(null, {
          status: 307,
          headers: { location: 'https://other.test/auth/callback' },
        }),
    )
    await expect(f.broker.start('owner', base, 19300)).rejects.toMatchObject({
      status: 502,
    })
  })
})

it('never exposes a malformed refresh body through an API error', async () => {
  const f = fixture()
  await f.connect()
  f.http.mockImplementationOnce(
    async () => new Response('synthetic-secret-not-json', { status: 200 }),
  )
  await expect(f.broker.bearer('owner', base, true)).rejects.toMatchObject({
    status: 502,
    message: 'Invalid Dashboard authentication response',
  })
  expect(f.broker.status('owner', base).connected).toBe(false)
})
