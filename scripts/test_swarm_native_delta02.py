"""Delta02 only: real canonical wire models + installed policy, synthetic RPCs/configs.

Run with the existing installed dependency runtime and agent root on PYTHONPATH.
Never connect to a gateway, instantiate an agent, or read real profile settings.
"""
import asyncio
import builtins
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

def offline_only(event, _args):
    if event in {'socket.connect', 'socket.getaddrinfo', 'subprocess.Popen', 'os.system'}:
        raise AssertionError('offline contract suite forbids network/process effects')

sys.addaudithook(offline_only)

from tui_gateway.contracts.canonical import PromptReceiptResult
from tui_gateway.contracts.canonical_sessions import CanonicalReplayEvent
from tui_gateway.contracts.events import MessageCompletePayload

FINAL = 'STATE: DONE\nFILES_CHANGED: synthetic\nCOMMANDS_RUN: synthetic\nRESULT: delivered\nBLOCKER: none\nNEXT_ACTION: review\nSWARM_DELIVERY: {"artifact":{"revision":"' + 'a' * 40 + '","sha256":"' + 'b' * 64 + '","path":"synthetic/frozen.patch"}}'


def bridge_module():
    spec = importlib.util.spec_from_file_location('delta_bridge', Path(__file__).parents[1] / 'src/server/swarm-native-bridge.py')
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NativeContractDelta(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name) / '.hermes/profiles/argus-developer-local'
        self.home.mkdir(parents=True)
        (self.home / 'config.yaml').write_text('{}')
        self.calls = []
        self.receipt_sid = 'synthetic-owner'
        self.receipt_aid = 'synthetic-admission'
        self.receipt_profile = str(self.home)
        self.status, self.outcome = 'terminal', 'completed'
        self.saved = None
        self.events = []
        self.gap = False
        self.submit_failure = False
        self.fail_before_submit = False
        self.endpoint = types.SimpleNamespace(profile_id=str(self.home))
        self.module = bridge_module()
        owner = self

        class Client:
            async def rpc(self, method, **params):
                owner.calls.append((method, params))
                if owner.fail_before_submit:
                    raise RuntimeError('synthetic pre-submit failure')
                if method == 'runtime.describe':
                    return {'profile_id': str(owner.home)}
                if method == 'session.create':
                    return {'session_id': 'synthetic-owner', 'stored_session_id': 'synthetic-owner', 'info': {'yolo': False}, 'pending': []}
                if method == 'session.resume':
                    return {'session_id': 'synthetic-compression-tip', 'stored_session_id': 'synthetic-compression-tip', 'messages': [{'role': 'assistant', 'content': 'PRIVATE TRANSCRIPT'}], 'info': {}}
                if method == 'session.info':
                    return {'model': 'saved-model', 'provider': 'saved-provider', 'cwd': 'synthetic-configured-cwd'}
                if method == 'prompt.submit':
                    if owner.submit_failure:
                        raise RuntimeError('synthetic lost acknowledgment')
                    return owner.receipt(False)
                if method == 'prompt.receipt':
                    return owner.receipt(params.get('include_result') is True)
                if method == 'session.events.since':
                    return {'events': owner.events, 'truncated': owner.gap, 'snapshot_required': owner.gap, 'replay_epoch': 'synthetic-epoch', 'last_sequence': 3, 'open_requests': []}
                raise AssertionError(method)

        @asynccontextmanager
        async def connect_gateway(*, endpoint):
            self.assertIs(endpoint, self.endpoint)
            self.assertEqual(os.environ['HERMES_HOME'], str(self.home))
            self.assertEqual(os.environ['HERMES_PROFILE'], self.home.name)
            yield Client()

        self.modules = patch.dict(sys.modules, {
            'hermes_cli.gateway_client': types.SimpleNamespace(connect_gateway=connect_gateway),
            'hermes_cli.gateway_runtime': types.SimpleNamespace(discover_gateway_endpoint=lambda home: types.SimpleNamespace(state='ready', endpoint=self.endpoint), control_home_for=lambda home, endpoint: home),
            'hermes_cli.gateway_lifecycle_guards': types.SimpleNamespace(live_work=lambda home, profile: {'profile': profile, 'active_agents': 0, 'active_work': []}),
            'hermes_constants': types.SimpleNamespace(set_hermes_home_override=lambda home: None, reset_hermes_home_override=lambda token: None),
        })
        self.modules.start()
        self.env = patch.dict(os.environ)
        self.env.start()
        self.request = {'action': 'submit', 'workerId': self.home.name, 'profileHome': str(self.home), 'cwd': self.temp.name, 'requestId': 'synthetic-request', 'title': 'Synthetic source task', 'text': 'synthetic task'}

    def receipt(self, include):
        return PromptReceiptResult.model_validate({'admission_id': self.receipt_aid, 'ref': {'profile_id': self.receipt_profile, 'session_id': self.receipt_sid}, 'sequence': 1, 'status': self.status, 'outcome': self.outcome, 'authority_epoch': 1, 'execution_generation': 1, 'result': self.saved if include else None}).model_dump(exclude_none=True)

    def event(self, sid='synthetic-owner', aid='synthetic-admission', text=FINAL):
        payload = MessageCompletePayload(text=text, reasoning='PRIVATE REASONING').model_dump(exclude_none=True)
        self.assertNotIn('admission_id', payload)
        return CanonicalReplayEvent(type='message.complete', session_id=sid, admission_id=aid, payload=payload, replay_epoch='synthetic-epoch', seq=3, authority_epoch=1, execution_generation=1).model_dump(exclude_none=True)

    def tearDown(self):
        self.env.stop()
        self.modules.stop()
        self.temp.cleanup()

    def test_top_level_admission_event_reaches_scoped_final_text(self):
        self.events = [self.event()]
        value = asyncio.run(self.module.execute(self.request))
        self.assertEqual(value.get('finalText'), FINAL)
        self.assertNotIn('PRIVATE REASONING', json.dumps(value))

    def test_wrong_replay_admission_or_session_is_not_output(self):
        self.events = [self.event(aid='wrong'), self.event(sid='wrong')]
        value = asyncio.run(self.module.execute(self.request))
        self.assertNotIn('finalText', value)

    def test_durable_terminal_result_survives_absent_or_evicted_ring(self):
        self.saved = {'final_response': FINAL, 'reasoning': 'PRIVATE REASONING', 'messages': [{'content': 'PRIVATE TRANSCRIPT'}]}
        for gap in (False, True):
            with self.subTest(gap=gap):
                self.gap = gap
                value = asyncio.run(self.module.execute(self.request))
                self.assertEqual(value.get('finalText'), FINAL)
                self.assertNotIn('PRIVATE', json.dumps(value))
                self.assertNotIn('result', value['receipt'])
                self.assertTrue(any(method == 'prompt.receipt' and params['include_result'] is True for method, params in self.calls))

    def test_nonterminal_or_failed_receipt_cannot_supply_delivery(self):
        self.saved = {'final_response': FINAL}
        self.events = [self.event()]
        for status, outcome in [('started', None), ('terminal', 'failed'), ('terminal', 'cancelled')]:
            with self.subTest(status=status, outcome=outcome):
                self.status, self.outcome = status, outcome
                value = asyncio.run(self.module.execute(self.request))
                self.assertNotIn('finalText', value)

    def test_failed_durable_result_cannot_recover_success_from_replay(self):
        self.events = [self.event()]
        for flag in ('failed', 'error', 'interrupted'):
            with self.subTest(flag=flag):
                self.saved = {'final_response': FINAL, flag: True}
                value = asyncio.run(self.module.execute(self.request))
                self.assertNotIn('finalText', value)

    def test_exact_receipt_binding_rejects_wrong_profile_session_or_admission(self):
        self.saved = {'final_response': FINAL}
        request = {**self.request, 'action': 'inspect', 'sessionId': 'synthetic-owner', 'admissionId': 'synthetic-admission'}
        for field in ('receipt_profile', 'receipt_sid', 'receipt_aid'):
            before = getattr(self, field)
            setattr(self, field, 'wrong')
            value = asyncio.run(self.module.execute(request))
            setattr(self, field, before)
            self.assertEqual(value.get('error'), 'wrong_admission')
            self.assertNotIn('finalText', value)

    def test_compacted_inspect_uses_receipt_owner_without_resume_or_transcript(self):
        self.saved = {'final_response': FINAL}
        value = asyncio.run(self.module.execute({**self.request, 'action': 'inspect', 'sessionId': 'synthetic-owner', 'admissionId': 'synthetic-admission'}))
        self.assertNotIn('error', value)
        self.assertEqual(value.get('sessionId'), 'synthetic-owner')
        self.assertEqual(value.get('finalText'), FINAL)
        self.assertNotIn('session.resume', dict(self.calls))
        self.assertNotIn('session.create', dict(self.calls))
        self.assertNotIn('prompt.submit', dict(self.calls))

    def test_import_failure_is_proven_pre_admission(self):
        original = builtins.__import__
        def broken(name, *args, **kwargs):
            if name == 'hermes_cli.gateway_client':
                raise ImportError('synthetic missing dependency')
            return original(name, *args, **kwargs)
        with patch('builtins.__import__', broken):
            try:
                value = asyncio.run(self.module.execute(self.request))
            except ImportError:
                value = {'notAdmitted': False}
        self.assertIs(value.get('notAdmitted'), True)
        self.assertEqual(self.calls, [])

    def test_before_and_after_submit_failures_keep_distinct_fences(self):
        self.fail_before_submit = True
        value = asyncio.run(self.module.execute(self.request))
        self.assertIs(value.get('notAdmitted'), True)
        self.fail_before_submit, self.submit_failure = False, True
        value = asyncio.run(self.module.execute(self.request))
        self.assertIs(value.get('notAdmitted'), False)
        self.assertEqual(sum(method == 'prompt.submit' for method, _ in self.calls), 1)

    def test_actual_installed_policy_keeps_configured_local_and_ssh_cwd(self):
        before = (self.home / 'config.yaml').read_bytes()
        asyncio.run(self.module.execute(self.request))
        params = dict(self.calls)['session.create']
        self.assertEqual((self.home / 'config.yaml').read_bytes(), before)
        self.assertIs(params.get('cwd_explicit'), False)
        self.assertNotEqual(params.get('cwd'), self.temp.name)
        self.modules.stop()  # Use the actual installed policy/constants, not fixture imports.
        from gateway.session_policy import build_policy
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override
        local = Path(self.temp.name) / 'configured-workspace'
        local.mkdir()
        token = set_hermes_home_override(self.home)
        try:
            for backend, cwd in [('local', str(local)), ('ssh', '/srv/synthetic-remote-workspace')]:
                config = {'terminal': {'backend': backend, 'cwd': cwd}, 'model': {'default': 'synthetic-saved-model'}}
                (self.home / 'config.yaml').write_text(json.dumps(config))
                policy = build_policy({key: value for key, value in params.items() if key != 'title'} | {'toolsets': []}, config, private_secrets={})
                self.assertEqual(json.loads(policy.terminal_json)['TERMINAL_CWD'], cwd)
                if backend == 'local':
                    self.assertEqual(policy.cwd, cwd)
        finally:
            reset_hermes_home_override(token)
        self.assertFalse((self.home.parent / 'default').exists())


if __name__ == '__main__':
    unittest.main()
