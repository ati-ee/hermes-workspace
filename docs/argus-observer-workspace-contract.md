# ARGUS Console, Hermes and Workspace observation contract

## Source of truth and scope

This is a source-derived compatibility record, not production acceptance. The existing Argus lane was inspected read-only; no Console/API source, database, profile, job, ingress or deployment was changed. The delivery's `ARGUS-observer-source.json` records the inspected HEAD, dirty-state caveat and exact file SHA-256 values. A dirty lane is not modified or treated as an immutable whole-tree snapshot.

Canonical sources in the Argus repository:

- `docs/functions/security/service-observer-hermes-integration.md` (SEC-007).
- `control/app/service_observer_api.py` and `service_observer_schemas.py`.
- `integrations/hermes/argus-observer/{README.md,__init__.py,schemas.py}`.

## Distinct service-identity and operator-MCP contracts

Do not confuse the deferred SEC-007 native plugin below with the separately exposed operator MCP. Existing coordinator evidence `OBSERVER-BOUNDARY-01.txt` records ONE actual `mcp__argus_local_operator__argus_list_workers(limit=10, offset=0)` result: `ok=false`, `authentication_required`, `retryable=false`. It establishes an authentication boundary, not live worker health, missing inference, or a generally broken MCP connection. No retry was performed by this author.

Read-only inspection of `integrations/hermes/local_operator/server.py` identifies a **different** operator-owned stdio connector using the existing SEC-006 operator HTTPS session. Its local source declares three operations: bounded list workers (limit 1–20, offset 0–100000), exact worker status, and GPU telemetry. Fixed routes are GET `/api/v1/operator/workers` and GET `/api/v1/operator/workers/{UUID}/telemetry`. GPU observations are advisory, not reservations. Connect/request/process timeouts are 3/8/10 seconds; upstream/body/result sizes are bounded. The credential-side connector must not be launched inside Hermes, and this repair never reads its private session/cookie storage.

That source's success shape is `{ok:true, content_trust:'untrusted_data', observed_at, data}`; failures are `{ok:false, error:{code,retryable}}`, wrapped in MCP content/structuredContent. Missing private operator login and upstream 401 both become `authentication_required`, so the reported category does not distinguish them. The coordinator's exposed catalog has **five** operations, including job/artifact observation metadata, while this checkout declares only three. The exact installed-command/source revision/schema binding is therefore **UNKNOWN**. Do not substitute the local checkout for the live server identity or call/enable the deferred service plugin to bypass operator auth. The exact supported operator login page/action has not been verified for a ready-to-run handoff; the operator/coordinator must establish that boundary without credentials in chat.

### Deferred SEC-007 service-identity boundary

The inspected controller service source declares three GET-only operations under `/api/v1/service-observer`:

| Path | Scope | Native Hermes schema |
| --- | --- | --- |
| `/workers` | `workers:read` | `argus_list_workers(limit=10, cursor=null)`; limit 1–20, cursor at most 256 characters |
| `/workers/{worker_id}` | `workers:read` | `argus_get_worker_status(worker_id)`; UUID |
| `/workers/{worker_id}/gpu-capacity` | `resources:read` | `argus_get_gpu_capacity(worker_id)`; UUID |

These are **native registry plugin schemas**, not proof of a web MCP server. The current package registers the three schemas with `check_fn` returning false; its handler returns `isolation_required`. SEC-007 explicitly says credentialed production execution is disabled pending separately approved OS containment. A web discovery report of zero connected MCP servers therefore establishes neither failure nor health of these tools. No new MCP server, token, plugin activation or authorization is added by the Workspace repair.

The closed success envelope is `{ok:true, schema_version:1, request_id:UUID, observed_at:aware_datetime, data, warnings}`. Failures use the closed codes `authentication_required`, `forbidden_scope`, `not_found`, `invalid_argument`, `rate_limited`, `unavailable`, and `response_too_large`. The service authority uses its own bounded worker UUID allowlist and Bearer credentials, not a Workspace cookie, Hermes profile credential or Argus worker credential. PostgreSQL remains the controller's durable authority; workers never receive database credentials.

Worker online/heartbeat freshness, scheduling mode, active-job count and advisory slot upper bound are separate fields. GPU sampled/received timestamps and stale values remain explicit. `reservations_known=false`, reserved/allocatable VRAM null and `placement_evaluated=false` are not scheduling or deployment authority. An active Hermes session does not establish an available GPU, a running Argus job, or a deployed model backend.

