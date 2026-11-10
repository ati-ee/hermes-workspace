# Hermes Workspace Agent Contract

The checked-in `swarm.yaml` is a sample identity roster for the supported ARGUS execution policy,
not proof that any profile, tool, skill, wrapper, provider or model is installed. Execution requires
an existing exact readable profile and the unchanged authenticated Native admission path.

## Supported sample identities

| Worker/profile id | Responsibility |
|---|---|
| `orchestrator-argus` | Sole operator-controlled dispatcher |
| `argus-architect` | Architecture and approved requirements |
| `argus-developer` | Implementation |
| `argus-developer-local` | Explicitly operator-selected local implementation |
| `argus-reviewer` | Independent source review |
| `argus-validator` | Independent acceptance validation |

Models/providers/routes come from existing operator-managed profiles, never sample metadata.
`default` and `whatsapp` are identity-only; legacy `orchestrator`/`builder`/`reviewer` templates
are not execution targets. Do not install, rename or auto-migrate real profiles, core skills or
wrappers. Before deployment, the operator must compare/back up the private roster and explicitly
align its id/profile metadata with already-existing supported profiles; missing profiles stay
unavailable. Never replace a private roster with this sample automatically.

## Operating rules

- Keep sample worker ids/profile fields aligned with the execution allowlist. Actual profile config, skills and wrappers remain operator-owned; source changes never provision them.
- Prefer GBrain-first lookup for context-sensitive RAZSOC/Hermes/workflow decisions.
- Builder implements; Reviewer gates; QA verifies behavior; Orchestrator routes and enforces greenlight.
- Do not enable optional Hermes plugins globally unless the task explicitly needs them; record plugin/toolset alignment in `swarm.yaml` first.
- For local Workspace pairing/debugging, treat **one gateway + one dashboard** as canonical: `hermes gateway run` on `:8642` and `hermes dashboard` on `:9119`. Before starting another gateway, verify `curl http://127.0.0.1:3000/api/sessions` (or the active workspace port) first. If Sessions already returns data, refresh/reprobe the UI instead of spawning a duplicate gateway.
- If the default model is `gpt-5.4` / `openai-codex`, remember that chat depends on a live local Codex CLI login (`codex login`).

## Windows-specific notes (2026-06-01)

- **Three services required**: Gateway (:8642) + Dashboard (:9119) + Workspace (:3000). All must be running for full functionality.
  - Gateway: `hermes gateway run`
  - Dashboard: `hermes dashboard --port 9119 --host 127.0.0.1 --no-open`
  - Workspace: `pnpm dev`
  - Or use the Electron desktop app: `pnpm electron:dev` (auto-starts all three)
- **Desktop app**: Full Electron app (`electron/main.cjs`). Double-click to launch — no terminal needed. Auto-detects and spawns gateway (or dashboard if configured).
- **Build**: `electron:build:win` produces NSIS installer in `release/`.
- **Dev mode**: `electron:dev` launches Electron in dev mode (builds Vite client first, hot-reloads on change).
- **Running build output**: `release/win-unpacked/hermes-workspace.exe` (test builds).
- **Electron:dev fix**: `NODE_ENV=development` prefix doesn't work on Windows — script stripped to just `electron .`.
- **Windows spawn fixes** (in `electron/main.cjs`): `spawnDetached()` uses `cmd /c` on Windows (not `bash -lc`), log paths use `%TEMP%` (not `/tmp`), `isHermesInstalled()` uses `where hermes`, `installHermesInBackground()` uses `pip install` (not `curl|bash`).
- **Two `.env` files**: Gateway reads `C:\\Users\\<you>\\AppData\\Local\\hermes\\.env`; CLI reads `C:\\Users\\<you>\\.hermes\\.env`; workspace reads `hermes-workspace\\.env`. Keep API keys in sync across all three.
- **Gateway API server**: Requires `API_SERVER_ENABLED=true` + `API_SERVER_KEY` in the gateway's `.env`. Without these, the gateway starts with no connected platforms.
- **Workspace env vars**: Runtime reads `CLAUDE_API_URL` / `CLAUDE_API_TOKEN` / `CLAUDE_DASHBOARD_URL` (not `HERMES_*` variants).
- **sqlite3 CLI**: Not bundled on Windows. Install via `winget install SQLite.SQLite`, then copy `sqlite3.exe` to a Git Bash PATH directory (winget installs to a long path not in PATH).
- **claude CLI**: Required for Claude Tasks / Conductor features. Install via `npm install -g @anthropic-ai/claude-code`.
- **Port conflicts**: Use `netstat -ano | findstr :<port>` + `Stop-Process -Id <PID> -Force` (PowerShell) — `lsof` not available in Git Bash on Windows.
- **PWA install**: Dashboard at `http://127.0.0.1:3000` can be installed as PWA via Chrome/Edge address bar install icon. Prefer Electron build for production.
- **Slack invalid_auth**: Expected if Slack tokens aren't configured — ignore, doesn't affect core functionality.
- **Node version**: Requires Node.js 22+. Check with `node --version`.
- **`NODE_OPTIONS` stripped**: Windows doesn't support env var prefix in npm scripts — removed from `build` and `electron:dev` scripts.
