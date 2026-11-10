// Offline TEST-ONLY Vitest config for the focused B2 server/route unit tests (used by
// run-guarded.mjs --vitest). It deliberately does NOT load the app's vite.config.ts: that file
// imports the production TanStack Start / React / Tailwind / tsconfig-paths plugins, and their
// tooling (tsx's client) opens a parent IPC Unix socket on import, which the guard must deny.
//
// Differences from vite.config.ts (all intentional; this is not a build or app config):
// - no plugins, no dev server, no daemon/agent auto-start, no define/ssr settings;
// - the same '@' -> ./src alias (the only alias vite-tsconfig-paths provides via tsconfig paths);
// - the same test excludes; node environment; forks pool; the six focused files only.
// The React deps.inline setting is omitted: the focused files are server/route units without React.
// Only node:url is imported, so loading this config needs no package resolution.
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))

export default {
  root,
  // Numeric loopback server-address metadata. No server is listened on or launched. Vite's
  // resolveHostname() runs getLocalhostAddressIfDiffersFromDNS() (dns.promises.lookup('localhost'))
  // only when the host is 'localhost', which is its default; an explicit numeric host skips that
  // lookup, so the guard's DNS denial stays fully in force and is not exercised at startup.
  server: {
    host: '127.0.0.1',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../../src', import.meta.url)),
    },
  },
  test: {
    root,
    environment: 'node',
    pool: 'forks',
    include: [
      'src/routes/api/-swarm-dispatch.test.ts',
      'src/routes/api/-dashboard-auth-board-scope.test.ts',
      'src/routes/api/-swarm-producer-reconcile.test.ts',
      'src/routes/api/-swarm-batch-atomic.test.ts',
      'src/routes/api/-swarm-native-lookup-contract.test.ts',
      'src/server/swarm-native-existing-session.test.ts',
      'src/routes/api/-swarm-dispatch-existing-session.test.ts',
      'src/server/swarm-native.test.ts',
      'src/server/swarm-pr1-regressions.test.ts',
      'src/screens/gateway/conductor-pr1-regressions.test.tsx',
      'src/routes/api/-models-pr1-regressions.test.ts',
      'src/server/swarm-native-delta02.test.ts',
      'src/routes/api/-swarm-native-api.test.ts',
      'src/server/swarm-missions.test.ts',
      // V2 impact-selected prerequisites; network/process guard policy is unchanged.
      'src/server/swarm-discovery.test.ts',
      'src/server/swarm-roster-archive.test.ts',
      'src/server/swarm-legacy-native-guard.test.ts',
      'src/server/dashboard-native-auth.test.ts',
      'src/routes/api/-dashboard-auth-delta02.test.ts',
      'src/routes/api/-legacy-gaps-delta03.test.ts',
      'src/routes/api/-checkpoint-delta04.test.ts',
      'src/routes/api/-conductor-spawn.test.ts',
      'src/routes/api/-swarm-task-feed.test.ts',
      'src/routes/api/__tests__/-models.test.ts',
      'src/server/__tests__/gateway-capabilities.test.ts',
      'src/components/dashboard-auth-notice.test.tsx',
      'src/lib/argus-main.test.ts',
      'src/lib/argus-swarm-policy.test.ts',
      'src/lib/native-timestamps.test.ts',
      // W1 owning identity/UI regressions (jsdom per file); guard policy unchanged.
      'src/lib/hermes-worker-identity.test.ts',
      'src/hooks/use-hermes-profile-identities.test.tsx',
      'src/screens/agents/components/operations-new-agent-modal.test.tsx',
      'src/screens/gateway/w1-worker-identity.test.tsx',

    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/skills-bundle/**',
      '**/.{idea,git,cache,output,temp}/**',
    ],
  },
}
