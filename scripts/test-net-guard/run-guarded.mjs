#!/usr/bin/env node
// Test-only harness (B2): run one test command with net-guard.cjs preloaded in every process.
//
//   node scripts/test-net-guard/run-guarded.mjs [--vitest] [--expect-worker] -- <command> [args...]
//
// Exit codes: the command's own non-zero status; 3 = guard denials recorded (outbound network or a
// non-adapted child process/shell), even if the command passed because a library swallowed the
// error; 4 = guard not active in the command process; 5 = --expect-worker but no guarded descendant
// (fork/worker) reported; 2 = usage/refused.
// --vitest appends --pool=forks (refusing any other pool) so test files run in guarded forks, and
// the offline test-only config vitest.offline.config.mjs (refusing any other --config/-c), so the
// app's vite.config.ts and its production plugins are never loaded.
// The summary reports mocked local tool queries (exact tinypool CPU queries answered in-process)
// separately; they are tooling requests, so the total is never reported as zero when they occurred.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const guard = fileURLToPath(new URL('./net-guard.cjs', import.meta.url))
const offlineConfig = fileURLToPath(new URL('./vitest.offline.config.mjs', import.meta.url))
const argv = process.argv.slice(2)
const split = argv.indexOf('--')
if (split < 0 || split === argv.length - 1) {
  console.error('usage: run-guarded.mjs [--vitest] [--expect-worker] -- <command> [args...]')
  process.exit(2)
}
const flags = new Set(argv.slice(0, split))
const unknown = [...flags].filter((flag) => !['--vitest', '--expect-worker'].includes(flag))
if (unknown.length) {
  console.error(`unknown flags: ${unknown.join(' ')}`)
  process.exit(2)
}
const [command, ...args] = argv.slice(split + 1)
if (flags.has('--vitest')) {
  const pools = args.filter((arg) => arg.startsWith('--pool'))
  if (pools.some((arg) => arg !== '--pool=forks')) {
    console.error('[b2-net-guard] refused: only --pool=forks runs test files in guarded child processes')
    process.exit(2)
  }
  if (!pools.length) args.push('--pool=forks')
  const configs = []
  args.forEach((arg, index) => {
    if (arg === '--config' || arg === '-c') configs.push(args[index + 1])
    else if (arg.startsWith('--config=')) configs.push(arg.slice('--config='.length))
  })
  if (configs.some((value) => !value || resolve(value) !== offlineConfig)) {
    console.error('[b2-net-guard] refused: --vitest runs only with the offline test-only config')
    process.exit(2)
  }
  if (!configs.length) args.push(`--config=${offlineConfig}`)
}

const dir = mkdtempSync(join(tmpdir(), 'b2-net-guard-run-'))
const env = { ...process.env, B2_NET_GUARD_DIR: dir }
delete env.B2_NET_GUARD_ROLE
env.NODE_OPTIONS = String(env.NODE_OPTIONS || '').includes(guard) ? env.NODE_OPTIONS : `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--require=${guard}`
const result = spawnSync(command, args, { stdio: 'inherit', env })

const files = readdirSync(dir)
const lines = (prefix) => files.filter((name) => name.startsWith(prefix))
  .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
const summaries = files.filter((name) => name.startsWith('summary-')).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
const violations = lines('violations-')
const localQueries = lines('local-tool-queries-')
const count = (records) => {
  const out = {}
  for (const record of records) out[record.kind] = (out[record.kind] || 0) + 1
  return out
}
const summary = {
  processes: summaries.length,
  roots: summaries.filter((item) => item.role === 'root').length,
  children: summaries.filter((item) => item.role === 'child').length,
  attempts: violations.length,
  allowedOutbound: summaries.reduce((total, item) => total + item.allowedOutbound, 0),
  kinds: count(violations),
  mockedLocalToolQueries: localQueries.length,
  localToolKinds: count(localQueries),
  toolingRequestsTotal: violations.length + localQueries.length,
  commandStatus: result.status,
  commandSignal: result.signal,
}
console.error(`[b2-net-guard] summary ${JSON.stringify(summary)}`)
for (const record of violations.slice(0, 50)) console.error(`[b2-net-guard] violation ${JSON.stringify(record)}`)

if (result.error) {
  console.error(`[b2-net-guard] command could not start: ${result.error.code || 'error'}`)
  process.exit(2)
}
if (result.status !== 0) process.exit(result.status || 1)
if (violations.length > 0) process.exit(3)
if (summary.roots < 1) process.exit(4)
if (flags.has('--expect-worker') && summary.children < 1) process.exit(5)
process.exit(0)
