// Node built-in tests for the B2 test-only network guard:
//   node --test scripts/test-net-guard/net-guard.node-check.mjs
// (Deliberately not named *.test.mjs, so a plain `vitest run` never collects this node:test file.)
// No external network: every attempted target is a loopback listener owned by this test, which
// must observe ZERO connections. No packages, no services.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const guard = fileURLToPath(new URL('./net-guard.cjs', import.meta.url))
const runner = fileURLToPath(new URL('./run-guarded.mjs', import.meta.url))
let server
let port
let connections = 0

before(async () => {
  server = net.createServer((socket) => { connections += 1; socket.destroy() })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})
after(() => new Promise((resolve) => server.close(resolve)))

function guarded(script, { role, extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'b2-net-guard-test-'))
  const env = { PATH: process.env.PATH, B2_NET_GUARD_DIR: dir, TARGET_PORT: String(port), ...extraEnv }
  if (role) env.B2_NET_GUARD_ROLE = role
  const result = spawnSync(process.execPath, [`--require=${guard}`, '--input-type=module', '-e', script], { env, encoding: 'utf8' })
  const files = readdirSync(dir)
  const violations = files.filter((name) => name.startsWith('violations-'))
    .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
  const summaries = files.filter((name) => name.startsWith('summary-')).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
  const localQueries = files.filter((name) => name.startsWith('local-tool-queries-'))
    .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
  const raw = files.map((name) => readFileSync(join(dir, name), 'utf8')).join('\n')
  rmSync(dir, { recursive: true, force: true })
  return { ...result, violations, summaries, localQueries, raw }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

test('denies every outbound API before a socket exists and records host:port only', async () => {
  const script = `
    import net from 'node:net'; import tls from 'node:tls'; import http from 'node:http'; import https from 'node:https'
    import http2 from 'node:http2'; import dns from 'node:dns'; import { connect } from 'node:net'
    const port = Number(process.env.TARGET_PORT); const out = {}
    const attempt = async (name, fn) => { try { await fn(); out[name] = 'NOT_DENIED' } catch (error) { out[name] = error.code } }
    await attempt('fetch', () => fetch('http://127.0.0.1:' + port + '/path?token=super-secret-token', { headers: { authorization: 'Bearer super-secret-token' } }))
    await attempt('http.request', () => http.request({ host: '127.0.0.1', port, headers: { cookie: 'claude-auth=super-secret-token' } }))
    await attempt('http.get', () => http.get('http://127.0.0.1:' + port + '/x'))
    await attempt('https.request', () => https.request({ host: '127.0.0.1', port }))
    await attempt('net.connect', () => net.connect(port, '127.0.0.1'))
    await attempt('esm named connect', () => connect({ port, host: '127.0.0.1' }))
    await attempt('net.Socket.connect', () => new net.Socket().connect(port, '127.0.0.1'))
    await attempt('unix socket', () => net.connect('/tmp/b2-nonexistent.sock'))
    await attempt('tls.connect', () => tls.connect(port, '127.0.0.1'))
    await attempt('http2.connect', () => http2.connect('http://127.0.0.1:' + port))
    await attempt('dns.lookup', () => dns.lookup('localhost', () => {}))
    await attempt('dns.resolve4', () => dns.resolve4('localhost', () => {}))
    await attempt('dns.promises.lookup', () => dns.promises.lookup('localhost'))
    await attempt('dns.Resolver', () => new dns.Resolver().resolve('localhost', () => {}))
    await attempt('WebSocket', () => new WebSocket('ws://127.0.0.1:' + port))
    console.log(JSON.stringify(out))`
  const result = guarded(script)
  await settle()
  assert.equal(result.status, 0, result.stderr)
  const out = JSON.parse(result.stdout)
  for (const [name, code] of Object.entries(out)) assert.equal(code, 'B2_NET_GUARD_DENIED', name)
  assert.equal(connections, 0)
  assert.equal(result.violations.length, Object.keys(out).length)
  assert.ok(!result.raw.includes('super-secret-token'), 'secrets/headers must never be recorded')
  assert.ok(!result.raw.includes('/path'), 'URL paths must never be recorded')
  assert.deepEqual(result.summaries.map((item) => [item.role, item.attempts, item.allowedOutbound]), [['root', Object.keys(out).length, 0]])
})

