# Existing-profile ARGUS Swarm

## Authority and visibility

`src/lib/argus-swarm-policy.ts` is the shared identity/evidence policy. Execution is limited to `orchestrator-argus`, `argus-architect`, `argus-developer`, `argus-developer-local`, `argus-reviewer`, and `argus-validator`. `default` and `whatsapp` are identity-only, never execution targets.

`src/server/swarm-profile-policy.ts` intersects that allowlist with a unique, nonarchived `swarm.yaml` entry and an existing readable, nonsymlinked `config.yaml` in the exact canonical profile directory. Metadata cannot create a bot, select its provider/model, or make an alias into another robot. Dot/cache/tombstone directories and parked/stock profiles are excluded even when they contain configuration files. Filtering is reversible source/display policy; no profile, history, credential, session, or cache is deleted.

The configured model/provider summary comes from existing profile discovery, not static `swarm.yaml` model strings. Reported native model/provider are separately labelled. Missing model/provider never proves that a worker is executing.

## Native admission

Conductor prepares exactly one assignment for the sole dispatcher, `orchestrator-argus`. Explicit single-profile dispatch and direct chat share `dispatchNativeAssignments`; broadcasts and caller-minted profiles are rejected.

The bounded Python bridge binds `HERMES_HOME` and `HERMES_PROFILE` before requesting authority. It calls `discover_gateway_endpoint(profile_home)`, checks the exact endpoint/profile identity, and uses only `connect_gateway(endpoint=...)`. There is no default connection, gateway startup, shell/CLI fallback, profile bootstrap, credential copying/linking, route override, or model override. Existing profile settings are followed. `yolo=False`, `finite=False`, and `unattended=False` retain attended approval; once/deny and transcript interaction remain in Desktop.

The adapter checks supported live-work metadata before creating a session. Busy or unverifiably idle profiles are rejected without preemption. The Workspace persists the request before admission and reserves each unresolved native execution profile. An ambiguous transport/receipt failure is fenced, not automatically retried or replayed. This is a single-Workspace-process file-store reservation, not a distributed lock across unrelated native clients; the gateway remains admission authority.

Session creation sends `cwd_explicit: false`: the installed native policy, not Workspace's cwd or roster metadata, resolves the saved local/SSH terminal context. Inspection uses `session.info` and exact profile/session/admission receipt refs, not `session.resume` or its compression tip. Although the installed canonical resume schema accepts `omit_messages`, the installed handler does not implement it; no such flag is relied upon.

## Truthful state and provenance

Crew, runtime, chat metadata, office scenes, Conductor cards, selectors, and Swarm cards use the shared roster and supported scalar native observations. Native `session.list` defaults to the live feed: its `running` flag reflects the execution handle, not an absent end time or a last message. `session.info` supplies reported model/provider. Status requests never create/resume sessions, submit prompts, subscribe to events, or fetch transcripts of ordinary sessions.

Profile readiness, gateway connectivity, and execution are separate fields. Evidence expires after 60 seconds; unavailable or expired evidence becomes unknown/offline, not fabricated idle/active. Request coalescing lasts five seconds; there is no background server poller. Existing foreground UI query refreshes remain.

An ordinary native GUI session keeps its real source/title/session identity and is explicitly not a Workspace managed run. Only an exact persisted profile/session binding adds mission/assignment/admission identities. Native Runtime view shows metadata and directs the operator to Desktop; it does not start a replacement shell/worker. Old failed/completed/cancelled missions remain historical, keep stored timestamps, and do not contribute to active counts. A blocked tracking card is not evidence of a running managed job or a human approval request.

## Task completion and review

A completed native model turn is not task completion. A terminal successful receipt must include a valid structured checkpoint and a final line:

`SWARM_DELIVERY: {"artifact":{"revision":"<40 lowercase hex>","sha256":"<64 lowercase hex>","path":"<frozen artifact>"}}`

Only terminal completed receipts can supply final text. Prefer durable `prompt.receipt(include_result=True).result.final_response`, revalidate its exact ref/admission, and expose only the final response plus allowlisted receipt metadata (no result object, reasoning or transcript). Replay fallback matches the canonical envelope's top-level `session_id`/`admission_id`, never payload admission identity; a replay gap cannot fabricate delivery.

