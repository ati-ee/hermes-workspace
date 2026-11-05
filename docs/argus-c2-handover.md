# Workspace C2/P-1 source handover and knowledge record

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