test('a child process denies every child_process API (no curl/python/shell fallback)', () => {
  const script = `
    import cp from 'node:child_process'; const out = {}
    for (const [name, fn] of Object.entries({
      spawn: () => cp.spawn('curl', ['http://127.0.0.1']), spawnSync: () => cp.spawnSync('python3', ['-c', '1']),
      exec: () => cp.exec('true'), execSync: () => cp.execSync('true'), execFile: () => cp.execFile('true'),
      execFileSync: () => cp.execFileSync('true'), fork: () => cp.fork('/dev/null') })) {
      try { fn(); out[name] = 'NOT_DENIED' } catch (error) { out[name] = error.code }
    }
    console.log(JSON.stringify(out))`
  const result = guarded(script, { role: 'child' })
  assert.equal(result.status, 0, result.stderr)
  const out = JSON.parse(result.stdout)
  assert.equal(Object.keys(out).length, 7)
  for (const [name, code] of Object.entries(out)) assert.equal(code, 'B2_NET_GUARD_DENIED', name)
  assert.ok(result.violations.every((record) => record.role === 'child' && record.kind.startsWith('child_process.')))
})

test('the root injects the guard into spawned and forked node children, even with a scrubbed env', async () => {
  const script = `
    import cp from 'node:child_process'
    const code = "fetch('http://127.0.0.1:" + process.env.TARGET_PORT + "').then(() => console.log('NOT_DENIED'), (e) => console.log(e.code))"
    const spawned = cp.spawnSync(process.execPath, ['-e', code], { env: { PATH: process.env.PATH }, encoding: 'utf8' })
    const forked = await new Promise((resolve) => {
      const child = cp.fork('-', [], { execArgv: ['-e', code], env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      let text = ''; child.stdout.on('data', (d) => { text += d }); child.on('exit', () => resolve(text.trim()))
    })
    console.log(JSON.stringify({ spawned: spawned.stdout.trim(), forked }))`
  const result = guarded(script)
  await settle()
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { spawned: 'B2_NET_GUARD_DENIED', forked: 'B2_NET_GUARD_DENIED' })
  assert.equal(connections, 0)
  assert.ok(result.summaries.some((item) => item.role === 'child' && item.attempts === 1))
})

test('worker threads receive the guard', async () => {
  // The parent runs with --input-type=module, which worker eval inherits: worker code is ESM.
  const script = `
    import { Worker } from 'node:worker_threads'
    const code = "import net from 'node:net'; import { parentPort } from 'node:worker_threads'; try { net.connect(Number(process.env.TARGET_PORT), '127.0.0.1'); parentPort.postMessage('NOT_DENIED') } catch (e) { parentPort.postMessage(e.code + ' ' + globalThis.__b2NetGuard.role) }"
    const worker = new Worker(code, { eval: true })
    worker.on('message', (m) => { console.log(m); worker.terminate() })
    worker.on('error', (e) => { console.log('WORKER_ERROR ' + (e.code || e.message)); process.exitCode = 1 })`
  const result = guarded(script)
  await settle()
  assert.equal(result.stdout.trim(), 'B2_NET_GUARD_DENIED child', result.stderr)
  assert.equal(connections, 0)
})

function wrap(args) {
  return spawnSync(process.execPath, [runner, ...args], { env: { PATH: process.env.PATH, TARGET_PORT: String(port) }, encoding: 'utf8' })
}

test('the wrapper is non-green when a library swallows the denial', async () => {
  const result = wrap(['--', process.execPath, '-e', "fetch('http://127.0.0.1:' + process.env.TARGET_PORT).catch(() => {})"])
  await settle()
  assert.equal(result.status, 3, result.stderr)
  assert.match(result.stderr, /"attempts":1,"allowedOutbound":0/)
  assert.equal(connections, 0)
})

test('the wrapper is non-green when the guard is not active in the command process', () => {
  const result = wrap(['--', '/usr/bin/env', '-u', 'NODE_OPTIONS', process.execPath, '-e', '0'])
  assert.equal(result.status, 4, result.stderr)
})

test('a clean command passes with zero attempts and zero allowed outbound connections', () => {
  const result = wrap(['--expect-worker', '--', process.execPath, '-e', "require('node:child_process').spawnSync(process.execPath, ['-e', '0'])"])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /"roots":1,"children":1,"attempts":0,"allowedOutbound":0/)
})

