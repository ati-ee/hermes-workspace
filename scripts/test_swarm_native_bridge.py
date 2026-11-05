"""Private synthetic native boundary tests; no installed gateway or real admissions."""
import asyncio
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from contextlib import asynccontextmanager
from unittest.mock import patch


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name) / 'profiles' / 'argus-developer-local'
        self.home.mkdir(parents=True)
        (self.home / 'config.yaml').write_text('model: synthetic-saved-model\n')
        self.calls = []
        self.busy = False
        self.wrong = False
        self.fail_admission = False
        self.submitted = False
        self.endpoint = types.SimpleNamespace(profile_id=str(self.home))
        spec = importlib.util.spec_from_file_location('bridge', Path(__file__).parents[1] / 'src/server/swarm-native-bridge.py')
        assert spec is not None and spec.loader is not None
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        owner = self

        class Client:
            async def rpc(self, method, **params):
                owner.calls.append((method, params))
                if method == 'runtime.describe':
                    return {'profile_id': 'wrong' if owner.wrong else str(owner.home)}
                if method == 'session.list':
                    return {'sessions': [{'session_id': 'ordinary-native', 'running': True, 'title': 'Synthetic ordinary GUI', 'source': 'local'}]}
                if method == 'session.info':
                    return {'model': 'saved-model', 'provider': 'saved-provider', 'reasoning_effort': 'saved-effort'}
                if method == 'session.create':
                    return {'session_id': 'synthetic-session', 'stored_session_id': 'synthetic-session', 'running': False, 'pending': [], 'prompts': [], 'replay_epoch': 'synthetic-epoch', 'info': {'model': 'saved-model', 'provider': 'saved-provider', 'reasoning_effort': 'saved-effort', 'yolo': False}}
                if method == 'prompt.submit':
                    owner.submitted = True
                    if owner.fail_admission:
                        raise RuntimeError('synthetic private error never exposed')
                    return {'admission_id': 'synthetic-admission', 'ref': {'profile_id': str(owner.home), 'session_id': 'synthetic-session'}, 'status': 'queued', 'outcome': None}
                if method == 'prompt.receipt':
                    return {'admission_id': 'synthetic-admission', 'ref': {'profile_id': str(owner.home), 'session_id': 'synthetic-session'}, 'status': 'terminal', 'outcome': 'completed'}
                if method == 'session.events.since':
                    return {'events': [
                        {'type': 'message.complete', 'session_id': 'synthetic-session', 'admission_id': 'unrelated', 'replay_epoch': 'synthetic-epoch', 'seq': 4, 'payload': {'text': 'PRIVATE OTHER RESULT'}},
                        {'type': 'message.complete', 'session_id': 'synthetic-session', 'admission_id': 'synthetic-admission', 'replay_epoch': 'synthetic-epoch', 'seq': 5, 'payload': {'text': 'STATE: DONE\nRESULT: synthetic'}},
                    ], 'last_sequence': 5}
                raise AssertionError(method)

        @asynccontextmanager
        async def connect_gateway(*, endpoint):
            self.assertIs(endpoint, self.endpoint)
            self.assertEqual(os.environ['HERMES_HOME'], str(self.home))
            self.assertEqual(os.environ['HERMES_PROFILE'], self.home.name)
            yield Client()

        modules = {
            'hermes_cli.gateway_client': types.SimpleNamespace(connect_gateway=connect_gateway),
            'hermes_cli.gateway_runtime': types.SimpleNamespace(discover_gateway_endpoint=lambda home: types.SimpleNamespace(state='ready', endpoint=self.endpoint), control_home_for=lambda home, endpoint: home),
            'hermes_cli.gateway_lifecycle_guards': types.SimpleNamespace(live_work=lambda home, profile: {'profile': profile, 'active_agents': int(self.busy), 'active_work': []}),
            'hermes_constants': types.SimpleNamespace(set_hermes_home_override=lambda home: None, reset_hermes_home_override=lambda token: None),
        }
        self.patches = patch.dict(sys.modules, modules)
        self.patches.start()
        self.env = patch.dict(os.environ)
        self.env.start()
        self.request = {'action': 'submit', 'workerId': 'argus-developer-local', 'profileHome': str(self.home), 'cwd': self.temp.name, 'requestId': 'synthetic-request', 'title': 'Synthetic only', 'text': 'Synthetic task'}

    def tearDown(self):
        self.env.stop()
        self.patches.stop()
        self.temp.cleanup()

    def test_attach_preserves_saved_route_and_attended_admission(self):
        before = (self.home / 'config.yaml').read_bytes()
        result = asyncio.run(self.module.execute(self.request))
        self.assertEqual(result['receipt']['admission_id'], 'synthetic-admission')
        self.assertEqual(result['reasoningEffort'], 'saved-effort')
        self.assertNotIn('PRIVATE OTHER', str(result))
        create = dict(self.calls)['session.create']
        self.assertTrue(create['follow_profile_config'])
        self.assertFalse(create['yolo'])
        self.assertFalse({'model', 'provider', 'api_key', 'base_url', 'toolsets', 'ignore_rules'} & create.keys())
        submit = dict(self.calls)['prompt.submit']
        self.assertIs(submit['finite'], False)
        self.assertIs(submit['unattended'], False)
        self.assertIs(dict(self.calls)['prompt.receipt']['include_result'], True)
        self.assertEqual((self.home / 'config.yaml').read_bytes(), before)
        self.assertEqual([p.name for p in self.home.iterdir()], ['config.yaml'])

    def test_busy_and_wrong_profile_never_create_or_submit(self):
        for busy, wrong, reason in [(True, False, 'profile_busy'), (False, True, 'wrong_profile')]:
            self.busy, self.wrong = busy, wrong
            self.calls.clear()
            result = asyncio.run(self.module.execute(self.request))
            self.assertEqual(result['error'], reason)
            self.assertTrue(result['notAdmitted'])
            self.assertNotIn('session.create', dict(self.calls))
            self.assertNotIn('prompt.submit', dict(self.calls))

    def test_main_binds_exact_existing_orchestrator_without_default_or_inventory_reuse(self):
        self.home = Path(self.temp.name) / 'profiles' / 'orchestrator-argus'
        self.home.mkdir()
        (self.home / 'config.yaml').write_text('model: synthetic-saved-orchestrator\n')
        self.endpoint.profile_id = str(self.home)
        request = {**self.request, 'workerId': 'orchestrator-argus', 'profileHome': str(self.home), 'title': 'ARGUS synthetic dedicated mission'}
        result = asyncio.run(self.module.execute(request))
        self.assertEqual(result['profileId'], str(self.home))
        self.assertEqual(result['model'], 'saved-model')
        self.assertEqual(result['provider'], 'saved-provider')
        self.assertEqual(result['reasoningEffort'], 'saved-effort')
        create = dict(self.calls)['session.create']
        self.assertEqual(create['source'], 'gui')
        self.assertEqual(create['request_id'], 'synthetic-request')
        self.assertNotIn('session_id', create)
        self.assertNotIn('session.resume', dict(self.calls))
        self.assertFalse({'model', 'provider', 'reasoning', 'reasoning_effort'} & create.keys())
        self.assertFalse((self.home.parent / 'default').exists())

    def test_admission_failure_is_unknown_and_never_retried(self):
        self.fail_admission = True
        result = asyncio.run(self.module.execute(self.request))
        self.assertEqual(result['error'], 'native_admission_unknown')
        self.assertFalse(result['notAdmitted'])
        self.assertEqual(sum(method == 'prompt.submit' for method, _ in self.calls), 1)
        self.assertNotIn('private error', str(result))

    def test_status_does_not_attach_subscribe_or_admit_to_any_session(self):
        result = asyncio.run(self.module.execute({**self.request, 'action': 'status'}))
        self.assertTrue(result['connected'])
        self.assertEqual(result['sessions'][0]['sessionId'], 'ordinary-native')
        self.assertEqual(result['sessions'][0]['source'], 'local')
        self.assertNotIn('session.create', dict(self.calls))
        self.assertNotIn('session.resume', dict(self.calls))
        self.assertNotIn('prompt.submit', dict(self.calls))


if __name__ == '__main__':
    unittest.main()