## Exact identity linkage without fabricated jobs

| Identity | Authority | Meaning |
| --- | --- | --- |
| Canonical bot/profile ID + profile home | Existing Hermes configuration and exact native endpoint | Execution/identity profile, not an Argus worker |
| Native session/admission/request IDs | Gateway receipt and supported event stream | Ordinary attended model turn; not a managed Kanban run |
| Workspace mission/assignment IDs | Existing Workspace mission store | Source-task orchestration and exact-artifact review |
| Native board/card IDs | Exact read of an existing Dashboard card | Optional read-only origin binding, never card creation/claim/assignment/completion |
| Argus observer request ID + worker UUID | Closed service observer response | Separate read-only resource observation |

The Main composer uses `orchestrator-argus` and a dedicated mission session, never the default profile or an inventory session. Its optional existing board/card fields are validated by `fetchDashboardKanbanTask(cardId, boardId)` before any admission. Blocked/running/history/unknown-status cards are excluded from dispatch; this is not a human-approval state. Origin bindings are persisted and immutable. Unlinked ad-hoc missions say **unlinked**, not an invented card or managed run.

The current task-panel adapter's Dashboard proxy reads the **default board only**. It labels that feed and its exact card IDs; other backend board identities remain unreported. It does not claim cross-board completeness or create replacement managed tasks. Explicit mission-origin reads can bind another existing board/card without changing its lifecycle. Broad cross-board aggregation is not silently invented.

There is no supported observer operation for Workspace mission/session IDs, source-task admission, model management, deployment or Argus job submission. Consequently this repair proposes **no Argus API schema change**. When separately authorized observations are available, a private evidence manifest may correlate the distinct observed IDs; it must not relabel a Hermes profile/session as an Argus worker/job. A future cross-system API change would require a separate isolated proposal and explicit controller deployment approval.

## Proven timestamp boundary

Installed Hermes `hermes_state_sessions.py::_insert_session_row` delegates to `hermes_state_worker_lifecycle.py::insert_session_row_in_transaction`, which inserts `sessions.started_at` using `time.time()` (Unix seconds). The Workspace crew reader previously returned that number unchanged, while the activity renderers subtract it from `Date.now()` (milliseconds). The repair converts only that source-declared boundary to milliseconds. `timestampMilliseconds(value, unit)` never infers units by magnitude; native millisecond observations remain unchanged. The regression proves this path, not visual correction of the historical screenshot before activation.

## Remote execution context and unresolved diagnostics

Read-only whitelisted configuration inspection identifies `argus-developer` as an SSH terminal backend with its saved remote host alias and configured cwd. The private delivery records those exact non-secret fields. A configured remote path missing on the Ubuntu controller does not prove it is missing on the VPS. The installed gateway policy preserves a configured remote backend cwd unless an explicit cwd override applies. The UI therefore shows configured backend/cwd separately from reported session cwd and labels effective remote context unverified. No SSH connection, remote path rewrite, local directory creation, route/model change or config edit was performed.

The bounded sanitized Workspace log observation reproduced repeated `DashboardAuthError`/unhandled markers without exposing raw log content. It did **not** establish a correlated route for the reported generic 500. A synthetic task-list auth failure was reproduced and repaired into structured 401/needs-login; this is not proof that the unidentified historical root/500 cause is fixed. That cause remains UNKNOWN pending a separately captured exact route/request/error correlation.

## Remaining live gates

Independent exact-delta review must precede activation. Supported Workspace password login and `/dashboard-connect` → **Connect to Dashboard via Nous Portal** authenticate different authorities; Dashboard login does not choose Nous inference or change the selected provider/model/subscription. The OAuth/PKCE/state/expiry/refresh/CSRF implementation remains unchanged, and grants remain server-memory only. A Workspace restart requires supported Dashboard reconnection; no persistence guarantee is invented.

The SEC-007 service plugin remains BLOCKED by its containment/production gates; the separately exposed operator MCP is BLOCKED by the recorded authentication boundary, with exact live-source binding UNKNOWN. Authenticated Workspace visual/API verification and the first bounded ARGUS source/doc mission belong to the coordinator after acceptance. No production jobs, repeated inference probes or Console deployment are part of this author delivery.