test('vitest mode forces --pool=forks and the offline config, and refuses other pools/configs', () => {
  const config = fileURLToPath(new URL('./vitest.offline.config.mjs', import.meta.url))
  const forced = wrap(['--vitest', '--', process.execPath, '-e', 'console.log(process.argv.slice(1).join(" "))', 'run'])
  assert.equal(forced.status, 0, forced.stderr)
  assert.match(forced.stdout, /--pool=forks/)
  assert.ok(forced.stdout.includes(`--config=${config}`), forced.stdout)
  const explicit = wrap(['--vitest', '--', process.execPath, '-e', '0', 'run', '--config', config])
  assert.equal(explicit.status, 0, explicit.stderr)
  const refused = wrap(['--vitest', '--', process.execPath, '-e', '0', '--pool=threads'])
  assert.equal(refused.status, 2)
  for (const other of [['--config=vite.config.ts'], ['-c', 'vite.config.ts'], ['--config']]) {
    const result = wrap(['--vitest', '--', process.execPath, '-e', '0', 'run', ...other])
    assert.equal(result.status, 2, other.join(' '))
  }
})

// ------------------------------------------------------------------ V4: tooling compatibility
const CPU_PHYSICAL = 'cat /proc/cpuinfo | grep "physical id" | sort |uniq | wc -l'
const CPU_CORE = 'cat /proc/cpuinfo | grep "core id" | sort | uniq | wc -l'

test('answers only the two exact tinypool CPU queries in-process (root and child), matching the real pipeline', () => {
  const script = `
    import cp from 'node:child_process'
    const physical = ${JSON.stringify(CPU_PHYSICAL)}; const core = ${JSON.stringify(CPU_CORE)}
    console.log(JSON.stringify({
      physical: cp.execSync(physical, { encoding: 'utf8', stdio: [null, null, null] }),
      core: cp.execSync(core, { encoding: 'utf8' }),
      buffer: Buffer.isBuffer(cp.execSync(core)),
    }))`
  // Reference only: the real pipeline, run once by this UNGUARDED test runner (local file read).
  const reference = (command) => spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' }).stdout
  for (const role of [undefined, 'child']) {
    const result = guarded(script, { role })
    assert.equal(result.status, 0, result.stderr)
    const out = JSON.parse(result.stdout)
    assert.equal(out.physical, reference(CPU_PHYSICAL))
    assert.equal(out.core, reference(CPU_CORE))
    assert.equal(out.buffer, true)
    assert.equal(result.violations.length, 0)
    assert.deepEqual(result.localQueries.map((item) => item.kind), ['cpuinfo:physical-id', 'cpuinfo:core-id', 'cpuinfo:core-id'])
    assert.deepEqual(result.summaries.map((item) => [item.role, item.attempts, item.localToolQueries]), [[role || 'root', 0, 3]])
  }
})

test('refuses changed, extended or differently invoked CPU commands and any other process (root and child)', () => {
  const script = `
    import cp from 'node:child_process'
    const physical = ${JSON.stringify(CPU_PHYSICAL)}; const out = {}
    const cases = {
      respaced: () => cp.execSync(physical.replace('sort |uniq', 'sort | uniq'), { encoding: 'utf8' }),
      trailingSpace: () => cp.execSync(physical + ' ', { encoding: 'utf8' }),
      chained: () => cp.execSync(physical + '; true', { encoding: 'utf8' }),
      extraEnvOption: () => cp.execSync(physical, { encoding: 'utf8', env: {} }),
      shellOption: () => cp.execSync(physical, { encoding: 'utf8', shell: '/bin/bash' }),
      cwdOption: () => cp.execSync(physical, { cwd: '/' }),
      extraArgument: () => cp.execSync(physical, { encoding: 'utf8' }, 'extra'),
      asyncExec: () => cp.exec(physical),
      unknownShell: () => cp.execSync('true'),
      shViaSpawn: () => cp.spawnSync('/bin/sh', ['-c', physical]),
      catViaExecFile: () => cp.execFileSync('cat', ['/proc/cpuinfo']),
      nodeWithShell: () => cp.spawnSync(process.execPath, ['-e', '0'], { shell: true }),
      forkSwappedExecPath: () => cp.fork('/dev/null', [], { execPath: '/bin/sh' }),
    }
    for (const [name, fn] of Object.entries(cases)) {
      try { fn(); out[name] = 'NOT_DENIED' } catch (error) { out[name] = error.code }
    }
    console.log(JSON.stringify(out))`
  for (const role of [undefined, 'child']) {
    const result = guarded(script, { role })
    assert.equal(result.status, 0, result.stderr)
    const out = JSON.parse(result.stdout)
    assert.equal(Object.keys(out).length, 13)
    for (const [name, code] of Object.entries(out)) assert.equal(code, 'B2_NET_GUARD_DENIED', `${role || 'root'} ${name}`)
    assert.equal(result.violations.length, 13)
    assert.equal(result.localQueries.length, 0)
  }
})

