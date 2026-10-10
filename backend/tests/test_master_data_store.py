from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from backend.app.storage.master_data_store import MASTER_DATA_KEYS, MasterDataStore


class MasterDataStoreTest(unittest.TestCase):
    def test_creates_one_writable_master_file_per_tenant(self) -> None:
        with TemporaryDirectory() as directory:
            store = MasterDataStore(Path(directory))

            master_data = store.load("east")

            master_path = Path(directory) / "east.json"
            self.assertTrue(master_path.is_file())
            self.assertTrue(
                all(
                    department["tenantId"] == "east"
                    for department in master_data["departments"]
                )
            )

    def test_user_created_master_is_saved_with_initial_masters(self) -> None:
        with TemporaryDirectory() as directory:
            store = MasterDataStore(Path(directory))
            master_data = store.load("default")
            master_data["businessMasters"].append(
                {
                    "id": "user-created",
                    "name": "ユーザー作成業務",
                    "departmentId": master_data["departments"][0]["id"],
                    "interviewTopics": [],
                }
            )

            store.save(master_data, "default")
            reloaded = store.load("default")

            self.assertIn(
                "user-created",
                {
                    business["id"]
                    for business in reloaded["businessMasters"]
                },
            )

    def test_splits_master_data_from_application_state(self) -> None:
        with TemporaryDirectory() as directory:
            store = MasterDataStore(Path(directory))
            payload = {
                **store.load("default"),
                "processModels": {"example": {"title": "As-Is"}},
                "updatedAt": "old",
            }

            operational, master_data = store.split_from_app_state(payload, "default")

            self.assertTrue(all(key not in operational for key in MASTER_DATA_KEYS))
            self.assertEqual(operational["processModels"]["example"]["title"], "As-Is")
            self.assertTrue(all(key in master_data for key in MASTER_DATA_KEYS))
            disk_payload = json.loads(
                (Path(directory) / "default.json").read_text(encoding="utf-8")
            )
            self.assertEqual(disk_payload, master_data)

    def test_partial_app_state_keeps_existing_master_data(self) -> None:
        with TemporaryDirectory() as directory:
            store = MasterDataStore(Path(directory))
            existing = store.load("default")

            operational, master_data = store.split_from_app_state(
                {"processVersions": {}},
                "default",
            )

            self.assertEqual(operational, {"processVersions": {}})
            self.assertEqual(master_data, existing)

    def test_existing_tenant_app_state_overrides_generated_master_file(self) -> None:
        with TemporaryDirectory() as directory:
            store = MasterDataStore(Path(directory))
            store.load("east")
            legacy_payload = {
                "departments": [
                    {
                        "id": "tenant-department",
                        "tenantId": "east",
                        "name": "既存テナント部門",
                    }
                ],
                "businessMasters": [
                    {
                        "id": "tenant-business",
                        "departmentId": "tenant-department",
                        "interviewTopics": [],
                    }
                ],
                "processModels": {"tenant-business": {"title": "既存As-Is"}},
            }

            merged = store.merge_into_app_state(legacy_payload, "east")
            reloaded = store.load("east")

            self.assertEqual(
                [department["id"] for department in merged["departments"]],
                ["tenant-department"],
            )
            self.assertEqual(
                reloaded["businessMasters"][0]["id"],
                "tenant-business",
            )
            self.assertEqual(
                merged["processModels"]["tenant-business"]["title"],
                "既存As-Is",
            )

    def test_reads_generated_file_created_with_previous_key_names(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "default.json"
            path.write_text(
                json.dumps(
                    {
                        "departments": [{"id": "department"}],
                        "businessProcessMasters": [{"id": "business"}],
                    }
                ),
                encoding="utf-8",
            )
            store = MasterDataStore(Path(directory))

            master_data = store.load("default")

            self.assertEqual(master_data["businessMasters"][0]["id"], "business")

    def test_legacy_interview_guides_become_draft_business_masters(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "default.json"
            path.write_text(
                json.dumps(
                    {
                        "departments": [{"id": "dept-a"}],
                        "guideTemplates": [
                            {
                                "id": "ar-processing",
                                "name": "売掛処理",
                                "departmentId": "dept-a",
                                "description": "請求から入金消込まで",
                            },
                            {"id": "shared", "name": "共通", "departmentId": "all"},
                            {"id": "dup", "name": "既存業務", "departmentId": "dept-a"},
                        ],
                        "businessMasters": [
                            {"id": "existing", "name": "既存業務", "departmentId": "dept-a"}
                        ],
                    }
                ),
                encoding="utf-8",
            )
            store = MasterDataStore(Path(directory))

            master_data = store.load("default")

            self.assertNotIn("guideTemplates", master_data)
            self.assertEqual(
                [business["id"] for business in master_data["businessMasters"]],
                ["existing", "guide-ar-processing"],
            )
            adopted = master_data["businessMasters"][1]
            self.assertEqual(adopted["name"], "売掛処理")
            self.assertEqual(adopted["status"], "作成中")
            self.assertEqual(adopted["description"], "請求から入金消込まで")

    def test_adopting_legacy_guides_runs_only_once(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "default.json"
            path.write_text(
                json.dumps(
                    {
                        "departments": [{"id": "dept-a"}],
                        "guideTemplates": [
                            {"id": "ar", "name": "売掛処理", "departmentId": "dept-a"}
                        ],
                        "businessMasters": [],
                    }
                ),
                encoding="utf-8",
            )
            store = MasterDataStore(Path(directory))

            store.load("default")
            reloaded = store.load("default")

            self.assertEqual(len(reloaded["businessMasters"]), 1)
            self.assertNotIn("guideTemplates", json.loads(path.read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
