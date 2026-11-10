# Workspace C2/P-1 source handover and knowledge record

## PR2 direct blocked-to-completed correction (source candidate, not deployed)

Base: actual public PR2 head `d817c110f94a694a5e0f3f584e3c7b92f752223b` (parent main `e1d37d8…`),
tree `393574f8299fe9c82d5c7222868c4924ed8d850d`, byte-exact to the gen42 source unit. Root reports
Reviewer57 closed the five PR1 findings and Root's Node26 network-none build/340 tests passed on that
tree; those facts are not re-executed or extended here and do not qualify this new source.

Defect (GitHub PR2 P2, reproduced): `use-conductor-gateway.ts` sets `streamError` for a native
`blocked` status. If the next poll reports `completed` directly, the clear condition (queued/running/
reviewing only) is skipped and the completed branch kept the error, so history saved `failed` and the
complete view rendered "Mission Stopped" for a genuine success.

Correction: the blocked branch records its exact message in a ref; queued/running/reviewing and failed
paths reset it. On authoritative native `completed`, only that exact obsolete blocker is cleared with a
functional update in the same effect that sets `phase='complete'`, so history persists `completed`.
Any other error (user stop, failure, non-native) is preserved; failed/cancelled never become success.
Waiting/blocked polling/persistence, same-session/current-assignment selection, P1/UNKNOWN, auth,
allowlist, default-off and all other source are unchanged.

Author checks (unchanged guard, caller-private HOME/XDG/TMP, existing Node runtimes, no installs):
- Exact d817 product + same final test file: 1 FAIL (`expected 'Synthetic native blocker' to be null`)
  / 5 PASS. Candidate: 6/6. The new blocked-to-failed control passes on both (characterization).
- Full guarded selection Node26.12.1: 33 files / 342 PASS, guard exit 0, attempts 0 / outbound 0.
  Focused Node22.23.4: conductor regression + W1 files 11/11.
- Full TSC 92/92 (exit 2) and touched-file ESLint 13/13 (exit 1): no introduced/removed identities.
  Baselines remain non-green. No build was run here; Root's exact-head OS build for this source is pending.
- Test harness note: JSDOM Storage instance properties are storage keys, so history writes are observed
  through the real Storage prototype method. The active board has no error panel; the visible error
  surface is the complete view (`Mission Complete` vs `Mission Stopped`).
- No PC1eb/private payload, private roster/config/profile/route/auth/state, live API/gateway/model/GPU,
  GitHub write, new role/session/card/model or package install. revision null; no commit by this author.

Remaining gates: same-Reviewer exact-source review, Root final OS build, update of the same PR2,
explicitly authorized merge, then live and real original-task GPU qualification.

## PR1 integration regression correction (new source candidate, not deployed)

This unit is based on the real fetched ownfork commit
`e1d37d811e8f7dc111d7a43e14c86112fe4ad57d`, tree
`2f868c382305760c808ca92a2570e96686a0ac0a`. Root reports the preceding C2-1 unit accepted
by Reviewer54, owner OS build/import and four exact-source C2 ticket/socket/WS/SQLite/store
scenarios passing with providerattempt0, and PR1 publication/merge approved. Those are Root
qualification facts, not re-executed or extended by this source author. The closed raw Python
bridge/recorder/fixture, original P-1 store/UNKNOWN fences and request authority are unchanged.
The earlier source-only entries below are preserved as history, not current acceptance claims.

All five automatic PR review findings were checked against that exact owning source, not trusted
as assertions. All five were reproduced and corrected in this bounded unit:

| Finding | Owning correction / regression evidence |
|---|---|
| R4483340933 sample roster mismatch | `swarm.yaml` now lists exactly the supported six execution ids with matching profile ids and unknown metadata model; AGENTS describes a sample, not installed bots. Actual configuredProfile policy stays unchanged. Fixture test intersects the checked-in sample with existing disposable profiles and preserves missing/alias/archive/legacy denials. |
| R4483340948 reused-session history | `swarm-native-status.ts` chooses the last exact profile/session binding in each mission, then the newest applicable dispatch, without mutating history. It preserves live execution/approval/UNKNOWN evidence; a historical terminal turn cannot label an uncorrelated live turn with its old task/admission. Correction, accepted continuation, timestamp ties, foreign refs, queued/running, settled/idle and uncertain observations are covered. |
| R4483340963 waiting/blocked completion | Actual hook/worker/UI states represent waiting and blocked, keep phase/persistence/polling resumable, and do not write successful history. Managed mission status alone decides terminal completion. Real JSDOM hook tests observe another timed poll, recovery to running and eventual server-reported completed history without POST/resubmit. |
| R4483340974 persisted model overrides | Remove unsupported selectors and their exclusive catalog/query helpers. Normalized settings retain only projectsDir/maxParallel/supervised at load, save and launch; no default model/provider is chosen. Existing server override refusal is byte-unchanged. Actual hook launch and settings UI tests prove migration/removal. |
| R4483340982 credential-free discovery | No-key gateway `/v1/models` is used when Dashboard is absent; an available Dashboard remains the supported no-key authenticated context. Optional non-auth catalog failures preserve known models with a generic warning. Genuine Dashboard auth and gateway401/403 remain visible without another credential path. Remote catalog metadata is projected without account/auth fields. Real route-handler fixtures cover both contexts, outages, known models, auth and no config writes. |

### Sample/private roster migration boundary

This is a checked-in sample change only. Do not copy it over a private roster automatically.
Before any later deployment, the operator must back up and compare the existing private roster,
retain private metadata/routes/configs, and explicitly align id/profile entries with already-existing
supported profiles. Missing profiles remain unavailable. Never rename/install real profiles,
copy config/credentials, provision skills/wrappers, or translate legacy `builder`/`reviewer` ids to
canonical authority. `default` and `whatsapp` stay identity-only. The server's current private ARGUS
roster, actual profiles, routes/provider/model, .env and runtime stores were not read or changed.

### Author checks and preservation

- Final new regression cases against pristine e1 product code plus labelled test/selection overlay:
  19 FAIL /8 PASS in27 cases. Same byte-qualified new tests on candidate:27 PASS. Final combined
  original30files/313 plus new3files/27 =33files/340 PASS on both existing Node22.23.4 and Node26.12.1.
  Unchanged network/process guard reports attempts0/outbound0; its CPU tooling queries remain
  explicitly counted. Test selection adds only the three regression files; guard policy is unchanged.
- Pristine e1 versus candidate: full TSC92/92 errors, exit2; original targeted ESLint11/11, exit1;
  all touched TS/TSX/test-config lint60/57, exit1. No introduced diagnostic identities. Only three
  pre-existing array-type diagnostics disappeared with the now-unused model-selector helpers.
  No broad baseline cleanup, dependency/lock/runtime upgrade or new package installation.
- The single guarded production build attempt emitted client/SSR bundles (tool exit0) but the
  unchanged guard returned3 for tsx net.createConnection to Unix IPC (outbound0). It is NON-GREEN,
  was not retried/bypassed, and preceded final typed status-helper adjustments. It gives no build
  qualification to the frozen final tree; Root's final exact-head OS build remains pending.
- Only two W1 production files change for the explicitly requested current status/settings UI;
  actual worker identity and configured-versus-reported route behavior/assertions remain. The other
  five W1 paths, raw bridge/recorder/fixture, P-1/store/auth/default-off/allowlist/security and all
  non-allowlisted existing files are byte-exact to the base. Legacy model override server rejection
  and admission routing remain unchanged. No new sessions/admissions/model execution occurred.
- Source/fixtures were derived on the authorized VPS from fetched ownfork Git and already-present
  approved tools. No access/import/compare/transfer/proxy of PC1eb or denied private payload.
  No live API/socket/gateway/provider/GPU/production DB/Windows/WSL/service, sudoers/systemd,
  credential/grant/opflag/board changes, new role/model/session/card/cron, or GitHub write occurred.
  No agent/reviewer was spawned or interrupted. Private HOME/XDG/TMP and guard precede imports;
  these controls are not OS network isolation. Native/Argus acceptance was not reopened.

The external REPORT/AUTHORCHECKS and sealed raw Git inventory bind the final source. Root and an
independent Reviewer own source acceptance, canonical commit publication, final OS build/runtime,
main/live and real original-task GPU result return. This unit is not deployment approval.

## Server-authored C2-1 follow-up (author evidence, not acceptance)