test('child process diagnostics carry a fixed category or a validated basename, never the command or arguments', () => {
  const script = `
    import cp from 'node:child_process'; const out = []
    for (const fn of [
      () => cp.execSync('curl -H "Authorization: Bearer super-secret-token" https://example.invalid/x'),
      () => cp.spawnSync('curl', ['--oauth2-bearer', 'super-secret-token']),
      () => cp.execFile('/tmp/super-secret-token/curl', ['x']),
      () => cp.spawn('curl --header=super-secret-token', [], {}),
    ]) { try { fn(); out.push('NOT_DENIED') } catch (error) { out.push(error.code) } }
    console.log(JSON.stringify(out))`
  const result = guarded(script, { role: 'child' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), Array(4).fill('B2_NET_GUARD_DENIED'))
  assert.deepEqual(result.violations.map((item) => item.target), ['shell-command', 'curl', 'curl', 'invalid-executable'])
  assert.deepEqual(result.summaries.map((item) => item.attempts), [4])
  for (const text of [result.raw, result.stderr]) {
    for (const secret of ['super-secret-token', 'Authorization', 'oauth2', 'example.invalid']) {
      assert.ok(!text.includes(secret), `diagnostics must not reflect ${secret}`)
    }
  }
})

test('the wrapper reports mocked local tool queries separately and stays green only without denials', () => {
  const summaryOf = (stderr) => JSON.parse(stderr.match(/\[b2-net-guard\] summary (.*)/)[1])
  const clean = wrap(['--expect-worker', '--', process.execPath, '-e',
    `const cp = require('node:child_process'); cp.execSync(${JSON.stringify(CPU_PHYSICAL)}, { encoding: 'utf8' });`
    + ` cp.spawnSync(process.execPath, ['-e', ${JSON.stringify(`require('node:child_process').execSync(${JSON.stringify(CPU_CORE)})`)}])`])
  assert.equal(clean.status, 0, clean.stderr)
  const ok = summaryOf(clean.stderr)
  assert.deepEqual([ok.roots, ok.children, ok.attempts, ok.allowedOutbound], [1, 1, 0, 0])
  assert.deepEqual([ok.mockedLocalToolQueries, ok.toolingRequestsTotal], [2, 2])
  assert.deepEqual(ok.localToolKinds, { 'cpuinfo:core-id': 1, 'cpuinfo:physical-id': 1 })
  const changed = wrap(['--', process.execPath, '-e',
    `try { require('node:child_process').execSync(${JSON.stringify(`${CPU_PHYSICAL} `)}) } catch {}`])
  assert.equal(changed.status, 3, changed.stderr)
  const bad = summaryOf(changed.stderr)
  assert.deepEqual([bad.attempts, bad.allowedOutbound, bad.mockedLocalToolQueries], [1, 0, 0])
  assert.deepEqual(bad.kinds, { 'child_process.execSync': 1 })
})

test('the offline test-only Vitest config loads without plugins and binds exactly the six focused files', async () => {
  const configUrl = new URL('./vitest.offline.config.mjs', import.meta.url)
  const config = (await import(configUrl)).default
  const root = fileURLToPath(new URL('../..', import.meta.url))
  assert.equal(config.plugins, undefined)
  assert.equal(config.root, root)
  assert.deepEqual(config.server, { host: '127.0.0.1' })  // numeric loopback: no Vite localhost DNS lookup
  assert.deepEqual(Object.keys(config.resolve.alias), ['@'])
  assert.equal(config.resolve.alias['@'], join(root, 'src'))
  assert.equal(config.test.pool, 'forks')
  assert.equal(config.test.environment, 'node')
  assert.equal(config.test.include.length, 6)
  for (const file of config.test.include) assert.ok(existsSync(join(root, file)), file)
  const imports = readFileSync(configUrl, 'utf8').match(/^import .*$/gm)
  assert.deepEqual(imports, ["import { fileURLToPath } from 'node:url'"])
})
