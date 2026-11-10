# Changelog

All notable changes to Hermes Workspace are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Source candidate — PR2 direct blocked-to-completed status fix (not deployed)
- A native mission observed `blocked` and then directly `completed` (no intermediate queued/running/reviewing poll) kept the obsolete blocker as `streamError`, so the hook saved a genuinely completed mission as failed and showed "Mission Stopped". Authoritative native completion now clears only the exact blocker message from the latest native blocked observation, in the same update that enters `complete`, before history persistence. Failed/cancelled terminals and unrelated errors are unchanged.
- Real-hook JSDOM regression: blocked poll, then the next timed poll returns completed directly; asserts no error, "Mission Complete" UI, exactly one completed history entry and no failed/blocker history write. A direct blocked-to-failed control keeps failed status and its terminal error. Exact public d817/tree393 product with the same test: 1 FAIL / 5 PASS; candidate 6/6. Full guarded selection 33 files/342 PASS on Node26; focused Node22 11/11. TSC 92 and touched-file ESLint 13 diagnostics unchanged by identity (non-green baseline). Root final OS build and same-Reviewer review remain pending.

### Source candidate — PR1 integration regressions (not deployed)
- Align checked-in sample roster ids/profiles and AGENTS contract with the unchanged six-identity execution policy. Metadata is not installed profile/config/tool evidence; private roster migration remains explicit and operator-owned, with no aliases or profile bootstrap.
- Select the latest applicable exact profile/session admission across correction/continuation history; preserve current Native running/waiting/unknown evidence instead of publishing an earlier terminal turn as current completion.
- Keep native approval waits and blockers resumable with explicit worker/UI states and polling. Managed mission completion/history now requires the actual terminal mission status, not an absence of active workers.
- Remove unsupported Conductor model-override controls/catalog helpers and migrate persisted settings to supported mission fields. Launch/persistence whitelist those fields; saved Native profile routes remain authoritative and the server's override rejection is unchanged.
- Preserve credential-free gateway model discovery when Dashboard is absent; use Dashboard only in its advertised context. Keep known local models during optional catalog outages, retain real auth refusals and project only safe remote catalog metadata.
- Author proof: pristine merged e1 with final regression fixtures yields 19 FAIL / 8 PASS; candidate passes the same 30 existing files/313 tests plus 27 new cases (33 files/340 tests) on existing Node22 and Node26, no test guard denials/outbound. TSC remains92, original targeted lint11; touched lint60->57 removes only three diagnostics with retired selector helpers, introduces none. Guarded build remains NON-GREEN (tool0/guard3, tsx Unix IPC denial); final exact-head OS build and independent source/runtime acceptance remain Root gates. See `docs/argus-c2-handover.md`.

### Source candidate — server-authored C2-1 raw RPC boundary repair (not deployed)
- Validate the complete Native `prompt.prepare_input` and `prompt.lookup_input` responses before extraction: closed nested keys, exact version/reference/principal/input/fingerprint/fence, safe JSON integers, and admission/state/settlement consistency. Expanded or malformed evidence cannot submit or positively reconcile UNKNOWN; valid nonpositive owner receipts remain nonpositive without retry/release fallback.
- Add independent Python execute/RPC regression cases using fresh real accepted Native authority/SQLite receipts behind explicitly labelled discovery/transport fixtures. Re-record the existing five-scenario contract fixture through its unchanged recorder; no expected response is hand-edited.
- Adapt only the W1 test's browser fixture to the original JSDOM window's real Storage under Node 26. Preserve all seven W1 production UI paths and all original identity/no-fabrication assertions.
- Author checks: 167 boundary/recording tests plus 11 unchanged existing-session bridge tests through the official Native runner; 313 guarded tests in the same 30 Workspace files on each existing Node 22 and Node 26 tool. Baseline full TSC 92 and original targeted ESLint 11 diagnostics remain non-green with no diagnostic-identity changes; W1 test-only lint separately retains its seven baseline diagnostics.
- Derived only from the existing server f49 source, owning review and accepted Native contracts, without importing another private candidate. Independent Reviewer acceptance, Root canonical commit binding/OS build/C2/publication/live and the original real-GPU roundtrip remain separate gates. See `docs/argus-c2-handover.md`.

