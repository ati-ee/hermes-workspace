"""C2-1 actual Python execute/RPC boundary, using fresh real Native owner receipts.

Run only through the existing official Native scripts/run_tests.sh in a private test overlay.
Transport/discovery/inventory are labelled fixtures; AuthorityConnection/SQLite/receipt generation
is real. No socket, profile installation, scheduling/model execution or TS subprocess is exercised.
"""
import asyncio
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope='module', autouse=True)
def isolated_boundary(tmp_path_factory):
    assert os.environ.get('HERMES_TEST_ISOLATION')
    assert os.environ.get('HERMES_DISABLE_LAZY_INSTALLS') == '1'
    root = tmp_path_factory.mktemp('c21-owned')
    denied = []
    def audit(event, _args):
        if event in {'socket.connect', 'socket.bind', 'socket.getaddrinfo', 'subprocess.Popen',
                     'os.system', 'os.exec', 'os.posix_spawn'}:
            denied.append(event)
            raise AssertionError('C21 component forbids network/process: ' + event)
    sys.addaudithook(audit)  # Before bridge, harness or owning Native imports.
    with pytest.MonkeyPatch.context() as patch:
        for key in ('HOME', 'HERMES_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
                    'XDG_STATE_HOME', 'TMPDIR'):
            path = root / key.lower(); path.mkdir(); patch.setenv(key, str(path))
        import tempfile
        patch.setattr(tempfile, 'tempdir', str(root / 'tmpdir'))
        inputs = Path(__file__).with_name('workspace_c21_inputs')
        bridge = load('c21_bridge_under_test', inputs / 'swarm-native-bridge.py')
        harness = load('c21_actual_owner_harness', inputs / 'swarm-native-lookup-contract-harness.py')
        yield root, inputs, bridge, harness
    assert denied == []


@pytest.fixture(scope='module')
def owner_cases(isolated_boundary):
    root, _inputs, _bridge, harness = isolated_boundary
    cases = {}
    for kind in ('queued', 'not_found', 'mismatch', 'unavailable', 'terminal'):
        home = root / kind / 'profiles/argus-reviewer'; home.mkdir(parents=True)
        (home / 'config.yaml').write_text('model: synthetic-unused-route\n')
        state = root / kind / 'owner'; state.mkdir()
        sid, request_id = 'local-c21-server-synthetic-0001', 'c21-owned-input'
        req = {'requestId': request_id, 'text': 'Server-authored C21 synthetic input'}
        def step(**kw):
            return asyncio.run(harness.run({'state': str(state), 'profile': str(home),
                                            'session': sid, **kw}))
        prepared = step(step='prepare', generation=0, request=req)
        assert prepared['counters'] == {'db_writes': 0, 'scheduled': 0, 'unchanged': True}
        binding = prepared['binding']
        if kind != 'not_found':
            submitted = step(step='submit', binding=binding,
                             request={**req, 'text': req['text'] + (' different' if kind == 'mismatch' else '')})
            assert submitted['counts']['admissions'] == 1
        if kind == 'terminal':
            step(step='settle')
        found = step(step='lookup', live=False, retired=kind == 'unavailable',
                     request={'requestId': request_id, 'inputBinding': binding})
        assert found['counters'] == {'db_writes': 0, 'scheduled': 0, 'unchanged': True}
        receipt = None
        if kind in ('queued', 'terminal'):
            receipt = step(step='inspect', admissionId=found['result']['lookup']['admission']['admission_id'])['receipt']
        cases[kind] = {'home': home, 'sid': sid, 'request': req, 'binding': binding,
                       'lookup': found['result']['lookup'], 'receipt': receipt}
    from gateway import session_input_lookup
    native = Path(__file__).resolve().parents[2]
    assert Path(session_input_lookup.__file__).resolve() == native / 'gateway/session_input_lookup.py'
    return cases


