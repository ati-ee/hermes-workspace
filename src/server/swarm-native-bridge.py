"""Workspace's attach-only native admission adapter (JSON stdin/stdout, no CLI fallback).

The existing gateway owns all session/config/auth state. This adapter only discovers,
attaches, submits attended work, and reads exact admission receipts/event projections.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
from pathlib import Path
import re
import sys

ALLOWED = frozenset({'orchestrator-argus', 'argus-architect', 'argus-developer',
                     'argus-developer-local', 'argus-reviewer', 'argus-validator'})
# B2: a NEW assignment may target one explicitly selected existing session only for the
# independent code reviewer. Ordinary attended sources only; never bots, kanban workers,
# tool/cron/finite integrations or messaging lanes.
EXISTING_SESSION_WORKERS = frozenset({'argus-reviewer'})
# Stored ``sessions.source`` labels of ordinary attended local conversations (Desktop is stored
# as ``desktop``, peers rewrite other local creations to ``local``). ``tool``/``oneshot``/``acp``
# and every messaging/kanban/cron/api source are refused.
EXISTING_SESSION_SOURCES = frozenset({'desktop', 'local', 'cli', 'tui'})
# The native capability whose ``prompt.submit idle_fence`` is checked inside the admission's own
# write transaction, and whose ``session.resume metadata_only`` attaches without a transcript.
IDLE_ADMISSION_CAPABILITY = 'idle-admission-v1'
# Owner refusals of a fenced submit that roll back before anything is committed: definitively
# not admitted. Anything else (transport loss, admission_conflict, unknown) stays UNKNOWN.
FENCE_REFUSALS = frozenset({'session_busy', 'stale_generation', 'invalid_params', 'permission_denied',
                            'unsupported_control', 'runtime_draining', 'not_found', 'queue_full',
                            'profile_mismatch'})
# C2: Native's read-only original-input lookup. ``prepare_existing`` asks the owner (without writing) for
# the exact binding the fenced submit WILL commit; Workspace persists it BEFORE ``submit_existing``, and a
# lost ACK is later reconciled only through ``lookup`` (``prompt.lookup_input``), never by resubmitting.
LOOKUP_CAPABILITY = 'original-input-lookup-v1'
BINDING_KEYS = ('version', 'ref', 'input_id', 'principal_binding', 'payload_fingerprint', 'idle_fence')
LOOKUP_KEYS = ('version', 'state', 'reason', 'ref', 'input_id', 'principal_binding', 'binding', 'admission', 'proof', 'settled')
HEX64 = re.compile(r'[0-9a-f]{64}')


MAX_SAFE_INTEGER = 2**53 - 1


def _closed(value, keys) -> bool:
    return isinstance(value, dict) and set(value) == set(keys)


def _safe_integer(value, minimum=0) -> bool:
    # Native integers cross a JSON/JavaScript boundary; bool and lossy numbers are not integers here.
    return type(value) is int and minimum <= value <= MAX_SAFE_INTEGER


def _reference(value) -> bool:
    return (_closed(value, ('profile_id', 'session_id'))
            and all(isinstance(item, str) and item for item in value.values()))


def valid_binding(binding, request_id) -> bool:
    """Validate the COMPLETE Native prepare result, including its closed nested schemas."""
    if not _closed(binding, BINDING_KEYS):
        return False
    return (binding['version'] == LOOKUP_CAPABILITY
            and isinstance(binding['input_id'], str) and 1 <= len(binding['input_id']) <= 1024
            and binding['input_id'] == request_id and _reference(binding['ref'])
            and all(isinstance(binding[key], str) and HEX64.fullmatch(binding[key]) is not None
                    for key in ('principal_binding', 'payload_fingerprint'))
            and _closed(binding['idle_fence'], ('expected_generation',))
            and _safe_integer(binding['idle_fence']['expected_generation']))


def valid_lookup(found, binding, request_id) -> bool:
    """Closed Native canonical_input_lookup result, before any projection or positive rebind.

    The accepted owner contract has three states. Only found/exact carries admission/proof;
    genuine mismatch, not_found and unavailable receipts remain nonpositive and unchanged.
    """
    if not (_closed(found, LOOKUP_KEYS) and found['version'] == LOOKUP_CAPABILITY
            and _reference(found['ref']) and found['ref'] == binding['ref']
            and isinstance(found['input_id'], str) and found['input_id'] == request_id
            and found['principal_binding'] == binding['principal_binding']
            and type(found['settled']) is bool):
        return False
    empty = (found['binding'] is None and found['admission'] is None
             and found['proof'] is None and found['settled'] is False)
    if found['state'] == 'unavailable':
        return (empty and isinstance(found['reason'], str)
                and found['reason'] in {'runtime_retired', 'runtime_draining', 'stale_epoch', 'storage_unavailable'})
    if found['reason'] is not None:
        return False
    if found['state'] == 'not_found':
        return empty
    if found['state'] != 'found':
        return False
    if found['binding'] == 'mismatch':
        return found['admission'] is None and found['proof'] is None and found['settled'] is False
    if found['binding'] != 'exact':
        return False
    admission, proof = found['admission'], found['proof']
    if not (_closed(admission, ('admission_id', 'sequence', 'status', 'outcome',
                               'authority_epoch', 'execution_generation'))
            and _closed(proof, ('payload_fingerprint', 'idle_fence'))
            and isinstance(proof['payload_fingerprint'], str)
            and HEX64.fullmatch(proof['payload_fingerprint']) is not None
            and proof['payload_fingerprint'] == binding['payload_fingerprint']
            and _closed(proof['idle_fence'], ('expected_generation',))
            and _safe_integer(proof['idle_fence']['expected_generation'])
            and proof['idle_fence'] == binding['idle_fence']
            and isinstance(admission['admission_id'], str) and admission['admission_id']
            and _safe_integer(admission['sequence'], 1)
            and _safe_integer(admission['authority_epoch'])
            and (admission['execution_generation'] is None
                 or _safe_integer(admission['execution_generation']))
            and isinstance(admission['status'], str)
            and admission['status'] in {'queued', 'started', 'unknown', 'terminal'}):
        return False
    if admission['status'] == 'terminal':
        return (found['settled'] is True and isinstance(admission['outcome'], str)
                and bool(admission['outcome']))
    return found['settled'] is False and admission['outcome'] is None


def submit_params(sid: str, request: dict, generation: int) -> dict:
    """The ONE param set of the fenced existing-session submit; prepare computes its binding from it."""
    return {'session_id': sid, 'input_id': request['requestId'], 'text': request['text'], 'finite': False,
            'unattended': False, 'idle_fence': {'expected_generation': generation}}


async def prepare_original_input(client, sid: str, request: dict, generation: int) -> dict:
    """Pure owner preparation (``prompt.prepare_input``): no write, admission, attach or session."""
    prepared = await client.rpc('prompt.prepare_input', **submit_params(sid, request, generation))
    if not (valid_binding(prepared, request['requestId']) and _safe_integer(generation)
            and prepared['ref']['session_id'] == sid
            and ('profileHome' not in request or prepared['ref']['profile_id'] == request['profileHome'])
            and prepared['idle_fence']['expected_generation'] == generation):
        raise ValueError('native_input_prepare_invalid')
    return prepared


async def fenced_submit(client, sid: str, request: dict, binding: dict) -> dict:
    """The fenced submit with exactly the params its persisted binding was prepared from."""
    return await client.rpc('prompt.submit', **submit_params(sid, request, binding['idle_fence']['expected_generation']))


async def lookup_original_input(client, request: dict) -> dict:
    """Read-only ``prompt.lookup_input`` at the exact persisted binding; no attach/list/create/submit."""
    binding = request['inputBinding']
    found = await client.rpc('prompt.lookup_input', session_id=binding['ref']['session_id'], input_id=request['requestId'],
                             payload_fingerprint=binding['payload_fingerprint'], idle_fence=binding['idle_fence'])
    if not valid_lookup(found, binding, request['requestId']):
        raise ValueError('native_input_lookup_invalid')
    return {'sessionId': binding['ref']['session_id'], 'lookup': found}


def _listed(listing: dict, sid: str):
    rows = [row for row in (listing.get('sessions') or []) if isinstance(row, dict)
            and (row.get('session_id') == sid or row.get('id') == sid)]
    return rows[0] if len(rows) == 1 else None


async def existing_session_preflight(client, sid: str) -> tuple[dict | None, str | None]:
    """Observe one exact LIVE ordinary session through the supported metadata-only attach.

    ``session.resume metadata_only`` (idle-admission-v1) subscribes without a transcript, cold
    restore or policy refresh. This observation is NOT atomic: its ``execution_generation`` is the
    ``expected_generation`` of the fenced ``prompt.submit``, which the owner re-checks (with
    queued/started/unknown admissions and live workers) inside the admission write transaction.
    """
    row = _listed(await client.rpc('session.list', limit=200), sid)
    if row is None:
        return None, 'existing_session_not_live'  # never a cold/stored restore
    if row.get('source') not in EXISTING_SESSION_SOURCES:
        return None, 'existing_session_source_not_allowed'
    if row.get('running') is not False:
        return None, 'existing_session_busy'
    # Supported attach: submission requires this connection's subscription.
    snapshot = await client.rpc('session.resume', session_id=sid, metadata_only=True)
    if snapshot.get('session_id') != sid or snapshot.get('stored_session_id') != sid:
        return None, 'existing_session_redirected'
    if snapshot.get('messages') != [] or snapshot.get('pending') != [] or snapshot.get('prompts') != []:
        return None, 'metadata_attach_unverified'
    if (snapshot.get('running') is not False or snapshot.get('execution_state') != 'idle'
            or snapshot.get('pending_count') != 0 or snapshot.get('open_requests') or snapshot.get('pending_connection')):
        return None, 'existing_session_busy'
    info = snapshot.get('info') or {}
    if info.get('source') != row.get('source'):
        return None, 'existing_session_source_not_allowed'
    if info.get('yolo') is not False:
        return None, 'attended_policy_unverified'
    generation = snapshot.get('execution_generation')
    if type(generation) is not int or generation < 0:
        return None, 'existing_session_generation_unknown'
    return {'info': info, 'replay_epoch': snapshot.get('replay_epoch'), 'generation': generation,
            'preflight': {'source': row['source'], 'executionGeneration': generation, 'idleVerified': True,
                          'atomicIdleFence': False, 'capability': IDLE_ADMISSION_CAPABILITY}}, None


def same_admission(receipt: dict, home: Path, sid: str, aid: str) -> bool:
    return (receipt.get('ref') == {'profile_id': str(home), 'session_id': sid}
            and receipt.get('admission_id') == aid)


def receipt_metadata(receipt: dict) -> dict:
    # Never serialize the durable turn's messages, reasoning, usage or other result fields.
    return {key: receipt[key] for key in ('admission_id', 'ref', 'sequence', 'status',
                                         'outcome', 'authority_epoch', 'execution_generation') if key in receipt}


async def execute(request: dict) -> dict:
    worker = request.get('workerId')
    home = Path(request.get('profileHome', ''))
    config = home / 'config.yaml'
    identity_only = request.get('action') == 'status' and worker in {'default', 'whatsapp'}
    if not identity_only and (worker not in ALLOWED or home.name != worker):
        return {'error': 'profile_not_allowed', 'notAdmitted': True}
    if not home.is_absolute() or home.resolve() != home or not config.is_file() or config.is_symlink():
        return {'error': 'profile_not_configured', 'notAdmitted': True}
    if request.get('action') not in {'submit', 'submit_existing', 'prepare_existing', 'lookup', 'inspect', 'status'}:
        return {'error': 'invalid_action', 'notAdmitted': True}
    existing = request.get('action') in {'submit_existing', 'prepare_existing'}
    existing_worker = (worker in EXISTING_SESSION_WORKERS or
                       (worker == 'argus-developer' and os.environ.get('ARGUS_WORKSPACE_GPU_SOURCE_ENABLED') == '1'))
    if existing and (not existing_worker or not isinstance(request.get('sessionId'), str)
                     or not 8 <= len(request['sessionId']) <= 200 or request['sessionId'].strip() != request['sessionId']):
        return {'error': 'existing_session_not_allowed', 'notAdmitted': True}
    if request['action'] == 'lookup' and (not valid_binding(request.get('inputBinding'), request.get('requestId'))
                                          or request['inputBinding']['ref']['profile_id'] != str(home)):
        return {'error': 'input_binding_invalid', 'notAdmitted': False}
    # Bind before imports, discovery and, crucially, the same-user ticket request.
    os.environ['HERMES_HOME'] = str(home)
    os.environ['HERMES_PROFILE'] = str(worker)
    for key in list(os.environ):
        if key.startswith('HERMES_KANBAN_') or key in {'HERMES_YOLO', 'HERMES_AUTO_APPROVE', 'HERMES_ACCEPT_HOOKS', 'HERMES_TUI_GATEWAY_URL'}:
            os.environ.pop(key, None)
    token = reset_override = None
    attempted = False
    result: dict = {'profileId': str(home)}
    try:
        from hermes_cli.gateway_client import connect_gateway
        from hermes_cli.gateway_runtime import discover_gateway_endpoint, control_home_for
        from hermes_cli.gateway_lifecycle_guards import live_work
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override
        reset_override = reset_hermes_home_override
        token = set_hermes_home_override(home)
        discovery = discover_gateway_endpoint(home)
        if discovery.state != 'ready' or discovery.endpoint is None:
            return {**result, 'error': 'gateway_not_ready', 'notAdmitted': True}
        if discovery.endpoint.profile_id != str(home):
            return {**result, 'error': 'wrong_profile', 'notAdmitted': True}
        # An explicit endpoint prevents connect_gateway's default auto-start path.
        async with connect_gateway(endpoint=discovery.endpoint) as client:
            description = await client.rpc('runtime.describe')
            if description.get('profile_id') != str(home):
                return {**result, 'error': 'wrong_profile', 'notAdmitted': True}
            if existing and IDLE_ADMISSION_CAPABILITY not in (description.get('capabilities') or []):
                # Fail closed BEFORE any attach/submit: without the native fence an idle check is
                # only an observation, and a queued admission could land behind other work.
                return {**result, 'error': 'native_idle_fence_unavailable', 'notAdmitted': True}
            if (existing or request['action'] == 'lookup') and LOOKUP_CAPABILITY not in (description.get('capabilities') or []):
                # Without the owner's read-only lookup a lost ACK could never be reconciled: refuse BEFORE
                # any attach/submit (prepare/submit), or report the lookup as unavailable (never as absent).
                return {**result, 'error': 'native_input_lookup_unavailable', 'notAdmitted': request['action'] != 'lookup'}
            if request['action'] == 'lookup':
                return {**result, **(await lookup_original_input(client, request))}
            if request['action'] == 'status':
                # Live scalar metadata only: never attach, subscribe, or read a transcript.
                listing = await client.rpc('session.list', limit=200)
                sessions = []
                for row in listing.get('sessions', []):
                    sid = row.get('session_id')
                    if not isinstance(sid, str):
                        continue
                    info = await client.rpc('session.info', session_id=sid)
                    sessions.append({'sessionId': sid, 'source': row.get('source'), 'title': row.get('title'),
                                     'status': 'started' if row.get('running') is True else 'idle',
                                     'model': info.get('model'), 'provider': info.get('provider'),
                                     'reasoningEffort': info.get('reasoning_effort') or info.get('reasoning'),
                                     'sessionCwd': info.get('cwd')})
                work = live_work(control_home_for(home, discovery.endpoint), profile=worker)
                idle = isinstance(work, dict) and work.get('profile') == worker and not work.get('active_agents') and not work.get('active_work')
                return {**result, 'connected': True, 'status': 'started' if any(row['status'] == 'started' for row in sessions) else 'idle' if idle else 'unknown', 'sessions': sessions}
            if request['action'] in {'submit', 'submit_existing', 'prepare_existing'}:
                work = live_work(control_home_for(home, discovery.endpoint), profile=worker)
                if not isinstance(work, dict) or work.get('profile') != worker:
                    return {**result, 'error': 'profile_idle_unverified', 'notAdmitted': True}
                if work.get('active_agents') or work.get('active_work'):
                    return {**result, 'error': 'profile_busy', 'notAdmitted': True}
            if existing:
                # Never session.create: the exact selected canonical session or nothing.
                sid = request['sessionId']
                snapshot, refusal = await existing_session_preflight(client, sid)
                if refusal:
                    return {**result, 'error': refusal, 'notAdmitted': True}
                result['preflight'] = snapshot.pop('preflight')
            elif request['action'] == 'submit':
                snapshot = await client.rpc('session.create', source='gui', title=request['title'],
                                            cwd=str(home), cwd_explicit=False, request_id=request['requestId'],
                                            follow_profile_config=True, yolo=False)
                sid = snapshot.get('stored_session_id') or snapshot.get('session_id')
                if not sid:
                    return {**result, 'error': 'wrong_session', 'notAdmitted': True}
            else:
                # Receipt/info authorize the stored canonical owner without resume or history.
                # Canonical resume currently accepts omit_messages but does not implement it.
                sid = request['sessionId']
                snapshot = {'info': await client.rpc('session.info', session_id=sid)}
            result['sessionId'] = sid
            info = snapshot.get('info') or {}
            if isinstance(info.get('cwd'), str):
                result['sessionCwd'] = info['cwd']
            result.update({key: info[key] for key in ('model', 'provider') if isinstance(info.get(key), str)})
            effort = info.get('reasoning_effort') or info.get('reasoning')
            if isinstance(effort, str):
                result['reasoningEffort'] = effort
            if request['action'] in {'submit', 'submit_existing', 'prepare_existing'}:
                if snapshot.get('running') or snapshot.get('pending') or snapshot.get('prompts'):
                    return {**result, 'error': 'session_busy', 'notAdmitted': True}
                if info.get('yolo') is not False:
                    return {**result, 'error': 'attended_policy_unverified', 'notAdmitted': True}
                if request['action'] == 'prepare_existing':
                    result['inputBinding'] = await prepare_original_input(client, sid, request, snapshot['generation'])
                    return result  # pure: nothing was submitted
                if existing:
                    binding = request.get('inputBinding')
                    if not valid_binding(binding, request['requestId']) or binding['ref'] != {'profile_id': str(home), 'session_id': sid}:
                        return {**result, 'error': 'input_binding_invalid', 'notAdmitted': True}
                    if binding['idle_fence']['expected_generation'] != snapshot['generation']:
                        return {**result, 'error': 'existing_session_generation_changed', 'notAdmitted': True}
                    if await prepare_original_input(client, sid, request, snapshot['generation']) != binding:
                        return {**result, 'error': 'input_binding_changed', 'notAdmitted': True}
                attempted = True
                if existing:
                    fence_error = getattr(sys.modules.get('hermes_cli.gateway_client'), 'GatewayRPCError', None)
                    try:
                        receipt = await fenced_submit(client, sid, request, binding)
                    except Exception as exc:
                        if fence_error is not None and isinstance(exc, fence_error) and str(exc) in FENCE_REFUSALS:
                            # The owner refused inside/before the fenced write: nothing was admitted.
                            return {**result, 'error': f'existing_session_{exc}', 'notAdmitted': True}
                        raise  # ambiguous: UNKNOWN below, never resubmitted or replaced
                    # A receipt of the fenced submit: at its acceptance the session was at the observed
                    # generation with nothing queued/started/unknown (checked in the write transaction).
                    # ``queued`` is the normal status of that new admission, not evidence of a race.
                    result['preflight']['atomicIdleFence'] = True
                else:
                    receipt = await client.rpc('prompt.submit', session_id=sid, input_id=request['requestId'],
                                               text=request['text'], finite=False, unattended=False)
                aid = receipt['admission_id']
                if existing and not same_admission(receipt, home, sid, aid):
                    result.pop('preflight', None)
                    return {**result, 'error': 'wrong_admission', 'notAdmitted': False}
            else:
                aid = request['admissionId']
            receipt = await client.rpc('prompt.receipt', session_id=sid, admission_id=aid, include_result=False)
            if not same_admission(receipt, home, sid, aid):
                return {**result, 'error': 'wrong_admission', 'notAdmitted': False}
            result['receipt'] = receipt_metadata(receipt)
            completed = receipt.get('status') == 'terminal' and receipt.get('outcome') == 'completed'
            if completed:
                durable = await client.rpc('prompt.receipt', session_id=sid, admission_id=aid, include_result=True)
                if (not same_admission(durable, home, sid, aid)
                        or durable.get('status') != 'terminal' or durable.get('outcome') != 'completed'):
                    return {**result, 'error': 'wrong_admission', 'notAdmitted': False}
                saved = durable.get('result')
                if isinstance(saved, dict) and any(saved.get(key) for key in ('failed', 'error', 'interrupted')):
                    return result  # Contradictory durable failure cannot become success via replay.
                text = saved.get('final_response') if isinstance(saved, dict) else None
                if isinstance(text, str) and text:
                    result['finalText'] = text[:200_000]
                    return result  # Durable settlement survives replay eviction; never scrape history.
            replay = await client.rpc('session.events.since', session_id=sid,
                                      last_sequence=request.get('lastSequence', 0),
                                      replay_epoch=request.get('replayEpoch') or snapshot.get('replay_epoch'))
            result['replayEpoch'] = replay.get('replay_epoch')
            result['lastSequence'] = replay.get('last_sequence', 0)
            result['awaitingHuman'] = bool(snapshot.get('pending') or replay.get('open_requests'))
            # A replay gap is a missing-evidence gate, never permission to scrape a transcript.
            if completed and not replay.get('truncated') and not replay.get('snapshot_required'):
                for frame in replay.get('events', []):
                    event = frame.get('params', frame)
                    payload = event.get('payload') or {}
                    if event.get('session_id') == sid and event.get('admission_id') == aid:
                        if event.get('type') == 'message.complete' and isinstance(payload.get('text'), str):
                            result['finalText'] = payload['text'][:200_000]
            return result
    except Exception:
        return {**result, 'error': 'native_admission_unknown' if attempted else 'native_attach_failed',
                'notAdmitted': not attempted and request['action'] in {'submit', 'submit_existing', 'prepare_existing'}}
    finally:
        if reset_override is not None and token is not None:
            reset_override(token)


def main() -> None:
    request = json.load(sys.stdin)
    sys.path.insert(0, sys.argv[1])
    # Dependency diagnostics must not corrupt the JSON protocol or reveal private settings.
    with contextlib.redirect_stdout(sys.stderr):
        try:
            result = asyncio.run(asyncio.wait_for(execute(request), timeout=25))
        except Exception:
            result = {'error': 'native_transport_unknown', 'notAdmitted': False}
    json.dump(result, sys.stdout)


if __name__ == '__main__':
    main()