### Source candidate — Workspace C2 client / P-1 batch preparation (not deployed)
- Consume the separately sealed Native `original-input-lookup-v1` contract. Persist the exact prepared original-attempt principal/ref/fingerprint/fence binding before existing-session submission; reconcile a lost ACK read-only, bind matched admission ownership once, and preserve sticky UNKNOWN/reservations on absent, mismatched or unavailable evidence.
- Make prospective batch create+stage all-or-nothing before Native calls, with synchronous latest-store revalidation and duplicate/profile/session contention checks. Retain all post-submit rows and individual receipts; preserve initial/correction/accepted-continuation flows and seven W1 identity/model UI paths.
- Keep raw official Native component recordings and guarded Workspace replay as separate evidence. Direct subprocess guard denial and pre-approval recording/replay remain incident evidence, not accepted integration proof. No guard/policy/lockfile weakening or implicit installer is used by final checks.
- Full TypeScript and targeted ESLint retain baseline non-green findings with exact diagnostic signatures. Cross-process C2 integration, independent review, exact-head OS build/runtime, real GPU/main/live qualification remain OPEN. See `docs/argus-c2-handover.md`.

### Source candidate — producer/reconcile V1 (independent review pending; not deployed)
- Add explicit opted-in existing-Developer initial, exact changes-required correction and accepted-continuation transitions, preserving request authority, binding and the Native atomic idle fence.
- Persist exact non-accepted reviewer metadata without accepting the producer artifact; reject unsupported producer transitions and changed dependencies with typed errors rather than silently queuing.
- Keep lost-ACK UNKNOWN sticky with a typed producer retry refusal. Original-input reconciliation is **BLOCKED** pending a separately approved Native read-only capability; no replay/resubmit/unlock is added.
- Remove the board-specific auth debug read and dead private one-shot execution path; retain the actual generic verification consumer and exported tested helpers. C3 callback-owner confirmation and C6 auth-scoped refresh coalescing remain explicit reviewed follow-ups.
- Preserve all W1 identity/UI source and accepted Native R1. Model artifact text is not independent cryptographic Git/hash proof; build/runtime/GPU/publication gates remain separate.

### Source candidate — task-bound GPU / SAME Developer (not deployed)
- Port only the mapped native-control/auth/model/profile prerequisites from pinned snapshot `1b3da6c…`, then the accepted 17-file B2 delta onto operator-fork main `c631425…`; preserve separate provenance for pre-existing fixes. No live roster/profile/config is copied.
- Add default-off `ARGUS_WORKSPACE_GPU_SOURCE_ENABLED` support for one explicitly selected existing `argus-developer` session using genuine new assignment/request/admission identities, the existing authenticated same-origin authority and the accepted Native `idle-admission-v1` transaction fence. No session fallback, backdating or UNKNOWN retry.
- Pin Native API tree `942e0bf3…` unchanged. GPU job/result ownership flows through its actual sealed invocation origin and the Argus host adapter, not a Workspace/model dictionary or tracking card.
- Author checks: 229 guarded Vitest tests (21 files), 24 bridge fixture tests and one actual Native parser/authority/admission integration pass. Guarded build emits client/SSR bundles but exits 3 for `tsx` IPC denial; full-project TypeScript retains baseline failures. Neither is reported as a green qualification.
- Independent source/history QA, operator commit binding, disposable PostgreSQL/hosted CI/current-head C2 and an explicitly authorized real GPU original-task roundtrip remain gates. No production, publication, inference or service action occurred. See `docs/argus-native-swarm.md`.

