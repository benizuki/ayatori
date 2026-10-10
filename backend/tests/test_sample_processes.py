from __future__ import annotations

import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app import runtime
from backend.app.resources.initial_data import load_initial_data
from backend.app.resources.sample_processes import SAMPLE_PROCESSES, sample_process_models
from backend.app.storage.master_data_store import MasterDataStore
from backend.app.storage.sqlite_store import AyatoriSQLiteStore


class SampleProcessModelTest(unittest.TestCase):
    """同梱の業務マスターには、画面の機能を試せる実務に近いAs-Isを付ける。"""

    def setUp(self) -> None:
        self.masters = load_initial_data()["businessProcessMasters"]
        self.models = sample_process_models(self.masters)

    def test_every_bundled_business_master_has_a_sample(self) -> None:
        self.assertEqual(set(self.models), {business["id"] for business in self.masters})
        self.assertEqual(
            {sample["business_id"] for sample in SAMPLE_PROCESSES},
            {business["id"] for business in self.masters},
        )

    def test_models_follow_the_tenant_business_master(self) -> None:
        business = {**self.masters[0], "departmentId": "moved"}

        models = sample_process_models([business, {"id": "unknown"}])

        self.assertEqual(list(models), [business["id"]])
        self.assertEqual(models[business["id"]]["departmentId"], "moved")

    def test_samples_are_more_than_start_and_end(self) -> None:
        for business_id, model in self.models.items():
            with self.subTest(business_id):
                tasks = [step for step in model["steps"] if step["type"] == "task"]
                gateways = [step for step in model["steps"] if step["type"] == "gateway"]
                self.assertGreaterEqual(len(tasks), 10)
                self.assertGreaterEqual(len(gateways), 2)
                self.assertGreaterEqual(len(model["lanes"]), 4)
                self.assertTrue(model["information"])
                self.assertTrue(any(step.get("inputs") or step.get("outputs") for step in tasks))

    def test_every_step_is_on_a_path_from_start_to_end(self) -> None:
        for business_id, model in self.models.items():
            with self.subTest(business_id):
                outgoing: dict[str, list[str]] = {}
                incoming: dict[str, list[str]] = {}
                for connection in model["connections"]:
                    outgoing.setdefault(connection["from"], []).append(connection["to"])
                    incoming.setdefault(connection["to"], []).append(connection["from"])
                starts = [step["id"] for step in model["steps"] if step["type"] == "start"]
                ends = [step["id"] for step in model["steps"] if step["type"] == "end"]
                self.assertEqual(len(starts), 1)
                all_ids = {step["id"] for step in model["steps"]}
                self.assertEqual(self._reach(starts, outgoing), all_ids)
                self.assertEqual(self._reach(ends, incoming), all_ids)

    def test_gateways_branch_with_labels(self) -> None:
        for business_id, model in self.models.items():
            for step in model["steps"]:
                if step["type"] != "gateway":
                    continue
                with self.subTest(business_id, gateway=step["id"]):
                    branches = [c for c in model["connections"] if c["from"] == step["id"]]
                    self.assertGreaterEqual(len(branches), 2)
                    self.assertTrue(all(branch.get("label") for branch in branches))

    @staticmethod
    def _reach(roots: list[str], edges: dict[str, list[str]]) -> set[str]:
        seen: set[str] = set()
        pending = list(roots)
        while pending:
            current = pending.pop()
            if current in seen:
                continue
            seen.add(current)
            pending.extend(edges.get(current, []))
        return seen


class AppStateSampleTest(unittest.TestCase):
    """保存前のテナントにはサンプルを返し、保存後は保存した内容だけを返す。"""

    def setUp(self) -> None:
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        env = patch.dict(os.environ, {
            "GOOGLE_OAUTH_CLIENT_ID": "",
            "AYATORI_DEMO_LOGIN": "",
            "AYATORI_API_HOST": "127.0.0.1",
        })
        env.start()
        self.addCleanup(env.stop)

        import backend.app.core.auth as auth
        import backend.app.main as main

        auth_dir = root / "auth"
        for attribute, value in (
            ("AUTH_DIR", auth_dir),
            ("USER_MASTER_FILE", auth_dir / "user_master.json"),
            ("TENANT_MASTER_FILE", auth_dir / "tenant_master.json"),
        ):
            patcher = patch.object(auth, attribute, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for patcher in (
            patch.object(runtime, "store", AyatoriSQLiteStore(root / "ayatori.sqlite")),
            patch.object(runtime, "master_data_store", MasterDataStore(root / "master-data")),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.client = TestClient(main.app, raise_server_exceptions=False)
        self.headers = {"Host": "127.0.0.1:8000"}

    def test_a_new_tenant_receives_the_sample_flows(self) -> None:
        response = self.client.get("/api/app-state", headers=self.headers)

        self.assertEqual(response.status_code, 200)
        payload = response.json()["payload"]
        self.assertEqual(
            set(payload["processModels"]),
            {business["id"] for business in payload["businessMasters"]},
        )
        # 返しただけでは保存しない。
        self.assertEqual(runtime.store.load_app_state("default"), {})

    def test_saved_state_is_returned_as_is(self) -> None:
        saved = self.client.put(
            "/api/app-state",
            headers={**self.headers, "Content-Type": "application/json"},
            json={"payload": {"processModels": {}}},
        )
        self.assertEqual(saved.status_code, 200)

        payload = self.client.get("/api/app-state", headers=self.headers).json()["payload"]

        self.assertEqual(payload["processModels"], {})


if __name__ == "__main__":
    unittest.main()
