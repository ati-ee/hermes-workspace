"""B2 bridge tests: one NEW admission in an explicitly selected existing reviewer session.

Synthetic only: a fake canonical client that answers the idle-admission-v1 wire shapes
(``runtime.describe`` capabilities, ``session.resume metadata_only``, ``prompt.submit
idle_fence``, typed owner refusals). No installed gateway, real admission, network or service.
The real native parser/authority/store behind these shapes is exercised by the separate native
candidate's ``tests/gateway/test_idle_admission_v1.py`` and the combined compatibility harness.
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from contextlib import asynccontextmanager
from unittest.mock import patch

SID = 'local-reviewer-synthetic-0001'


class GatewayRPCError(ValueError):
    """Shape of hermes_cli.gateway_client.GatewayRPCError: ``str(exc)`` is the owner's reason."""

    def __init__(self, reason, code=4001, data=None):
        super().__init__(reason)
        self.code, self.data = code, data or {'reason': reason}


class ExistingSessionBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name) / 'profiles' / 'argus-reviewer'
        self.home.mkdir(parents=True)
        (self.home / 'config.yaml').write_text('model: synthetic-saved-model\n')
        self.calls = []
        self.capabilities = ['durable-admission-v1', 'event-replay-v1', 'idle-admission-v1', 'original-input-lookup-v1']
        self.row = {'session_id': SID, 'id': SID, 'title': 'Synthetic reviewer', 'source': 'desktop', 'running': False}
        self.snapshot_overrides = {}
        self.resume_refusal = None
        self.submit_effect = None
        self.receipt_ref = {'profile_id': str(self.home), 'session_id': SID}
        self.endpoint = types.SimpleNamespace(profile_id=str(self.home))
        spec = importlib.util.spec_from_file_location('bridge_existing', Path(__file__).parents[1] / 'src/server/swarm-native-bridge.py')
        assert spec is not None and spec.loader is not None
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        owner = self

        class Client:
            async def rpc(self, method, **params):
                owner.calls.append((method, params))
                if method == 'runtime.describe':
                    return {'profile_id': str(owner.home), 'capabilities': owner.capabilities}
                if method == 'session.list':
                    if params != {'limit': 200}:
                        raise AssertionError(f'cold/stored listing must not be used: {params}')
                    return {'sessions': [owner.row] if owner.row else [], 'scope': 'live'}
                if method == 'session.resume':
                    if params != {'session_id': SID, 'metadata_only': True}:
                        raise AssertionError(f'only the metadata-only attach is allowed: {params}')
                    if owner.resume_refusal is not None:
                        raise owner.resume_refusal
                    snapshot = {'session_id': SID, 'stored_session_id': SID, 'messages': [], 'message_count': 9,
                                'running': False, 'execution_state': 'idle', 'pending_count': 0,
                                'authority_epoch': 2, 'replay_epoch': 'synthetic-epoch', 'last_sequence': 40,
                                'subscription_id': 'sub', 'revision': 5, 'execution_generation': 3,
                                'pending': [], 'prompts': [],
                                'info': {'desktop_protocol': 'hermes-gateway-v1', 'source': 'desktop',
                                         'profile_id': str(owner.home), 'yolo': False}}
                    snapshot.update(owner.snapshot_overrides)
                    return snapshot
                if method == 'session.create':
                    raise AssertionError('session.create must never run for an existing-session selection')
                if method == 'prompt.prepare_input':
                    return owner.synthetic_binding()
                if method == 'prompt.submit':
                    if owner.submit_effect is not None:
                        raise owner.submit_effect
                    return {'admission_id': 'new-admission-1', 'ref': owner.receipt_ref, 'sequence': 41,
                            'status': 'queued', 'outcome': None, 'authority_epoch': 2, 'execution_generation': None}
                if method == 'prompt.receipt':
                    return {'admission_id': 'new-admission-1', 'ref': owner.receipt_ref, 'sequence': 41,
                            'status': 'queued', 'outcome': None, 'authority_epoch': 2, 'execution_generation': None}
                if method == 'session.events.since':
                    return {'events': [{'type': 'message.complete', 'session_id': SID, 'admission_id': 'old-admission',
                                        'payload': {'text': 'PRIVATE EARLIER REVIEW'}}],
                            'last_sequence': 41, 'replay_epoch': 'synthetic-epoch'}
                raise AssertionError(method)

        @asynccontextmanager
        async def connect_gateway(*, endpoint):
            self.assertIs(endpoint, self.endpoint)
            yield Client()

        modules = {
            'hermes_cli.gateway_client': types.SimpleNamespace(connect_gateway=connect_gateway, GatewayRPCError=GatewayRPCError),
            'hermes_cli.gateway_runtime': types.SimpleNamespace(discover_gateway_endpoint=lambda home: types.SimpleNamespace(state='ready', endpoint=self.endpoint), control_home_for=lambda home, endpoint: home),
            'hermes_cli.gateway_lifecycle_guards': types.SimpleNamespace(live_work=lambda home, profile: {'profile': profile, 'active_agents': 0, 'active_work': []}),
            'hermes_constants': types.SimpleNamespace(set_hermes_home_override=lambda home: None, reset_hermes_home_override=lambda token: None),
        }
        self.patches = patch.dict(sys.modules, modules)
        self.patches.start()
        self.env = patch.dict(os.environ)
        self.env.start()
        self.request = {'action': 'submit_existing', 'workerId': 'argus-reviewer', 'profileHome': str(self.home),
                        'cwd': self.temp.name, 'requestId': 'mission-9:assignment-4', 'title': 'Synthetic review',
                        'text': 'Review exact artifact', 'sessionId': SID}

    def tearDown(self):
        self.env.stop()
        self.patches.stop()
        self.temp.cleanup()

    def synthetic_binding(self):
        # Synthetic adapter fixture only; real owner binding is exercised in test_swarm_native_contract.
        return {'version': 'original-input-lookup-v1', 'ref': {'profile_id': str(self.home), 'session_id': SID},
                'input_id': self.request['requestId'], 'principal_binding': 'c'*64, 'payload_fingerprint': 'd'*64,
                'idle_fence': {'expected_generation': 3}}

    def run_bridge(self, **overrides):
        return asyncio.run(self.module.execute({**self.request, 'inputBinding': self.synthetic_binding(), **overrides}))

    def methods(self):
        return [method for method, _ in self.calls]

    def counters(self, result):
        return {'session_create': self.methods().count('session.create'), 'submits': self.methods().count('prompt.submit'),
                'resumes': self.methods().count('session.resume'), 'error': result.get('error')}

    def test_positive_new_admission_in_the_same_existing_session_with_the_atomic_fence(self):
        result = self.run_bridge()
        self.assertNotIn('error', result, result)
        self.assertEqual(result['sessionId'], SID)
        self.assertEqual(result['receipt']['admission_id'], 'new-admission-1')
        self.assertEqual(result['receipt']['ref'], {'profile_id': str(self.home), 'session_id': SID})
        self.assertEqual(result['preflight'], {'source': 'desktop', 'executionGeneration': 3, 'idleVerified': True,
                                               'atomicIdleFence': True, 'capability': 'idle-admission-v1'})
        submit = [params for method, params in self.calls if method == 'prompt.submit']
        self.assertEqual(submit, [{'session_id': SID, 'input_id': 'mission-9:assignment-4', 'text': 'Review exact artifact',
                                   'finite': False, 'unattended': False, 'idle_fence': {'expected_generation': 3}}])
        self.assertEqual(self.methods()[:5], ['runtime.describe', 'session.list', 'session.resume', 'prompt.prepare_input', 'prompt.submit'])
        self.assertNotIn('PRIVATE EARLIER REVIEW', json.dumps(result))  # another admission's text never leaks
        self.assertNotIn('messages', result)
        print('COUNTERS bridge_positive', json.dumps(self.counters(result)))

    def test_missing_native_capability_fails_closed_before_attach_or_submit(self):
        self.capabilities = ['durable-admission-v1', 'event-replay-v1']
        result = self.run_bridge()
        self.assertEqual((result['error'], result['notAdmitted']), ('native_idle_fence_unavailable', True))
        self.assertEqual(self.methods(), ['runtime.describe'])
        print('COUNTERS bridge_no_capability', json.dumps(self.counters(result)))

    def test_missing_lookup_capability_refuses_before_any_attach_or_submit(self):
        self.capabilities.remove('original-input-lookup-v1')
        result = self.run_bridge()
        self.assertEqual((result['error'], result['notAdmitted']), ('native_input_lookup_unavailable', True))
        self.assertEqual(self.methods(), ['runtime.describe'])

    def test_changed_original_binding_never_submits(self):
        binding = self.synthetic_binding()
        binding['principal_binding'] = 'e'*64
        result = self.run_bridge(inputBinding=binding)
        self.assertEqual((result['error'], result['notAdmitted']), ('input_binding_changed', True))
        self.assertNotIn('prompt.submit', self.methods())

    def test_only_argus_reviewer_may_select_an_existing_session(self):
        for worker in ('argus-developer-local', 'orchestrator-argus'):
            home = Path(self.temp.name) / 'profiles' / worker
            home.mkdir(parents=True, exist_ok=True)
            (home / 'config.yaml').write_text('model: synthetic\n')
            result = self.run_bridge(workerId=worker, profileHome=str(home))
            self.assertEqual((result['error'], result['notAdmitted']), ('existing_session_not_allowed', True))
        self.assertEqual(self.calls, [])

    def test_cold_foreign_source_busy_redirected_or_unattended_sessions_never_submit(self):
        cases = [
            ('existing_session_not_live', lambda: setattr(self, 'row', None)),
            ('existing_session_source_not_allowed', lambda: self.row.update(source='telegram')),
            ('existing_session_source_not_allowed', lambda: self.row.update(source='tool')),
            ('existing_session_source_not_allowed', lambda: self.row.update(source='kanban')),
            ('existing_session_busy', lambda: self.row.update(running=True)),
            ('existing_session_busy', lambda: self.snapshot_overrides.update(pending_count=1)),
            ('existing_session_busy', lambda: self.snapshot_overrides.update(execution_state='unknown')),
            ('existing_session_busy', lambda: self.snapshot_overrides.update(open_requests=[{'id': 'approval'}])),
            ('existing_session_redirected', lambda: self.snapshot_overrides.update(stored_session_id='local-other-0001')),
            ('metadata_attach_unverified', lambda: self.snapshot_overrides.update(messages=[{'role': 'user', 'content': 'x'}])),
            ('existing_session_source_not_allowed', lambda: self.snapshot_overrides.update(info={'source': 'local', 'yolo': False})),
            ('attended_policy_unverified', lambda: self.snapshot_overrides.update(info={'source': 'desktop', 'yolo': True})),
            ('existing_session_generation_unknown', lambda: self.snapshot_overrides.update(execution_generation=None)),
        ]
        for expected, mutate in cases:
            self.calls.clear()
            self.row = {'session_id': SID, 'id': SID, 'title': 't', 'source': 'desktop', 'running': False}
            self.snapshot_overrides = {}
            mutate()
            result = self.run_bridge()
            self.assertEqual((result.get('error'), result.get('notAdmitted')), (expected, True), expected)
            self.assertNotIn('prompt.submit', self.methods(), expected)
            self.assertNotIn('session.create', self.methods(), expected)

    def test_definitive_fence_refusals_are_not_admitted_and_never_retried(self):
        for reason in ('session_busy', 'stale_generation', 'runtime_draining', 'permission_denied'):
            self.calls.clear()
            self.submit_effect = GatewayRPCError(reason)
            result = self.run_bridge()
            self.assertEqual((result['error'], result['notAdmitted']), (f'existing_session_{reason}', True))
            self.assertEqual(self.methods().count('prompt.submit'), 1)
            self.assertNotIn('session.create', self.methods())

    def test_lost_reply_or_conflict_is_unknown_with_one_submit_and_no_fallback_session(self):
        for effect in (TimeoutError('reply lost'), ConnectionResetError('socket closed'), GatewayRPCError('admission_conflict')):
            self.calls.clear()
            self.submit_effect = effect
            result = self.run_bridge()
            self.assertEqual((result['error'], result['notAdmitted']), ('native_admission_unknown', False), effect)
            self.assertEqual(self.methods().count('prompt.submit'), 1)
            self.assertNotIn('session.create', self.methods())
            self.assertNotIn('reply lost', json.dumps(result))
        print('COUNTERS bridge_lost_reply', json.dumps(self.counters(result)))

    def test_mismatched_native_receipt_is_never_a_binding(self):
        self.receipt_ref = {'profile_id': str(self.home), 'session_id': 'local-other-0001'}
        result = self.run_bridge()
        self.assertEqual((result['error'], result['notAdmitted']), ('wrong_admission', False))
        self.assertNotIn('receipt', result)
        self.assertNotIn('preflight', result)

    def test_old_gateway_without_metadata_attach_fails_closed_before_submit(self):
        self.resume_refusal = GatewayRPCError('invalid_params')  # an owner whose contract lacks metadata_only
        result = self.run_bridge()
        self.assertEqual((result['error'], result['notAdmitted']), ('native_attach_failed', True))
        self.assertNotIn('prompt.submit', self.methods())

    def test_same_developer_uses_existing_session_only_with_source_opt_in(self):
        self.home = Path(self.temp.name) / 'profiles' / 'argus-developer'
        self.home.mkdir(parents=True)
        (self.home / 'config.yaml').write_text('model: synthetic-saved-route\n')
        self.receipt_ref['profile_id'] = str(self.home)
        self.endpoint.profile_id = str(self.home)
        os.environ['ARGUS_WORKSPACE_GPU_SOURCE_ENABLED'] = '1'
        result = self.run_bridge(workerId='argus-developer', profileHome=str(self.home))
        self.assertNotIn('error', result, result)
        self.assertEqual(result['sessionId'], SID)
        self.assertEqual(self.methods().count('prompt.submit'), 1)
        self.assertNotIn('session.create', self.methods())
        self.calls.clear()
        os.environ.pop('ARGUS_WORKSPACE_GPU_SOURCE_ENABLED')
        result = self.run_bridge(workerId='argus-developer', profileHome=str(self.home))
        self.assertEqual(result.get('error'), 'existing_session_not_allowed')
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