This new unit starts from immutable tree `f49fb0c68725682633618123ace691e0f35701e2`.
The existing owning review closed P-1 independently and rejected C2-1 because Python projected
unknown raw response fields away before validation. This correction validates the entire raw
prepare/lookup result at that actual RPC boundary before returning any binding/lookup object.
It rejects nested expansion, missing/wrong-typed fields, future versions/states, unsafe integers,
foreign bindings and inconsistent terminal/settled evidence. Exact fenced submission and sticky
UNKNOWN are unchanged; no release, unlock, resubmit or session/principal fallback is introduced.

The authority used here is the already-present accepted Native commit
`ee1dce0c19d82e212b61bb0e8a7fb04fe5311251`, tree
`05b14ec18c786d558ce6eb049901812d5328c06e`. Its actual SDK/handler source is unchanged.
All inputs were already on the authorized server; no other private candidate/source/vector was
accessed or imported. Prior packets and seals are immutable. The follow-up has `revision: null`
until Root binds a real canonical commit; a tree is not a commit.

The new `scripts/test_swarm_native_raw_responses.py` runs in a private official Native test overlay:
copy it to `tests/gateway/test_workspace_c21_boundary.py`, and copy the bridge and unchanged recorder
to adjacent `workspace_c21_inputs/`. Use the accepted Native environment's unchanged
`scripts/run_tests.sh --files-from <owned-list>`. The official environment and additional pre-import
socket/process audit fence precede candidate imports. Test homes/configs/stores are fresh synthetic
fixtures, never installed profiles. Receipt creation uses real AuthorityConnection/parser/SQLite;
transport/discovery/inventory and scheduling are explicitly inert fixtures. Prepare/lookup each
assert zero writes/schedules and unchanged state; submit commits one test admission and increments
only an inert scheduling counter, never executing a model. This is not OS network-namespace isolation,
a live gateway ticket/socket test or cross-process C2 integration.

The same recorder regenerated `swarm-native-lookup-contract.fixture.json` from that owner through
the official runner; its bytes were copied unchanged. Genuine queued/terminal positives and
not-found/mismatch/unavailable nonpositives retain their actual semantics. Node 22 and Node 26
both pass the same 30 guarded Workspace files (313 tests each), preserving P-1/authWeakSet/same-origin,
source default-off, lost-ACK/UNKNOWN and the seven production W1 paths. The W1 test now obtains its
real browser Storage from Vitest's original `jsdom.window`, not Node 26's unrelated Web Storage
global or Vitest's rewritten `document.defaultView` alias; no fake Storage implementation is used.

Final official Python run: 167 new boundary/recording cases and 11 unchanged B2 bridge cases pass.
The first old-f49 boundary run had 50 failures/24 passes (74 initial cases); Node 26 reproduced the
original W1 setItem failure. Intermediate implementation/harness failures are retained outside Git,
not credited as GREEN. Existing full TSC stays 92 errors (exit 2), original targeted ESLint 11
(exit 1), and extra W1 test-only lint seven (exit 1), with exact path/code/message diagnostic
multisets unchanged versus isolated f49. Full lint/typecheck is not green. The external source
report/author checks contain hashes, guard statuses and reconstruction evidence. Root and the same
Reviewer own independent source acceptance and later OSbuild/C2/canonical binding/publication/live;
the real original-task GPU result is still a separate gate, not a source-author claim.

## State and lineage

Author candidate only; independent review and Root qualification pending. Base commit
`c631425d8baa933f8c61d8447040f4ec8b5f571c`, sealed producer predecessor tree
`200e7ac58dec515f24a058f2709617cc02ddacf6`. Native product dependency is the unchanged sealed
`original-input-lookup-v1` tree `9f9f5a7afd1446aa52fd5e134637cdf977b2867a`; it is not assumed live.
No new author identity, model/provider/session/card, public commit, publication or deployment.
`revision: null` is deliberate; trees/archives are not commits or accepted SWARM_DELIVERY artifacts.

## Invariants to retain

- P-1: validate all prospective assignment rules and profile/session reservations before a single
  synchronous create+stage store replacement. Whole-batch refusals preserve exact store bytes and
  make zero Native bridge calls. This is single-Workspace-process concurrency, not a distributed lock.