### Source candidate W1 — truthful Hermes worker identity (not deployed; independent QA pending)
- Restore the seven reviewed UI identity paths from exact operator commit `b15e0958…` (selected proof pack; `c631425…` -> `b15e0958…` -> `50a505c4…` ancestry verified) instead of their reverted `c631425…` forms: actual profile list query, configured vs reported provider/model labels with "execution unverified", model-catalog loading/error/retry/empty feedback, real session labels and actual native worker ids. Fabricated Nova/Pixel/Blaze personas, placeholder agents and `model: 'native-swarm'` are removed.
- One reviewed type correction to the exact b15 hook: an unknown native-worker raw session model is `undefined` (absent), not `null`, matching `GatewaySession.model?: string`; behavior stays "model unknown" and introduces no TypeScript diagnostic.
- Owning regression coverage: lib provenance, profile-list hook (single failed request, no secret fields), modal loading/error/retry/empty, office without placeholders, session-label fallback, native-swarm worker ids/unknown models, and Conductor profile panel/error rendering. Guarded offline Vitest: 25 files / 245 tests, denials 0, outbound 0. Full TypeScript keeps the same 92 baseline diagnostics (exit 2, not green); guarded build qualification remains a separate ROOT-isolated step.
- No `swarm.yaml`, profile, credential, guard-policy, runtime or B2/native change. See `docs/argus-native-swarm.md`.

### Changed
- **`docker compose up` now pulls pre-built images by default** (#82) — `nousresearch/hermes-agent:latest` for the gateway and `ghcr.io/outsourc-e/hermes-workspace:latest` for the UI. Agent state persists in the `claude-data` named volume. Adds `docker-compose.dev.yml` overlay for building from source.

## [2.0.0] — 2026-04-20

**Zero-fork release.** Clone, don't fork. Hermes Workspace now runs on vanilla `pip install hermes-agent` with no patches, no drift, no custom gateway required.

### Added
- **Zero-fork architecture** — dual gateway/dashboard routing; workspace talks directly to vanilla `hermes-agent` 0.10.0+ via standard endpoints (`/v1/models`, `/api/sessions`, `/api/skills`, `/api/config`, `/api/jobs`)
- **One-liner curl installer** — `curl -fsSL … | bash` provisions workspace + gateway + defaults
- **Claude-Nous theme** — dark + light editorial variants with cobalt/paper surface pass, thin 1px architectural borders, editorial type accents
- **Conductor** (`/conductor`) — mission-control surface ported from Clawsuite; spawn missions, assign workers, watch live output and costs
- **Operations** (`/operations`) — agent registry / sessions manager ported from Clawsuite; pause, steer, kill live agents with role and model insight
- **Synthesized tool pills** — inline tool-call rendering from dashboard stream markers when running against zero-fork gateway
- **Landing parity pass** — hero, features, screenshots, setup, OG image, mobile theme toggle
- **Task board status vs. assignee** decoupling
- **Local-model chat session persistence** — local sessions appear in history + session list
- **Memory is local-fs first** — honors `HERMES_HOME`, no gateway dependency
- **Splash + screenshots refresh** — Conductor, Dashboard, Tasks, Jobs captured in new editorial theme

### Changed
- **Model picker** — fetches from gateway (`~/.hermes/models.json` for user-configured models), matches OCPlatform behavior; shows only configured providers instead of all upstream
- **`enhanced-fork` mode label** no longer implies a fork is required; it indicates streaming route availability on vanilla gateway
- **Dashboard + enhanced-chat capabilities** marked optional; missing endpoints no longer trigger warnings
- **Feature-gate + install copy** — all fork-era references purged
- **Theme family allowlist** — `claude-nous` promoted to the enterprise allowlist
- **Session pill** — solid dark-mode background, matches model selector

### Fixed
- Duplicate responses and disappearing history on interrupt (#62)
- Portable-mode double user message, uncleaned timeouts, orphaned unregister callbacks
- Local model selection actually propagates to chat (no silent fallback)
- Strip provider prefix correctly for local routing
- Dashboard token injection on `/` (not `/index.html`)
- Onboarding no longer stacks behind workspace shell
- Root bootstrap guards against uncaught errors
- Preserve assistant text during tool-call streaming
- Installer output uses defined escape vars (removed undefined BOLD/RESET)

### Removed
- All references to the legacy "enhanced fork" as a requirement
- Stale fork-era gateway instructions and feature-gate copy

---

## [1.0.0] — 2026-04-10

Initial public release. Chat, files, memory, skills, terminal, dashboard, settings — the foundational workspace.
