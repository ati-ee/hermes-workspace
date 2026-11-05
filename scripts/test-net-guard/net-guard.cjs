'use strict'
/**
 * Test-only zero-outbound-network guard (B2). Preload in EVERY process of a test invocation with
 * `--require=<this file>` (run-guarded.mjs sets NODE_OPTIONS so forks/children inherit it).
 *
 * Denies, BEFORE any socket/DNS/dispatch: fetch, WebSocket, http/https request/get, http2.connect,
 * net.connect/createConnection, net.Socket#connect (TCP and Unix sockets), tls.connect, and every
 * dns lookup/resolve/reverse (callback, Resolver and promises). Every attempt is recorded to
 * B2_NET_GUARD_DIR as kind + validated host:port only (never URL paths, queries, headers, bodies,
 * command lines or arguments), so a library that catches the error still leaves a visible violation
 * that run-guarded.mjs turns non-green. Allowed outbound connections: none.
 *
 * Processes: the first guarded process is the `root` (the test runner main). It may start only
 * Node children (fork, or the running node binary) and esbuild's service binary, without a shell;
 * every child gets this guard injected (NODE_OPTIONS and, for fork, execArgv). Shell APIs
 * (exec/execSync, or any `shell` option) and any other executable are denied in the root too. Any
 * descendant is a `child`: there every child_process API is denied (no curl/python/shell
 * fallback). worker_threads get the guard through execArgv.
 *
 * Local tool queries (test-only tooling adapter): tinypool 1.1.1 runs two exact read-only CPU
 * queries through execSync when it is imported. Exactly those two strings, via execSync only, are
 * answered in-process from /proc/cpuinfo (no shell, no child process) and counted separately as
 * mocked local tool queries; they are NOT outbound attempts and are never reported as "no tooling
 * requests". Any other command, spelling, API or option set is denied.
 *
 * Residual: native addons or internalBinding-level sockets are outside a JS preload's reach.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const GUARD = __filename
const DENIED = 'B2_NET_GUARD_DENIED'

if (!globalThis.__b2NetGuard) {
  const dir = process.env.B2_NET_GUARD_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'b2-net-guard-'))
  const role = process.env.B2_NET_GUARD_ROLE === 'child' ? 'child' : 'root'
  process.env.B2_NET_GUARD_DIR = dir
  process.env.B2_NET_GUARD_ROLE = 'child'  // every descendant (process or worker thread) is a child
  let threadId = 0
  try { threadId = require('node:worker_threads').threadId } catch { /* main thread */ }
  const state = { pid: process.pid, threadId, role, attempts: 0, allowedOutbound: 0, kinds: {}, localToolQueries: 0, localToolKinds: {} }
  Object.defineProperty(globalThis, '__b2NetGuard', { value: state, enumerable: false })
  const id = `${process.pid}-${threadId}`

  const where = () => {
    const frames = String(new Error().stack || '').split('\n').slice(1)
    const frame = frames.find((line) => !line.includes(GUARD))
    return frame ? frame.trim().slice(0, 240) : null
  }
  const deny = (kind, target) => {
    state.attempts += 1
    state.kinds[kind] = (state.kinds[kind] || 0) + 1
    const record = { pid: process.pid, threadId, role, kind, target: target || null, at: where() }
    try { fs.appendFileSync(path.join(dir, `violations-${id}.jsonl`), `${JSON.stringify(record)}\n`) } catch { /* still denied */ }
    try { process.stderr.write(`[b2-net-guard] DENIED ${kind} ${record.target || ''}\n`) } catch { /* still denied */ }
    const error = new Error(`B2_NET_GUARD: ${kind} denied in offline test`)
    error.code = DENIED
    return error
  }

  // Targets: validated host:port only. Never record a path, query, header, body or credential.
  const safeHost = (value) => {
    const host = String(value == null ? '' : value)
    return /^[A-Za-z0-9.:[\]_-]{1,253}$/.test(host) ? host : 'invalid-host'
  }
  const safePort = (value) => (/^[0-9]{1,5}$/.test(String(value)) ? String(value) : '')
  const urlTarget = (input) => {
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : String(input && input.url))
      return `${url.protocol}//${safeHost(url.hostname)}:${url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80)}`
    } catch { return 'unparsed-target' }
  }
  const optionsTarget = (value, port, host) => {
    if (Array.isArray(value)) value = value[0]
    if (value && typeof value === 'object' && !(value instanceof URL)) {
      if (value.path && !value.port && !value.host && !value.hostname) return 'unix-socket'
      return `${safeHost(value.hostname || value.host || 'localhost')}:${safePort(value.port || '')}`
    }
    if (typeof value === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(value)) return urlTarget(value)
    if (typeof value === 'string' && Number.isNaN(Number(value))) return 'unix-socket'
    if (typeof value === 'number' || typeof value === 'string') return `${safeHost(typeof port === 'string' ? port : host || 'localhost')}:${safePort(value)}`
    if (value instanceof URL) return urlTarget(value)
    return 'unknown-target'
  }
  const argsTarget = (args) => optionsTarget(args[0], args[1], args[2])

  // ---------------------------------------------------------------- sockets and protocols
  const net = require('node:net')
  const tls = require('node:tls')
  const http = require('node:http')
  const https = require('node:https')
  const http2 = require('node:http2')
  const dns = require('node:dns')
  const throwing = (kind) => function guardedConnect(...args) { throw deny(kind, argsTarget(args)) }
  net.connect = throwing('net.connect')
  net.createConnection = throwing('net.createConnection')
  net.Socket.prototype.connect = throwing('net.Socket.connect')
  tls.connect = throwing('tls.connect')
  for (const [name, mod] of [['http', http], ['https', https]]) {
    mod.request = throwing(`${name}.request`)
    mod.get = throwing(`${name}.get`)
  }
  http2.connect = throwing('http2.connect')
  if (typeof globalThis.fetch === 'function') {
    globalThis.fetch = async function guardedFetch(input) { throw deny('fetch', urlTarget(input)) }
  }
  if (typeof globalThis.WebSocket === 'function') {
    globalThis.WebSocket = class GuardedWebSocket { constructor(url) { throw deny('WebSocket', urlTarget(url)) } }
  }
  const dnsTarget = (host) => (typeof host === 'string' ? safeHost(host) : null)
  const dnsNames = (target) => Object.keys(target).filter((name) => typeof target[name] === 'function'
    && (name === 'lookup' || name === 'lookupService' || name === 'reverse' || name.startsWith('resolve')))
  for (const name of dnsNames(dns)) {
    dns[name] = function guardedDns(host) { throw deny(`dns.${name}`, dnsTarget(host)) }
  }
  for (const name of dnsNames(dns.Resolver.prototype)) {
    dns.Resolver.prototype[name] = function guardedResolver(host) { throw deny(`dns.Resolver.${name}`, dnsTarget(host)) }
  }
  for (const target of [dns.promises, dns.promises.Resolver.prototype]) {
    for (const name of dnsNames(target)) {
      target[name] = async function guardedDnsPromise(host) { throw deny(`dns.promises.${name}`, dnsTarget(host)) }
    }
  }

  // ---------------------------------------------------------------- local tool queries (exact)
  // tinypool 1.1.1 (dist/index.js) physical-CPU detection, byte-exact. Answered in-process with the
  // pipeline's semantics: number of distinct /proc/cpuinfo lines containing the needle, `wc -l`
  // output format. A read failure throws, exactly like a failed execSync (tinypool falls back to
  // os.cpus()). Nothing else is emulated.
  const CPU_QUERIES = new Map([
    ['cat /proc/cpuinfo | grep "physical id" | sort |uniq | wc -l', 'physical id'],
    ['cat /proc/cpuinfo | grep "core id" | sort | uniq | wc -l', 'core id'],
  ])
  const CPU_QUERY_OPTIONS = new Set(['encoding', 'stdio', 'windowsHide', 'timeout', 'maxBuffer', 'killSignal'])
  const cpuQuery = (name, args) => {
    if (name !== 'execSync' || args.length > 2 || typeof args[0] !== 'string' || !CPU_QUERIES.has(args[0])) return null
    const options = args[1] == null ? {} : args[1]
    if (typeof options !== 'object' || Array.isArray(options)) return null
    if (Object.keys(options).some((key) => !CPU_QUERY_OPTIONS.has(key))) return null
    return { needle: CPU_QUERIES.get(args[0]), options }
  }
  const answerCpuQuery = ({ needle, options }) => {
    const kind = `cpuinfo:${needle.replace(' ', '-')}`
    state.localToolQueries += 1
    state.localToolKinds[kind] = (state.localToolKinds[kind] || 0) + 1
    const record = { pid: process.pid, threadId, role, kind, at: where() }
    try { fs.appendFileSync(path.join(dir, `local-tool-queries-${id}.jsonl`), `${JSON.stringify(record)}\n`) } catch { /* counted in summary */ }
    const lines = fs.readFileSync('/proc/cpuinfo', 'utf8').split('\n').filter((line) => line.includes(needle))
    const output = `${new Set(lines).size}\n`
    return options.encoding && options.encoding !== 'buffer' ? output : Buffer.from(output)
  }

  // ---------------------------------------------------------------- processes and threads
  const cp = require('node:child_process')
  const withGuard = (value) => (String(value || '').includes(GUARD) ? value : `${value ? `${value} ` : ''}--require=${GUARD}`)
  const inject = (options) => {
    const env = { ...(options && options.env ? options.env : process.env) }
    env.NODE_OPTIONS = withGuard(env.NODE_OPTIONS)
    env.B2_NET_GUARD_ROLE = 'child'
    env.B2_NET_GUARD_DIR = dir
    return { ...(options || {}), env }
  }
  // Diagnostics never echo a command line or arguments: shell strings are a fixed category and an
  // executable is reduced to a validated basename.
  const SHELL_APIS = new Set(['exec', 'execSync'])
  const usesShell = (name, args) => SHELL_APIS.has(name)
    || args.some((arg) => arg && typeof arg === 'object' && !Array.isArray(arg) && Boolean(arg.shell))
  const safeExecutable = (value) => {
    const base = path.basename(String(value || ''))
    return /^[A-Za-z0-9._+-]{1,64}$/.test(base) ? base : 'invalid-executable'
  }
  const commandTarget = (name, args) => (usesShell(name, args) ? 'shell-command' : safeExecutable(args[0]))
  // The root may start only Node (fork, or the running node binary) and esbuild's service binary,
  // without a shell; a fork may not swap its execPath. Everything else is denied and visible.
  const ROOT_EXECUTABLES = new Set(['node', 'esbuild'])
  const rootAllowed = (name, args) => {
    const options = args.find((arg) => arg && typeof arg === 'object' && !Array.isArray(arg))
    if (name === 'fork') return !options || options.execPath == null || options.execPath === process.execPath
    return args[0] === process.execPath || ROOT_EXECUTABLES.has(path.basename(String(args[0] || '')))
  }
  const ARGV = new Set(['spawn', 'spawnSync', 'fork', 'execFile', 'execFileSync'])
  const optionsIndex = (name, args) => {
    if (!ARGV.has(name)) return 1
    if (Array.isArray(args[1]) || (args[1] == null && args.length > 2)) return 2
    return 1
  }
  for (const name of ['spawn', 'spawnSync', 'fork', 'exec', 'execSync', 'execFile', 'execFileSync']) {
    const original = cp[name]
    cp[name] = function guardedChildProcess(...args) {
      const query = cpuQuery(name, args)
      if (query) return answerCpuQuery(query)
      if (role !== 'root' || usesShell(name, args) || !rootAllowed(name, args)) throw deny(`child_process.${name}`, commandTarget(name, args))
      const index = optionsIndex(name, args)
      if (args[index] && typeof args[index] === 'object' && !Array.isArray(args[index])) args[index] = inject(args[index])
      else if (args[index] == null && index < args.length) args[index] = inject({})
      else args.splice(index, 0, inject({}))
      if (name === 'fork') {
        const execArgv = [...(args[index].execArgv || process.execArgv)]
        if (!execArgv.some((arg) => String(arg).includes(GUARD))) execArgv.push(`--require=${GUARD}`)
        args[index].execArgv = execArgv
      }
      return original.apply(this, args)
    }
  }
  const threads = require('node:worker_threads')
  const OriginalWorker = threads.Worker
  threads.Worker = class GuardedWorker extends OriginalWorker {
    constructor(filename, options = {}) {
      const execArgv = [...(options.execArgv || process.execArgv)]
      if (!execArgv.some((arg) => String(arg).includes(GUARD))) execArgv.push(`--require=${GUARD}`)
      const env = options.env && typeof options.env === 'object' ? { ...options.env, B2_NET_GUARD_ROLE: 'child', B2_NET_GUARD_DIR: dir } : options.env
      super(filename, { ...options, execArgv, env })
    }
  }

  require('node:module').syncBuiltinESMExports()  // ESM named imports see the guarded functions
  // Self-check: a guard that failed to install must stop the process, never fall through.
  if (net.connect.name !== 'guardedConnect' || net.Socket.prototype.connect.name !== 'guardedConnect'
      || cp.execSync.name !== 'guardedChildProcess' || cp.spawn.name !== 'guardedChildProcess'
      || (typeof globalThis.fetch === 'function' && globalThis.fetch.name !== 'guardedFetch')) {
    throw new Error('B2_NET_GUARD: installation failed')
  }
  const writeSummary = () => {
    try { fs.writeFileSync(path.join(dir, `summary-${id}.json`), JSON.stringify(state)) } catch { /* reported as missing */ }
  }
  writeSummary()  // present even if the process is killed; updated at exit
  process.on('exit', writeSummary)
}