def execute(isolated_boundary, monkeypatch, case, action, *, prepared=None, lookup=None):
    _root, _inputs, bridge, _harness = isolated_boundary
    calls = []
    class Client:
        async def rpc(self, method, **params):
            calls.append((method, params))
            if method == 'runtime.describe':
                return {'profile_id': str(case['home']), 'capabilities': [bridge.IDLE_ADMISSION_CAPABILITY, bridge.LOOKUP_CAPABILITY]}
            if method == 'session.list':
                return {'sessions': [{'session_id': case['sid'], 'source': 'desktop', 'running': False}]}
            if method == 'session.resume':
                return {'session_id': case['sid'], 'stored_session_id': case['sid'], 'messages': [],
                        'pending': [], 'prompts': [], 'running': False, 'execution_state': 'idle',
                        'pending_count': 0, 'open_requests': [], 'pending_connection': None,
                        'execution_generation': 0, 'info': {'source': 'desktop', 'yolo': False}}
            if method == 'prompt.prepare_input': return copy.deepcopy(prepared)
            if method == 'prompt.lookup_input': return copy.deepcopy(lookup)
            if method in ('prompt.submit', 'prompt.receipt'): return copy.deepcopy(case['receipt'])
            if method == 'session.events.since': return {'events': [], 'last_sequence': 0, 'replay_epoch': 'synthetic'}
            raise AssertionError('Unexpected RPC: ' + method)
    endpoint = SimpleNamespace(profile_id=str(case['home']))
    @asynccontextmanager
    async def connect_gateway(*, endpoint):
        yield Client()
    modules = {
        'hermes_cli.gateway_client': SimpleNamespace(connect_gateway=connect_gateway),
        'hermes_cli.gateway_runtime': SimpleNamespace(discover_gateway_endpoint=lambda home: SimpleNamespace(state='ready', endpoint=endpoint), control_home_for=lambda home, endpoint: home),
        'hermes_cli.gateway_lifecycle_guards': SimpleNamespace(live_work=lambda home, profile: {'profile': profile, 'active_agents': 0, 'active_work': []}),
    }
    for name, module in modules.items(): monkeypatch.setitem(sys.modules, name, module)
    req = {**case['request'], 'action': action, 'workerId': 'argus-reviewer',
           'profileHome': str(case['home']), 'sessionId': case['sid'],
           'inputBinding': copy.deepcopy(case['binding'])}
    boundary_errors = []
    helper_name = 'lookup_original_input' if action == 'lookup' else 'prepare_original_input'
    real_helper = getattr(bridge, helper_name)
    async def observe_boundary(*args, **kwargs):
        try:
            return await real_helper(*args, **kwargs)
        except ValueError as exc:
            boundary_errors.append(str(exc))
            raise
    monkeypatch.setattr(bridge, helper_name, observe_boundary)
    result = asyncio.run(bridge.execute(req))
    return result, [name for name, _params in calls], boundary_errors


def mutate(value, path, change):
    raw = copy.deepcopy(value)
    target = raw
    for part in path.split('.')[:-1]: target = target[part]
    key = path.split('.')[-1]
    if change == '__DELETE__': target.pop(key)
    else: target[key] = change
    return raw


PREPARE_FAULTS = [
    ('future_private_field', 'synthetic expansion'), ('ref.messages', []),
    ('idle_fence.future', True), ('version', '__DELETE__'), ('version', 'future-v2'),
    ('input_id', '__DELETE__'), ('input_id', True), ('input_id', 'other-input'),
    ('ref', []), ('ref.profile_id', 'foreign-profile'), ('ref.session_id', 'foreign-session'),
    ('principal_binding', 'c'*64+'\n'), ('payload_fingerprint', 'not-a-digest'),
    ('idle_fence', None), ('idle_fence.expected_generation', True),
    ('idle_fence.expected_generation', 0.0), ('idle_fence.expected_generation', -1),
    ('idle_fence.expected_generation', 2**53), ('idle_fence.expected_generation', 1),
]


PREPARE_FAULTS += [(key, '__DELETE__') for key in ('ref', 'principal_binding', 'payload_fingerprint', 'idle_fence',
                                                'ref.profile_id', 'ref.session_id', 'idle_fence.expected_generation')]
PREPARE_FAULTS += [('principal_binding', None), ('payload_fingerprint', 123), ('ref.profile_id', ''),
                   ('idle_fence.expected_generation', '0')]


@pytest.mark.parametrize('action', ['prepare_existing', 'submit_existing'])
@pytest.mark.parametrize('path,change', PREPARE_FAULTS)
def test_raw_prepare_refuses_before_submit(isolated_boundary, owner_cases, monkeypatch, action, path, change):
    case = owner_cases['queued']
    result, calls, errors = execute(isolated_boundary, monkeypatch, case, action,
                            prepared=mutate(case['binding'], path, change))
    assert result.get('error') and result.get('notAdmitted') is True
    assert result.get('error') == 'native_attach_failed' and errors == ['native_input_prepare_invalid']
    assert 'inputBinding' not in result and 'receipt' not in result
    assert 'prompt.submit' not in calls and 'session.create' not in calls


LOOKUP_FAULTS = [
    ('messages', []), ('ref.extra', True), ('admission.extra', True), ('proof.extra', True),
    ('proof.idle_fence.extra', True), ('version', '__DELETE__'), ('version', 'future-v2'),
    ('state', 'unknown'), ('reason', 'stale_epoch'), ('binding', None), ('settled', 1),
    ('input_id', True), ('input_id', 'other-input'), ('ref.session_id', 'other-session'),
    ('principal_binding', 'f'*64), ('admission', []), ('proof', None),
    ('admission.admission_id', ''), ('admission.sequence', True), ('admission.sequence', 0),
    ('admission.sequence', 1.0), ('admission.sequence', 2**53),
    ('admission.authority_epoch', -1), ('admission.execution_generation', False),
    ('admission.status', 'future'), ('admission.status', 'terminal'),
    ('admission.outcome', 'completed'), ('proof.payload_fingerprint', 'f'*64),
    ('proof.idle_fence.expected_generation', 1),
]


LOOKUP_FAULTS += [(key, '__DELETE__') for key in ('state', 'reason', 'ref', 'input_id', 'principal_binding', 'binding',
    'admission', 'proof', 'settled', 'ref.profile_id', 'ref.session_id', 'admission.admission_id', 'admission.sequence',
    'admission.status', 'admission.outcome', 'admission.authority_epoch', 'admission.execution_generation',
    'proof.payload_fingerprint', 'proof.idle_fence', 'proof.idle_fence.expected_generation')]
