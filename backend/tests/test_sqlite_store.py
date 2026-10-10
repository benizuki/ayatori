from __future__ import annotations

import json
import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from backend.app.schemas import OrgUnitRecord
from backend.app.storage.sqlite_store import AyatoriSQLiteStore


class SQLiteStoreTest(unittest.TestCase):
    def test_app_state_file_does_not_grow_with_repeated_saves(self) -> None:
        """同じ行の上書きでファイルが膨らまないこと。

        As-Isの編集中はワークスペース全体のJSONを繰り返し保存するため、
        書き込み回数に比例してファイルが増えないことが前提になる。
        """
        with TemporaryDirectory() as directory:
            path = Path(directory) / "ayatori.sqlite"
            store = AyatoriSQLiteStore(path)
            payload = {
                "processModels": {
                    f"business-{index}": {"steps": [{"id": f"step-{step}", "label": "工程名" * 8} for step in range(30)]}
                    for index in range(30)
                }
            }
            # 実際のアプリ状態と同じ桁（数十KB）で試す。
            self.assertGreater(len(json.dumps(payload, ensure_ascii=False)), 40_000)

            def total_size() -> int:
                return sum(
                    candidate.stat().st_size
                    for candidate in path.parent.iterdir()
                    if candidate.name.startswith(path.name)
                )

            store.save_app_state(payload, "first")
            size_after_first = total_size()
            for index in range(300):
                store.save_app_state(payload, f"save-{index}")

            self.assertLess(total_size(), size_after_first * 2)

    def test_backup_is_a_readable_snapshot(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "ayatori.sqlite"
            backup_path = Path(directory) / "backups" / "ayatori-test.sqlite"
            store = AyatoriSQLiteStore(path)
            store.save_app_state({"value": "before backup"}, "now")

            store.create_backup(backup_path)
            store.save_app_state({"value": "after backup"}, "later")

            self.assertTrue(backup_path.is_file())
            with sqlite3.connect(str(backup_path)) as connection:
                row = connection.execute(
                    "SELECT payload_json FROM app_state WHERE state_key = ?", ("default",)
                ).fetchone()
            self.assertEqual(json.loads(row[0]), {"value": "before backup"})

    def test_deleting_an_org_unit_drops_its_department_links(self) -> None:
        with TemporaryDirectory() as directory:
            store = AyatoriSQLiteStore(Path(directory) / "ayatori.sqlite")
            store.save_org_unit(
                OrgUnitRecord(id="unit-a", tenant_id="default", parent_id="", name="経理課", kind="課"),
                "default",
            )
            store.save_org_unit_departments("unit-a", ["dept-1", "dept-2"], "default")

            self.assertTrue(store.delete_org_unit("unit-a", "default"))
            self.assertFalse(store.delete_org_unit("unit-a", "default"))
            store.save_org_unit(
                OrgUnitRecord(id="unit-a", tenant_id="default", parent_id="", name="再作成", kind="課"),
                "default",
            )
            self.assertEqual(store.list_org_units("default")[0].department_ids, [])

    def test_interview_sessions_are_replaced_wholesale(self) -> None:
        with TemporaryDirectory() as directory:
            store = AyatoriSQLiteStore(Path(directory) / "ayatori.sqlite")
            store.save_interview_sessions({})

            self.assertEqual(store.load_interview_sessions(), {})


if __name__ == "__main__":
    unittest.main()
