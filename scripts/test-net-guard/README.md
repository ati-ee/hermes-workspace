# Test-only zero-outbound-network guard (B2)

This guard is for offline test invocations. It is not loaded by the app, the build or the dev server.
The app's `vite.config.ts`, tsconfig, package and lock files are unchanged. Use it to prove that the
focused tests open no outbound connections.

## What it does

- **Preload everywhere.** `net-guard.cjs` is preloaded with `--require` into every Node process of
  the run: the runner (root), every Vitest fork, every spawned or forked Node child (through
  `NODE_OPTIONS` and fork `execArgv`) and every `worker_threads` worker.
- **Network denials.** Before any socket or DNS query exists, it denies:
  - `fetch` and `WebSocket`;
  - `http`/`https` `request` and `get`, and `http2.connect`;
  - `net.connect`, `net.createConnection` and `net.Socket#connect`, for TCP and Unix sockets;
  - `tls.connect`;
  - every `dns` lookup, resolve and reverse call (callback, `Resolver` and promises APIs).
- **Process denials.**
  - The root may start only Node (a `fork` without a swapped `execPath`, or the running node binary)
    and esbuild's service binary, and never through a shell.
  - Shell APIs (`exec`/`execSync`, or any `shell` option) and every other executable are denied in
    the root too.
  - In descendant processes, every `child_process` API is denied, which closes the
    curl/python/shell fallback.
- **Privacy-safe diagnostics.** Denials are recorded as the API name plus a validated `host:port`, a
  fixed `shell-command` category, or a validated executable basename. Command lines, arguments, URL
  paths, queries, headers, bodies and credentials are never recorded.
- **Allowed outbound connections: none** (`allowedOutbound` is always 0).
- **Local tool queries (test-only tooling adapter).** tinypool 1.1.1 runs two read-only CPU queries
  through `execSync` when it is imported:
  - `cat /proc/cpuinfo | grep "physical id" | sort |uniq | wc -l`
  - `cat /proc/cpuinfo | grep "core id" | sort | uniq | wc -l`

  How the adapter treats them:
  - Only these exact bytes, through `execSync` only and with no `env`/`cwd`/`shell`/`input`
    options, are answered in-process.
  - The answer is computed from `/proc/cpuinfo` with Node's `fs`, with the same semantics: the number
    of distinct matching lines, in `wc -l` output format. No shell or child process is started.
  - A read failure throws, exactly like a failed `execSync`, and tinypool then falls back to
    `os.cpus()`.
  - These queries are counted separately as `mockedLocalToolQueries` (inside
    `toolingRequestsTotal`). They are not reported as zero tooling requests.
  - Any other spelling, API or option set is denied and makes the run non-green.
- **Non-green conditions.** `run-guarded.mjs` exits non-green when any of these happen:
  - exit 3: any denial was recorded, even if a library caught the error;
  - exit 4: the guard was not active in the command;
  - exit 5: `--expect-worker` was given and no guarded fork or worker reported.
- **`--vitest` mode.** It forces `--pool=forks` and the offline test-only config
  `vitest.offline.config.mjs`, and refuses any other pool or `--config`/`-c`.

## Offline test-only Vitest config

`vitest.offline.config.mjs` exists because the app's `vite.config.ts` imports the production
TanStack Start, React, Tailwind and tsconfig-paths plugins. Their tooling (the `tsx` client)
unconditionally opens a parent IPC Unix socket on import, and the guard correctly denies it.

The offline config:
- has no plugins, no dev server, no daemon or agent start, and no define or ssr settings;
- keeps the same `@` → `./src` alias and the same test excludes;
- uses the node environment and the forks pool;
- includes exactly the six focused server and route files.

It is not a build config. No full-app, build or production-plugin claim is made from runs that use
it.

## Exact local commands (existing locked tools; nothing is installed or downloaded)

Check the guard itself with Node built-in tests:

```sh
node --test scripts/test-net-guard/net-guard.node-check.mjs
```

The network targets are a loopback listener owned by the test, which must see zero connections.
The CPU-query reference is the real pipeline, run once by the unguarded test runner as a local file
read.

Run the focused B2 Vitest files under the guard. The offline config is injected automatically:

```sh
node scripts/test-net-guard/run-guarded.mjs --vitest --expect-worker -- \
  node /home/hermes-dev/workspace/hermes-workspace-ui/node_modules/vitest/vitest.mjs run \
  src/server/swarm-native-existing-session.test.ts src/routes/api/-swarm-dispatch-existing-session.test.ts \
  src/server/swarm-native.test.ts src/server/swarm-native-delta02.test.ts \
  src/routes/api/-swarm-native-api.test.ts src/server/swarm-missions.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

The last stderr line `[b2-net-guard] summary {...}` reports:
- `processes`, `roots` and `children`;
- `attempts` (denials);
- `allowedOutbound`;
- `mockedLocalToolQueries`, `localToolKinds` and `toolingRequestsTotal`.

## Residual limitations

- Native addons, or sockets and processes opened below the JS layer, are outside the reach of a JS
  preload. Nothing below JS is claimed isolated.
- esbuild's native service binary started by the root is not guarded inside: it is not a Node
  process.
- The adapter emulates exactly two read-only CPU queries and nothing else.
- The focused fixtures also mock `gateway-capabilities` and `kanban-dashboard-proxy`, which probe
  the local gateway and dashboard on import.
