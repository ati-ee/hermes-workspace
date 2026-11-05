"""Test-only contract harness: Workspace's real bridge helpers against the REAL Native implementation.

Usage:
    <native python> -B swarm-native-lookup-contract-harness.py <native checkout>   < step JSON on stdin
    <native python> -B swarm-native-lookup-contract-harness.py <native checkout> --record <fixture.json>
The guarded Vitest lane denies child processes, so ``--record`` captures the real answers offline and
``-swarm-native-lookup-contract.test.ts`` replays them through the real Workspace API/store.

Every invocation is a fresh owner process over one disposable SQLite store (``state``): it begins a new
runtime epoch (an owner restart) and builds a real ``SessionAuthority`` + ``AuthorityConnection`` +
canonical contract dispatch. The bridge's own ``prepare_original_input`` / ``fenced_submit`` /
``lookup_original_input`` call it through an in-process client. Nothing executes a model turn
(``_schedule`` is counted, never run); no network, gateway process, credentials or live profile.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import importlib.util
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

CAPS = ['session:read', 'session:submit', 'session:control', 'session:approve', 'session:respond']


class OwnerRefusal(Exception):
    pass


class InProcessClient:
    """``hermes_cli.gateway_client``'s ``rpc`` shape over the real ``AuthorityConnection.dispatch``."""

    def __init__(self, connection):
        self.connection = connection

    async def rpc(self, method, **params):
        reply = await self.connection.dispatch({'id': 1, 'method': method, 'params': params})
        if 'error' in reply:
            raise OwnerRefusal(reply['error'].get('data', {}).get('reason', 'unknown'))
        return reply['result']


