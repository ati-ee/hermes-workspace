"""Workspace bridge -> accepted Native parser/authorization/admission transaction, offline.

Only transport/discovery/live-work inventory are fixtures. Native's scheduler is disabled;
no gateway listener, session creation, provider or model turn runs. IDs are private fixture IDs.
Requires the separately pinned Native environment; never install controller deps into it.
"""
import importlib.util
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.mark.asyncio
async def test_same_developer_bridge_uses_real_native_idle_admission(monkeypatch):
    import tests.gateway.test_idle_admission_v1 as native_fixture
    from hermes_cli.gateway_client import GatewayRPCError

    h = native_fixture.IdleAdmissionV1(methodName="test_capability_is_advertised")
    await h.asyncSetUp()
    try:
        home = h.tmp / "profiles" / "argus-developer"
        home.mkdir(parents=True)
        (home / "config.yaml").write_text("model: synthetic-saved-route\n")
        h.authority.profile_id = str(home)
        conn = h._connection({**native_fixture.HUMAN, "profile_id": str(home)})
        calls = []

        class Client:
            async def rpc(self, method, **params):
                calls.append(method)
                reply = await conn.dispatch({"id": len(calls), "method": method, "params": params})
                if "error" in reply:
                    error = reply["error"]
                    raise GatewayRPCError(error["data"]["reason"], error["code"], error["data"])
                return reply["result"]

        endpoint = SimpleNamespace(profile_id=str(home))

        @asynccontextmanager
        async def connect_gateway(*, endpoint):
            assert endpoint.profile_id == str(home)
            yield Client()

        monkeypatch.setattr("hermes_cli.gateway_client.connect_gateway", connect_gateway)
        monkeypatch.setattr("hermes_cli.gateway_runtime.discover_gateway_endpoint", lambda _: SimpleNamespace(state="ready", endpoint=endpoint))
        monkeypatch.setattr("hermes_cli.gateway_runtime.control_home_for", lambda *args: home)
        monkeypatch.setattr("hermes_cli.gateway_lifecycle_guards.live_work", lambda *args, **kwargs: {"profile": "argus-developer", "active_agents": 0, "active_work": []})
        monkeypatch.setenv("ARGUS_WORKSPACE_GPU_SOURCE_ENABLED", "1")
        path = Path(__file__).parents[1] / "src/server/swarm-native-bridge.py"
        spec = importlib.util.spec_from_file_location("workspace_bridge_contract", path)
        bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bridge)
        request = {"action": "submit_existing", "workerId": "argus-developer", "profileHome": str(home),
                   "sessionId": native_fixture.SID, "requestId": "synthetic-mission:synthetic-assignment",
                   "title": "Synthetic continuation", "text": "Synthetic non-executing request"}
        prepared = await bridge.execute({**request, "action": "prepare_existing"})
        assert "error" not in prepared, prepared
        assert not h._rows()  # pure preparation, before the actual admission
        request["inputBinding"] = prepared["inputBinding"]
        response = await bridge.execute(request)
        assert "error" not in response, response
        assert response["receipt"]["ref"] == {"profile_id": str(home), "session_id": native_fixture.SID}
        assert response["preflight"]["atomicIdleFence"] is True
        rows = h._rows()
        assert len(rows) == 1 and rows[0]["request_id"] == request["requestId"]
        assert json.loads(rows[0]["payload_json"])["idle_fence_v1"] == {"expected_generation": 0}
        assert calls.count("prompt.submit") == 1 and "session.create" not in calls
        # The full execute lookup path uses the ACTUAL owner contract, without attach/replay/writes.
        calls.clear()
        found = await bridge.execute({**request, "action": "lookup"})
        assert found["lookup"]["binding"] == "exact", found
        assert found["lookup"]["admission"]["admission_id"] == rows[0]["admission_id"]
        assert calls == ["runtime.describe", "prompt.lookup_input"]
        assert len(h._rows()) == 1
        # A second new assignment cannot queue behind the first one, even if inventory says idle.
        refused = await bridge.execute({**request, "requestId": "synthetic-mission:other-assignment"})
        assert refused.get("notAdmitted") is True, refused
        assert len(h._rows()) == 1
        print("WORKSPACE_NATIVE_REAL_AUTHORITY_COUNTERS", json.dumps({
            "session_create": 0, "admissions": 1, "second_assignment_admissions": 0,
            "model_turns": 0, "session_id": native_fixture.SID,
            "admission_id": rows[0]["admission_id"], "IDs": "PRIVATE FIXTURE; not current Developer admission"}))
    finally:
        await h.asyncTearDown()