Implementation deliveries require review. A dependent `argus-reviewer` assignment must itself have an exact completed native admission and scoped artifact, plus a `review` object in that delivery containing the target `assignmentId`, exact target `revision` and `sha256`, and `verdict: "accepted"`. A label, legacy checkpoint/review API, stale runtime file, unrelated review, or different digest cannot satisfy the dependency. Terminal native records are immutable and are not replayed into a new completion timestamp.

These bindings gate the Workspace workflow; they do not replace independent inspection of the actual frozen file/diff and checksums. Failed/ambiguous/rejected evidence needs explicit operator reconciliation or a new bounded assignment, not automatic resubmission. Native cancellation/reset is rejected by legacy controls; use the exact Desktop session/admission so other work is not interrupted.

## Existing reviewer session selection (B2, opt-in)

By default every native assignment gets a new session (`session.create`). One assignment may instead set `existingSessionId` to the FULL id of one existing ordinary `argus-reviewer` session (a profile id alone is never enough). It is accepted only for a NEW `argus-reviewer` code review whose `dependsOn` names assignments of the same mission that already delivered an exact frozen artifact (40-hex revision, 64-hex sha256, path), added to that existing mission:

`POST /api/swarm-dispatch {"missionId":"<mission>","assignments":[{"workerId":"argus-reviewer","task":"<review task>","dependsOn":["<developer assignment>"],"existingSessionId":"<full session id>"}]}`

- Authority: only the authenticated route issues it, per request: password protection enabled with a valid login cookie, exact `Content-Type: application/json`, an `Origin` equal to the Workspace origin and no cross-site fetch metadata. It is a server-held object, never a body field or flag; `dispatchNativeAssignments`, `createOrUpdateMission` and `stageNativeAssignment` refuse a binding without it before any store write or native call. Behind a proxy that rewrites the request URL origin the check fails closed.
- The selection is persisted on the assignment and is immutable (another id, or none, for the same assignment is `session_binding_immutable`). A repeated or concurrent identical request reuses that assignment and its single admission. While one native reviewer admission is submitting/queued/started/unknown, the profile and the session stay reserved.
- Native contract: the gateway must advertise `idle-admission-v1` in `runtime.describe`, else the bridge stops with `native_idle_fence_unavailable` before attaching. The bridge requires the session in the LIVE `session.list` with an ordinary source (`desktop`, `local`, `cli`, `tui`), attaches with `session.resume {session_id, metadata_only: true}` (no transcript, no pending text, no cold restore, no policy refresh), requires idle state, `pending_count: 0`, matching source and `yolo: false`, then submits `prompt.submit {..., idle_fence: {expected_generation}}`. The owner re-checks that generation, queued/started/unknown admissions and live workers inside the admission's own write transaction. A typed refusal (`session_busy`, `stale_generation`, ...) is not admitted. A lost reply or `admission_conflict` stays UNKNOWN: there is no resubmission, new assignment or fallback session.
- A binding is recorded only from a receipt for the exact selected session and profile, with an accepted atomic fence and an admission id not already bound to any other assignment or report. Old admissions and earlier turns of that session are never evidence for the new assignment.
- Status: the Native API dependency is independently accepted PARTIAL_NATIVE_R1, exact tree `942e0bf3d50c9e5785ed5463c4afe16939adaead`, base `90c19e31968397a1d9bd1e9bb4f6d2c1d6f00be3`, revision null. This new Workspace integration still needs independent review. No installed gateway is assumed to provide it. Until a reviewed native build serves `idle-admission-v1`, every `existingSessionId` request fails closed without admission.

## Build, activation, and remaining gates

The supported production entrypoint is `server-entry.js`, which imports `dist/server/server.js` and serves `dist/client`. Vite copies the adapter into `dist/server/assets/swarm-native-bridge.py`. Deploying source alone cannot change an already running Node bundle. A reviewed rollout also needs the matching `swarm.yaml`; profile/auth files and `.runtime` mission history are not deployment payloads.

