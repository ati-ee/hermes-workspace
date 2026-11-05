# Workspace C2/P-1 source handover and knowledge record

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