- C2: prepare exact binding, persist it, reverify under the submitting authenticated connection,
  then perform the native fenced submit. Binding is immutable and absent on historical rows.
- Original-input reads use exact authenticated principal/profile/session/input and expected committed
  fingerprint/fence. A body cannot search/select a principal; no alias/trim/control fallback.
- Bind a positive matched admission once, with cross-mission duplicate protection. Not-found,
  unavailable, mismatch, malformed/expanded/future envelopes and disconnect remain sticky UNKNOWN.
  Terminal release follows an exact settled receipt, never a timeout, model text or missing row.
- Never roll back/delete rows after a Native boundary. No automatic unlock/retry/new key/session.
- Keep default-off Developer source opt-in, attended/Once-Deny policy, request-held same-origin grant,
  exact correction/accepted-continuation evidence, security/dependency provenance and seven W1 UI paths.

## Verification boundaries and incidents

Native component evidence runs in a new test-only overlay through the existing PM-built interpreter
and canonical `scripts/run_tests.sh`; all 22,307 product blobs are unchanged. Owning conftest provides
collection-time isolated home, credential/lazy-install/network controls; the recorder additionally
installs a socket/process audit fence before product import. It records real parser/authority/SQLite
responses from five scenarios. Adapter tests also exercise the real Python `execute` path with
transport/discovery/live-inventory fixtures. No model turn, real gateway socket or credentials.

Workspace replays those official raw responses under the unchanged JS guard. Only exact profile and
input identity tokens are rebound; fingerprints/principal bindings/admission ids/status/proofs are
not recomputed. Rebound identities are fixture coordinates, not genuine live cryptographic proofs.
Raw originals and bridge/harness/source hashes accompany the packet. Negative tests exercise foreign
bindings, unsupported/malformed envelopes, settlement metadata, cross-mission reuse, lost replies,
historical missing bindings and preparation failure. Reviewer32's three independent P-1 cases,
duplicate/concurrent reservation contention and valid producer flows remain explicit tests.

The direct Python subprocess test was denied by the JS guard (five denials, wrapper exit 1).
A later standalone recorder/replay executed before narrow Root permission; it is retained as incident
evidence and receives **no accepted cross-process credit**. Root subsequently approved the separate
Native-component/guarded-replay design. Neither guard/policy/allowlist was changed. The earlier
implicit tool-hook `npx`/deprecated tsc incident/cache remains retained, excluded from source and
validation credit. Current checks use installed pinned TypeScript directly, never `npx`.

## Baseline quality findings

Full TypeScript is NOT green: producer and candidate each retain 92 diagnostics, exit 2. Exact
path/code/message comparison preserves a `swarm-roster.ts` TS2322 display-order difference (`mission`
and `specialty` swapped in the printed object type); that untouched source remains byte-identical.
There is no introduced diagnostic in C2/P-1 affected source. Do not treat equal counts as equality:
raw complete diagnostics and exact introduced/removed signatures are delivered for review.
Targeted ESLint retains the identical 11 baseline messages, exit 1, with no introduced signature.
These are baseline-aware author checks, not a full-project PASS or independent acceptance.

## Required next gates

1. Independent Reviewer of final C2/P-1 tree, especially store atomicity, sticky UNKNOWN and exact
   original-attempt binding. Do not interrupt the separately assigned Native full-C3 Reviewer.
2. Root exact-head OS-isolated build/runtime and genuine TS/Python/socket/ticket C2 integration:
   **UNPROVEN here**. Earlier tree200e build is not evidence for this changed tree.
3. Root's real operator commit composition/rebase onto actual main and Native final full-C3.
4. Explicitly authorized original-task real GPU result/receipt roundtrip and live deployment gates.
   No real attended admission/result/acceptance is claimed by these fixture ids.
5. Canonical Argus-CI prerequisites are a later separate unit, not implemented in this packet.

Known earlier C3 auth callback-owner and C6 auth-scoped refresh-coalescing follow-ups are unchanged.
See `argus-native-swarm.md` and the packet REPORT/SOURCE-MAP/VERIFICATION for exact files, trees,
hashes, commands, full logs and test results. A byte/tree reconstruction verifies packaging only;
it is not independent source review or live qualification.