LOOKUP_FAULTS += [('proof.idle_fence.expected_generation', True), ('proof.idle_fence.expected_generation', 0.0),
    ('proof.idle_fence.expected_generation', 2**53), ('proof.payload_fingerprint', 'f'*64+'\n'),
    ('admission.authority_epoch', 2**53), ('admission.execution_generation', 2**53), ('settled', True)]


@pytest.mark.parametrize('path,change', LOOKUP_FAULTS)
def test_raw_lookup_rejects_without_positive_rebind(isolated_boundary, owner_cases, monkeypatch, path, change):
    case = owner_cases['queued']
    result, calls, errors = execute(isolated_boundary, monkeypatch, case, 'lookup',
                            lookup=mutate(case['lookup'], path, change))
    assert result.get('error') and result.get('notAdmitted') is False
    assert result.get('error') == 'native_attach_failed' and errors == ['native_input_lookup_invalid']
    assert 'lookup' not in result and 'receipt' not in result
    assert calls == ['runtime.describe', 'prompt.lookup_input']


@pytest.mark.parametrize('kind', ['queued', 'not_found', 'mismatch', 'unavailable', 'terminal'])
def test_genuine_owner_lookup_semantics_are_unchanged(isolated_boundary, owner_cases, monkeypatch, kind):
    case = owner_cases[kind]
    result, calls, errors = execute(isolated_boundary, monkeypatch, case, 'lookup', lookup=case['lookup'])
    assert 'error' not in result and errors == []
    assert result['lookup'] == case['lookup'] and result['sessionId'] == case['sid']
    assert calls == ['runtime.describe', 'prompt.lookup_input']


def test_valid_prepared_owner_binding_keeps_one_submit(isolated_boundary, owner_cases, monkeypatch):
    case = owner_cases['queued']
    result, calls, errors = execute(isolated_boundary, monkeypatch, case, 'submit_existing', prepared=case['binding'])
    assert 'error' not in result and errors == [] and result['receipt'] == case['receipt']
    assert calls.count('prompt.submit') == 1 and 'session.create' not in calls


def test_record_owner_fixture_without_hand_editing(isolated_boundary):
    root, inputs, _bridge, harness = isolated_boundary
    target = root / 'actual-owner-record.json'
    result = harness.record(target, str(Path(__file__).resolve().parents[2]))
    assert len(result['recorded']) == 5
    control = inputs / 'record-output-path.json'
    if control.is_file():
        Path(json.loads(control.read_text())['output']).write_bytes(target.read_bytes())


@pytest.mark.parametrize('raw', [None, [], 'opaque', True, 7, 0.5])
@pytest.mark.parametrize('action', ['prepare_existing', 'submit_existing', 'lookup'])
def test_non_object_raw_responses_fail_at_rpc_boundary(isolated_boundary, owner_cases, monkeypatch, raw, action):
    result, calls, errors = execute(isolated_boundary, monkeypatch, owner_cases['queued'], action,
                            prepared=raw, lookup=raw)
    verb = 'lookup' if action == 'lookup' else 'prepare'
    assert result.get('error') == 'native_attach_failed' and errors == [f'native_input_{verb}_invalid']
    assert result.get('notAdmitted') is (action != 'lookup')
    assert 'lookup' not in result and 'inputBinding' not in result and 'receipt' not in result
    assert 'prompt.submit' not in calls and 'session.create' not in calls


@pytest.mark.parametrize('kind', ['not_found', 'mismatch', 'unavailable'])
@pytest.mark.parametrize('path,value', [('settled', True), ('binding', 'exact'), ('admission', {}),
    ('proof', {}), ('reason', 'future-reason'), ('ref.extra', 'unknown'), ('messages', [])])
def test_nonpositive_raw_envelopes_still_have_closed_consistent_schemas(
        isolated_boundary, owner_cases, monkeypatch, kind, path, value):
    case = owner_cases[kind]
    result, calls, errors = execute(isolated_boundary, monkeypatch, case, 'lookup',
                            lookup=mutate(case['lookup'], path, value))
    assert result.get('error') == 'native_attach_failed' and errors == ['native_input_lookup_invalid'] and result.get('notAdmitted') is False
    assert 'lookup' not in result and calls == ['runtime.describe', 'prompt.lookup_input']


@pytest.mark.parametrize('path,value', [('settled', False), ('admission.outcome', None),
    ('admission.outcome', ''), ('admission.outcome', 7), ('admission.status', 'started')])
def test_terminal_receipt_requires_real_settlement_consistency(
        isolated_boundary, owner_cases, monkeypatch, path, value):
    case = owner_cases['terminal']
    result, calls, errors = execute(isolated_boundary, monkeypatch, case, 'lookup',
                            lookup=mutate(case['lookup'], path, value))
    assert result.get('error') == 'native_attach_failed' and errors == ['native_input_lookup_invalid'] and 'lookup' not in result
    assert calls == ['runtime.describe', 'prompt.lookup_input']