Run installed Vite/Vitest/TypeScript directly, with agent autostart disabled and synthetic private test homes. Do not use `npm start`, `start:all`, Electron startup, dependency installation, or a live native submission for source verification. Existing legacy helpers/metadata remain historical, but routes and direct lifecycle/profile/runtime writers refuse canonical native identities (including path/session aliases) before effects and do not advertise legacy runtime APIs. Native Main/direct-chat transport remains separate and supported.

Deterministic import/prerequisite/spawn failures before prompt submission return `notAdmitted: true`. A timeout, lost submit acknowledgment, unparseable transport result or process/store crash with ambiguous admission remains fenced. There is no new caller release flag or automatic replay. `request_id`/`input_id` idempotence is not a supported inverse lookup proving non-admission: without a known session/admission, use exact existing Desktop session/evidence inspection and a separately approved reconciliation step, not deletion/release of the reservation.

Dashboard proxy consumers map `DashboardAuthError` to structured `dashboard_auth_required` (401, `needs_login`, `/dashboard-connect`) or `dashboard_auth_unavailable` without exposing private upstream text. Access authentication remains distinct from inference configuration and Workspace password denial. No login/refresh is initiated by the mapper. OAuth state/PKCE/expiry and credentials are unchanged. An already-open MCP log stream cannot replace its committed HTTP status; only its pre-stream boundary is covered. This does not identify or fix the historical generic 500.

Before activation: independent exact-delta acceptance, supported authenticated Workspace/Dashboard access, a private reversible bundle/roster backup, revalidated Workspace process identity and unchanged gateway/dashboard identities, and an operator-approved Workspace-only reload method are required. The current auth boundary is not bypassable by reading cookies/tokens or disabling auth. Source fixtures, SSR markup tests, and a successful build are not live delivery or visual acceptance. The first real ARGUS mission remains gated on acceptance and bounded live verification.


## V2 source candidate: SAME Developer and task-bound GPU (default OFF)

New owning source is based on operator fork `ati-ee/hermes-workspace` main
`c631425d8baa933f8c61d8447040f4ec8b5f571c`; native foundation is a *scoped path port* from snapshot
`1b3da6c16cbca4fe1c9c18b3958106d80b52491e`, followed by the parent-relative accepted 17-file B2 delta.
It is not a 148-file snapshot replacement. `swarm.yaml`, active UI, profiles and credentials are not
payloads. Exact prerequisite/old-auth-model-profile/source-blob maps accompany the delivery; the
snapshot lacks parent `50a505c4…`, so individual historical commit attribution is left to the
independent Reviewer with LOCAL full history, not fabricated from the snapshot. Shared existing UI
and security changes are prerequisite source, not new GPU feature authorship.

`ARGUS_WORKSPACE_GPU_SOURCE_ENABLED=1` additionally allows **only `argus-developer`**, not
`argus-developer-local` or another bot, to select its existing ordinary session. It remains default
OFF in both dispatcher/store validation and Python bridge. All B2 authentication, same-origin JSON,
request-held authority, exact completed dependency artifact, immutable session selection, profile /
session reservation, current-generation native idle fence, attended policy and sticky UNKNOWN
requirements remain. Only the explicit accepted-continuation contract below may append to a completed native mission; legacy/historical requests remain read-only. No new-session fallback exists.
No existing real Developer assignment/admission is fabricated or backdated by this source work.

The new assignment is created by the actual owning mission store, and its exact
`mission.id:assignment.id` becomes the canonical native `prompt.submit.input_id`. Only that new
receipt's actual profile/session/admission is persisted. Dependency/source artifact evidence still
requires an operator-bound real commit; revision-null source packages are NOT silently retyped as
accepted workflow artifacts. A completed model turn remains separate from source acceptance.

GPU execution does not originate from a Workspace model field or a new Workspace credential. The
Native plugin obtains the sealed `hermes.plugin-origin/v1` inside that admitted turn; its genuine
request id is the above mission/assignment key, and its admission/session/profile/store/generation
remain the actual Native values. The Argus host adapter binds the full sealed tuple to one exact
canonical body, producer key, exact-body grant and job. The original Native admission is the GPU
**task** identity, not a new Kanban run. Workspace's tracking origin is read-only correlation, never
an Argus grant or a substitute native admission. Neither client dict fields nor a coordinator turn
may replace the selected Developer's actual origin.

