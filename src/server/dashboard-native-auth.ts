import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

type Grant = {
  access_token: string
  refresh_token: string
  expires_at: number
  provider: string
}
type Connection = { grant: Grant; base: string; refreshing?: Promise<string> }
type Pending = {
  owner: string
  base: string
  publicBase: string
  verifier: string
  challenge: string
  cookie: string
  origin: string
  expires: number
  launched: boolean
}

export class DashboardAuthError extends Error {
  constructor(
    public status: number,
    message = 'Dashboard sign-in required',
  ) {
    super(message)
  }
}

// No disk storage, logs, renderer token payloads or process-wide shared grant.
// Each connection belongs to one authenticated Workspace browser session.
export class DashboardNativeAuth {
  private connections = new Map<string, Connection>()
  private pending = new Map<string, Pending>()
  constructor(
    private http: typeof fetch = fetch,
    private now = Date.now,
  ) {}

  private prune() {
    for (const [id, p] of this.pending)
      if (p.expires <= this.now()) this.pending.delete(id)
  }
  status(owner: string, base: string) {
    const c = this.connections.get(owner)
    return {
      connected: c?.base === base,
      provider: c?.base === base ? c.grant.provider : null,
      expiresAt: c?.base === base ? c.grant.expires_at : null,
      storage: 'server-memory; reconnect after Workspace restart',
    }
  }
  disconnect(owner: string) {
    this.connections.delete(owner)
  }