def _bridge():
    path = Path(__file__).with_name('swarm-native-bridge.py')
    spec = importlib.util.spec_from_file_location('workspace_swarm_native_bridge', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def run(step: dict) -> dict:
    state = Path(step['state'])
    os.environ['HERMES_HOME'] = str(state / 'home')
    os.environ.setdefault('HERMES_TEST_ISOLATION', '1')
    (state / 'home').mkdir(parents=True, exist_ok=True)
    from gateway import session_local_recovery, session_policy_refresh
    from gateway.config import Platform
    from gateway.session_authority import LiveSession, SessionAuthority
    from gateway.session_controls import AuthorityConnection
    from hermes_state import SessionDB
    from hermes_state_runtime import begin_runtime_epoch, claim_session_input, settle_session_input

    async def no_refresh(*args, **kwargs):
        return None
    session_policy_refresh.refresh_resumed_policy = no_refresh
    # Same harness boundary as Native's own idle-admission test: no frozen local receipt, so attach's
    # transcript target is the logical id. Admission, fence, contract and store are unpatched.
    session_local_recovery.transcript_target = lambda authority, ref: ref.session_id
    db = SessionDB(db_path=state / 'state.db')
    profile, sid = step['profile'], step['session']
    if db.get_session(sid) is None:
        db.create_session(sid, source='desktop')
    epoch = begin_runtime_epoch(db, instance_id='current')  # every step is a fresh owner
    runner = SimpleNamespace(_draining=False, config=SimpleNamespace(multiplex_profiles=False),
                             _adapter_for_source=lambda source: None)
    authority = SessionAuthority(runner, profile_id=profile, instance_id='current', db=db, epoch=epoch)
    counters = {'db_writes': 0, 'scheduled': 0}
    authority._schedule = lambda ref: counters.__setitem__('scheduled', counters['scheduled'] + 1)
    if step.get('live', True):
        authority.sessions[sid] = LiveSession(SimpleNamespace(platform=Platform.LOCAL, user_id='human', chat_id=sid),
                                              'route-contract')
    if step.get('retired'):
        authority.retired = True
    identity = {'user_id': step.get('principal', 'human'), 'provider': 'local', 'profile_id': profile,
                'instance_id': 'current', 'capabilities': CAPS}
    connection = AuthorityConnection(authority, object(), identity)
    client, bridge = InProcessClient(connection), _bridge()

    def dump():
        with db._read_ctx() as conn:
            return hashlib.sha256('\n'.join(conn.iterdump()).encode()).hexdigest()

    def counts():
        with db._read_ctx() as conn:
            return {'admissions': conn.execute('SELECT COUNT(*) FROM session_admissions').fetchone()[0],
                    'sessions': conn.execute('SELECT COUNT(*) FROM sessions').fetchone()[0]}

    @contextlib.contextmanager
    def zero_writes():
        original = db._execute_write
        def counted(*args, **kwargs):
            counters['db_writes'] += 1
            return original(*args, **kwargs)
        db._execute_write = counted
        before = (dump(), sorted(authority.sessions), dict(connection.subscriptions))
        try:
            yield
        finally:
            db._execute_write = original
            counters['unchanged'] = (dump(), sorted(authority.sessions), dict(connection.subscriptions)) == before

    out: dict = {'step': step['step'], 'epoch': epoch}
    request = step.get('request') or {}
    try:
        if step['step'] == 'prepare':
            with zero_writes():
                out['binding'] = await bridge.prepare_original_input(client, sid, request, step['generation'])
        elif step['step'] == 'submit':
            snapshot = await client.rpc('session.resume', session_id=sid, metadata_only=True)
            out['generation_observed'] = snapshot['execution_generation']
            receipt = await bridge.fenced_submit(client, sid, request, step['binding'])
            out['receipt'] = bridge.receipt_metadata(receipt)
        elif step['step'] == 'lookup':
            with zero_writes():
                out['result'] = await bridge.lookup_original_input(client, request)
        elif step['step'] == 'inspect':
            out['receipt'] = bridge.receipt_metadata(await client.rpc(
                'prompt.receipt', session_id=sid, admission_id=step['admissionId'], include_result=False))
        elif step['step'] == 'settle':
            claimed = claim_session_input(db, epoch=epoch, session_id=sid)
            settle_session_input(db, epoch=epoch, admission_id=claimed['admission_id'],
                                 generation=claimed['generation'], outcome='completed')
            out['settled_admission'] = claimed['admission_id']
        elif step['step'] == 'counts':
            pass
        else:
            raise ValueError(step['step'])
    except OwnerRefusal as exc:
        out['refusal'] = str(exc)
    finally:
        await connection.close()
    out['counters'] = counters
    out['counts'] = counts()
    db.close()
    return out


PROFILE_TOKEN, INPUT_TOKEN, SESSION = '__RECORDED_PROFILE__', '__RECORDED_INPUT_ID__', 'local-contract-synthetic-0001'
TEXT = 'Synthetic contract text for one existing-session producer assignment.'


def record(out_path: Path, agent: str) -> dict:
    """Record every C2 scenario from the real implementation into one fixture (fresh store each).

    The guarded Vitest lane may not spawn processes, so this offline phase captures the real Native
    answers; the Workspace test replays these exact bytes. Only the two identity tokens above are
    rebound by the test to its runtime ids; fingerprints, principal bindings, states and proofs are
    exactly what the owner returned. The run also asserts the owner contract it relies on.
    """
    import tempfile
    base = {'profile': PROFILE_TOKEN, 'session': SESSION}
    request = {'requestId': INPUT_TOKEN, 'text': TEXT}
    scenarios = {}
    for name in ('queued', 'lost_before_admission', 'payload_mismatch', 'owner_unavailable', 'settled_terminal'):
        with tempfile.TemporaryDirectory(prefix=f'c2-{name}-') as state:
            def step(**kw):
                return asyncio.run(run({**base, 'state': state, **kw}))
            got = {'prepare': step(step='prepare', generation=0, request=request)}
            binding = got['prepare']['binding']
            assert got['prepare']['counters'] == {'db_writes': 0, 'scheduled': 0, 'unchanged': True}, got
            if name != 'lost_before_admission':
                text = TEXT + ' (altered)' if name == 'payload_mismatch' else TEXT
                got['submit'] = step(step='submit', binding=binding, request={**request, 'text': text})
            if name == 'settled_terminal':
                got['settle'] = step(step='settle')
            got['lookup'] = step(step='lookup', live=False, retired=name == 'owner_unavailable',
                                 request={'requestId': INPUT_TOKEN, 'inputBinding': binding})
            assert got['lookup']['counters'] == {'db_writes': 0, 'scheduled': 0, 'unchanged': True}, got
            if name in ('queued', 'settled_terminal'):
                found = got['lookup']['result']['lookup']
                assert found['binding'] == 'exact' and found['proof']['payload_fingerprint'] == binding['payload_fingerprint'], found
                assert found['principal_binding'] == binding['principal_binding'], found
                got['inspect'] = step(step='inspect', admissionId=found['admission']['admission_id'])
            scenarios[name] = got
    sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
    fixture = {'schema': 'workspace-c2-native-contract/1', 'native_capability': 'original-input-lookup-v1',
               'native_checkout_session_input_lookup_sha256': sha(Path(agent) / 'gateway/session_input_lookup.py'),
               'native_checkout_canonical_input_lookup_sha256': sha(Path(agent) / 'tui_gateway/contracts/canonical_input_lookup.py'),
               'bridge_sha256': sha(Path(__file__).with_name('swarm-native-bridge.py')),
               'harness_sha256': sha(__file__), 'tokens': {'profile': PROFILE_TOKEN, 'input_id': INPUT_TOKEN},
               'session': SESSION, 'scenarios': scenarios}
    out_path.write_text(json.dumps(fixture, indent=1, sort_keys=True) + '\n')
    return {'recorded': sorted(scenarios), 'out': str(out_path)}


def main() -> None:
    sys.path.insert(0, sys.argv[1])
    if len(sys.argv) == 4 and sys.argv[2] == '--record':
        with contextlib.redirect_stdout(sys.stderr):
            result = record(Path(sys.argv[3]), sys.argv[1])
    else:
        step = json.load(sys.stdin)
        with contextlib.redirect_stdout(sys.stderr):
            result = asyncio.run(run(step))
    json.dump(result, sys.stdout)


if __name__ == '__main__':
    main()