After actual owning Argus job/attempt/worker/payload/fingerprint/event validation, Native commits
one visible result row + receipt in the original conversation without new inference. A late GPU
result is not automatically a `SWARM_DELIVERY` code artifact, dependent review acceptance or mission
completion. The host's explicit bounded sync command handles approved dispatch/reconciliation and
result polling; there is no Workspace GPU scheduler, retry monitor or automatic bot loop.

Author offline evidence includes guarded Vitest prerequisite/auth/default/replay tests, bridge wire
fixtures and a separate bridge -> actual accepted Native parser/authorization/SQLite admission
integration with scheduling disabled. The actual Native test observes one new admission in the
selected private fixture session, another assignment denied, session creates 0 and model turns 0.
Fixture identities are NOT current Developer admission receipts. Argus/Native integration separately
covers lost acceptance, read-only original-key reconciliation, restart and lost delivery ACK with
one job/one original-task result. Worker/GPU remain fixtures, not live proof.

Canonical build emits client+SSR bundles but the unchanged guard returns exit 3 for the existing
`tsx` tooling's Unix-socket connection attempt (outbound accepted 0). This is **NOT a green guarded
build**. Full-project TypeScript also has baseline errors; exact diagnostic identity comparisons,
not just totals, are in the delivery. Focused Vitest success is real execution, not static text proof.
No guard policy was weakened; expanded test includes and proper draining of import-triggered mock
probes are test-only changes.

Before activation: independent exact-source review, full LOCAL prerequisite-history preservation
check, legitimate operator commit binding, disposable PG migration/row-lock/revocation tests, hosted
CI/current-head C2 and approved HTTPS credential custody/ingress. Then a separately approved bounded
real GPU original-task roundtrip must observe actual job/attempt/result/receipt counts and zero
cross-target results. Existing native API source acceptance is NOT main/live mission completion.
Rollback requirements preserve original histories/results/UNKNOWN fences and use disabled flags /
revoked dedicated credentials, not deletion, retry/new-key workarounds or another session.


## W1 correction: truthful worker identity presentation (source only)

Independent Workspace V2 review (W-1) found that seven UI paths had been reverted to operator-fork
`c631425…` forms instead of the operator's actual UI fixes. This correction restores them byte-exactly
from commit `b15e0958f775261dd23c5cea39de19f5ba46388f`, verified from a deliberately partial ROOT
proof pack (13 commits, 9 selected trees, 7 blobs; every other historical blob, `swarm.yaml`, config
and credential intentionally absent). `c631425…` is an ancestor of `b15e0958…`, which is an ancestor
of native foundation `50a505c4…` (parent `8d8e7ee1…`), not the reverse. Snapshot `1b3da6c…` blobs are
not used as b15 authority. No full-history fsck or complete b15 tree checkout is claimed.

Presentation contract: profile names and providers/models come only from the authenticated
`/api/profiles/list` route; extra profile fields are never surfaced; a failed list is shown once and
no identity is inferred. Current configuration is labelled `Configured: … ; execution unverified`;
only a worker-reported model is labelled `Reported:`, and a missing reported provider stays
`provider unreported`. Native-swarm virtual workers use their actual worker ids and an unknown model
(`null` worker model; absent raw session model). Office/hub rows use real session labels (key
fallback) and render nothing when no session exists. The new-agent modal distinguishes model catalog
loading, actual error with retry, and an empty catalog. These are UI presentation guarantees, not
evidence of which model executed a past mission.

The only deviation from exact b15 bytes is `model: undefined` instead of `model: null` inside the
virtual worker's raw `GatewaySession`, removing one TypeScript diagnostic without changing behavior.
Author checks, independent review and later ROOT-isolated build qualification remain separate; this
W1 unit closes no other review, runtime, GPU, publication or live gate.