  async start(owner: string, base: string, port: number) {
    this.prune()
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new DashboardAuthError(400, 'Invalid localhost port')
    if (
      this.pending.size >= 16 ||
      (!this.connections.has(owner) && this.connections.size >= 32)
    )
      throw new DashboardAuthError(429, 'Too many pending connections')
    // Discover the existing operator-declared browser callback; never override
    // Dashboard public_url, Host policy, provider registration or auth settings.
    const r = await this.http(`${base}/auth/login?provider=nous`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
    const location = r.headers.get('location')
    if (r.status !== 302 || !location)
      throw new DashboardAuthError(502, 'Dashboard login bootstrap unavailable')
    const redirect = new URL(location).searchParams.get('redirect_uri')
    if (!redirect)
      throw new DashboardAuthError(
        502,
        'Dashboard did not advertise its callback',
      )
    const callback = new URL(redirect)
    if (
      callback.protocol !== 'https:' ||
      callback.username ||
      callback.password ||
      callback.search ||
      callback.hash ||
      !callback.pathname.endsWith('/auth/callback')
    )
      throw new DashboardAuthError(
        502,
        'Unsupported Dashboard browser callback',
      )
    // Existing reverse proxies may redirect a registered root callback to a
    // sub-path. Follow only same-origin HTTPS callback redirects, without a
    // code, cookies or credentials. Never change OAuth registration.
    let browserCallback = callback
    for (let hop = 0; hop < 4; hop++) {
      const check = await this.http(browserCallback.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      if (![301, 302, 303, 307, 308].includes(check.status)) break
      const next = new URL(check.headers.get('location') || '', browserCallback)
      if (
        hop === 3 ||
        next.origin !== callback.origin ||
        next.search ||
        next.hash ||
        !next.pathname.endsWith('/auth/callback')
      )
        throw new DashboardAuthError(
          502,
          'Unsupported Dashboard callback routing',
        )
      browserCallback = next
    }
    const publicBase = browserCallback.href.slice(0, -'/auth/callback'.length)
    const providers = await this.http(`${publicBase}/api/auth/providers`, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (
      !providers.ok ||
      !(await providers.json()).providers?.some(
        (p: { name?: string }) => p.name === 'nous',
      )
    )
      throw new DashboardAuthError(502, 'Dashboard browser login unavailable')
    const id = randomBytes(32).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const origin = `http://127.0.0.1:${port}`
    this.pending.set(id, {
      owner,
      base,
      publicBase,
      verifier,
      challenge: createHash('sha256').update(verifier).digest('base64url'),
      cookie: randomBytes(32).toString('base64url'),
      origin,
      expires: this.now() + 300_000,
      launched: false,
    })
    return { launchUrl: `${origin}/api/dashboard-auth/launch?flow=${id}` }
  }
  launch(id: string, origin: string) {
    this.prune()
    const p = this.pending.get(id)
    if (!p || p.launched || p.origin !== origin)
      throw new DashboardAuthError(
        400,
        'Login expired or wrong localhost connection',
      )
    p.launched = true
    const url = new URL(`${p.publicBase}/auth/native/authorize`)
    url.search = new URLSearchParams({
      provider: 'nous',
      state: id,
      code_challenge: p.challenge,
      code_challenge_method: 'S256',
      redirect_uri: `${origin}/api/dashboard-auth/callback`,
    }).toString()
    return { location: url.href, cookie: p.cookie }
  }
  private parseGrant(raw: unknown): Grant {
    const g = raw as Partial<Grant> | null
    if (
      !g ||
      typeof g.access_token !== 'string' ||
      !g.access_token ||
      typeof g.refresh_token !== 'string' ||
      g.provider !== 'nous' ||
      typeof g.expires_at !== 'number' ||
      !Number.isFinite(g.expires_at) ||
      g.expires_at * 1000 <= this.now()
    )
      throw new DashboardAuthError(
        502,
        'Invalid Dashboard authentication response',
      )
    return g as Grant
  }
  private async post(base: string, path: string, body: unknown) {
    try {
      return await this.http(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      throw new DashboardAuthError(
        503,
        'Dashboard authentication service unavailable',
      )
    }
  }
  async complete(id: string, code: string, cookie: string, origin: string) {
    this.prune()
    const p = this.pending.get(id)
    if (
      !p ||
      !p.launched ||
      p.origin !== origin ||
      !code ||
      code.length > 4096 ||
      cookie.length !== p.cookie.length ||
      !timingSafeEqual(Buffer.from(cookie), Buffer.from(p.cookie))
    )
      throw new DashboardAuthError(400, 'Invalid or expired login callback')
    // One-use state/code; an ambiguous token exchange must restart login.
    this.pending.delete(id)
    const r = await this.post(p.base, '/auth/native/token', {
      code,
      code_verifier: p.verifier,
    })
    if (!r.ok)
      throw new DashboardAuthError(
        r.status === 401 ? 401 : 502,
        'Dashboard login exchange failed; restart sign-in',
      )
    const grant = this.parseGrant(
      await r.json().catch(() => {
        throw new DashboardAuthError(
          502,
          'Invalid Dashboard authentication response',
        )
      }),
    )
    this.connections.set(p.owner, { base: p.base, grant })
  }
  async bearer(
    owner: string,
    base: string,
    force = false,
  ): Promise<string | null> {
    const c = this.connections.get(owner)
    if (!c || c.base !== base) return null
    if (!force && c.grant.expires_at * 1000 > this.now() + 30_000)
      return c.grant.access_token
    if (c.refreshing) return c.refreshing
    c.refreshing = (async () => {
      if (!c.grant.refresh_token) {
        this.connections.delete(owner)
        throw new DashboardAuthError(401)
      }
      let r: Response
      try {
        r = await this.post(base, '/auth/native/refresh', {
          refresh_token: c.grant.refresh_token,
          provider: c.grant.provider,
        })
      } catch (error) {
        this.connections.delete(owner)
        throw error
      } // unknown rotation outcome: never replay the old refresh token
      if (r.status === 401) {
        this.connections.delete(owner)
        throw new DashboardAuthError(401)
      }
      if (!r.ok)
        throw new DashboardAuthError(
          503,
          'Dashboard session renewal temporarily unavailable',
        )
      let grant: Grant
      try {
        grant = this.parseGrant(
          await r.json().catch(() => {
            throw new DashboardAuthError(
              502,
              'Invalid Dashboard authentication response',
            )
          }),
        )
      } catch (error) {
        this.connections.delete(owner)
        throw error
      }
      if (this.connections.get(owner) !== c) throw new DashboardAuthError(401)
      c.grant = grant // retain the rotated refresh token, never retry the old one
      return grant.access_token
    })()
    try {
      return await c.refreshing
    } finally {
      c.refreshing = undefined
    }
  }
}

export const dashboardNativeAuth = new DashboardNativeAuth()