## Producer/reconcile source contract V1 (not live qualification)

This follow-up derives from sealed W1 tree `53b4744ea78ba56c21bb42e300508f08d45fc89d`, not the old
110-path tree. All seven W1 identity/model/UI fixes remain unchanged. The existing default-off
Developer opt-in, server WeakSet grant, same-origin authenticated JSON POST, exact configured
profile/session and Native `idle-admission-v1` fence remain mandatory. `producerIntent` is
operator request intent, never a credential, model selection or authorization token.

| Explicit Developer intent | Dependencies / precondition | Reachable transition |
|---|---|---|
| `initial` | No dependencies; no previous Developer assignment in this mission | One new assignment, same selected ordinary session, fenced `submit_existing` |
| `correction` | Exactly the same-session Developer's terminal completed/checkpointed artifact AND a different Reviewer's terminal completed exact `changes_required` review with its own artifact | Dispatch correction now; reviewed v1 stays checkpointed, never implicitly accepted |
| `continuation` | Exactly one accepted/done same-session Developer artifact, matched by the different Reviewer's stored exact accepted review | New admission; an explicitly selected completed **native** mission may be extended |

Existing reviewer/B2 requests and legacy accepted-dependency Developer continuation retain their
prior contract. Unsupported new producer transitions are typed 4xx at creation/staging, not success
with an undispatchable queued correction. Selection, producer intent, dependencies and frozen
artifacts cannot be rebound by repeating a request. Model `SWARM_DELIVERY` review/artifact text
is only format/identity checked; it is **not cryptographic Git/commit proof**. ROOT's independent
Git/hash qualification is still required. No revision-null source candidate is promoted to a
real accepted workflow artifact by these fixtures.

### C2 client V1: prepared original-input binding (source candidate; integration UNPROVEN)

The previous producer seal on Native 942e lacked an original-input reader. The separately authorized,
hash-sealed Native extension is now tree `9f9f5a7afd1446aa52fd5e134637cdf977b2867a`, capability/wire
version `original-input-lookup-v1`. This client derives from producer tree
`200e7ac58dec515f24a058f2709617cc02ddacf6`; it neither rewrites the Native seal nor assumes it is live.

For **every existing-session assignment**, the owner must advertise both `idle-admission-v1` and
`original-input-lookup-v1`. The bridge calls `prompt.prepare_input` with the exact session/input/text,
`finite: false`, `unattended: false` and observed `idle_fence.expected_generation`. The read-only
owner returns `{version, ref, input_id, principal_binding, payload_fingerprint, idle_fence}`. The
principal is always authenticated, never a JSON selector. Workspace validates and durably stores the
closed binding on the staged assignment **before submit**. The submitting bridge rechecks both the
current generation and the exact owner's preparation on its new connection; changed actor/payload/
fence refuses before admission. The same params then cross the native atomic idle fence exactly once.
No attachments or extra mutable protocol/schema are added.

A lost ACK remains reserved UNKNOWN. Refresh with a persisted binding calls only
`prompt.lookup_input {session_id, input_id, payload_fingerprint, idle_fence}` (plus `runtime.describe`),
not attach/list/submit/replay/resolve/create. It validates the closed versioned envelope's exact
profile/session/input/principal/fingerprint/fence and admission metadata. Positive `found` + `exact`
may bind one admission id once, never an id already bound in another mission/assignment/report.
The subsequent **exact ordinary receipt inspection** controls status and terminal release. Terminal
lookup evidence must be settled; committed-but-unpublished settlement is not terminal proof. Native
checks owner epoch and tuple in one read snapshot. Retired/draining/stale/unavailable owners,
not-found/mismatch, unknown versions, malformed envelopes and disconnects never release reservations.
There is no durable non-admission ledger and absence is never a positive refusal.

A historical row without the before-submit binding is never patched/backfilled: it remains UNKNOWN
and cannot be guessed from text/history. Producer resubmission is a typed 409, now
`native_reconciliation_required; awaiting exact original-input lookup` for bound rows; historical
unbound rows retain the earlier unavailable error. Preparation failures prove only that this client
has not submitted; they are not inferred refusal of an older ambiguous attempt.

### P-1 whole-batch preparation and reservations

`createAndStageNativeBatch` re-reads the latest file store, applies all creation/dependency/lineage
rules in memory, plans the whole prospective batch, checks duplicate profile/session intents and
all profile/session reservations, and only then performs **one synchronous atomic store replacement**
for creation plus staging. A typed refusal writes nothing and crosses no Native bridge (including
prepare). No await separates the read/revalidation/write. This is the existing **single Workspace
server-process** reservation model, not cross-process/distributed locking. Concurrent requests in
that process revalidate after awaited origin/auth work. Rows that cross submission are never rolled
back/deleted; each staged intent returns its actual per-assignment observation, and ambiguous rows
retain UNKNOWN/reservations. Initial, exact changes-required correction and accepted continuation
remain supported; the seven W1 UI source paths are byte-identical to the producer predecessor.

### Component evidence is not cross-process qualification

The official Native PM-built test overlay preserves all 22,307 sealed product blobs. Canonical
`scripts/run_tests.sh` runs the real `AuthorityConnection`/canonical parser/authority/temporary SQLite
and real Python bridge helpers. Private homes and owning isolation precede imports; a focused record
test additionally rejects socket/process effects before loading product modules. Raw complete
responses and hashes are preserved, with no model turn. The full Python `execute` adapter path is
also exercised with discovery/transport/live inventory fixtures and the real Native dispatcher.

The existing JS guard forbids Python subprocesses; the first direct-spawn contract attempt was
**DENIED**, not GREEN. A subsequent pre-approval standalone recorder and seven-test replay are
retained as incident evidence, not accepted integration proof. Root then explicitly approved two
separate component-test phases without changing the guard. Guarded Workspace replay uses the actual
official Native recordings, rebinding only exact profile/input identity tokens to disposable client
ids; cryptographic fingerprints, principal bindings, admission ids and states remain recorded bytes.
This proves **client handling**, not that rebound tokens authenticate a live owner. Raw originals are
preserved. Cross-process TS/Python/socket/ticket C2 integration remains **UNPROVEN**, for Root's
concrete OS-isolated qualification. See `argus-c2-handover.md` and the packet's evidence/provenance.

### Bounded low-finding disposition

- C4: remove the hardcoded board-specific debug read. `dashboard-connect.tsx::verifyLan` is a real
  consumer of generic `GET ?verify=1`, so its generic sessions/profiles/boards checks and normal
  authenticated status API stay compatible. Negative/auth/status behavior is covered offline.
- C5: delete the uncalled private `runWorker` execution path and its exclusive CLI/token resolvers.
  Keep the exported, tested pure helper functions byte-for-byte; no legacy launcher is enabled.
- C3 follow-up **pending independent review**: initiator owner is a hash of the Workspace login
  cookie, whereas callback+PKCE flow cookie is on `127.0.0.1:<port>` through the documented SSH
  tunnel. Requiring the LAN cookie at callback would break that supported different-host flow.
  A later narrowly designed initiator-confirm POST must keep a callback grant inactive until the
  original authenticated owner confirms, preserving PKCE, expiry, one-use state and renewal.
  Current low-risk single-shared-password account-swap class remains; no OAuth redesign/fix claimed.
- C6 follow-up **pending independent review**: synchronous GET refresh has no trusted principal
  parameter today. A mission-only global Promise cache could share observations across auth
  contexts; TTL must never settle UNKNOWN. Later in-flight-only coalescing needs trusted actor +
  profile/mission/immutable-request keys, fresh-store identity revalidation and `finally` cleanup,
  with cancellation/restart/foreign-owner tests. No timer, cache, monitor or queue is added here.

Author fixtures use the real API/grant/store/dispatch path and a labelled synthetic Native bridge.
They are not genuine attended assignments or public Native lookup proof. Guard policy is unchanged;
adding focused test selections does not permit network. Full TypeScript baseline remains non-green.
ROOT must perform the OS-isolated network-none build for this **new exact tree** after independent
review; W1's earlier build does not qualify this follow-up. No live UI/server/real admission ran.
