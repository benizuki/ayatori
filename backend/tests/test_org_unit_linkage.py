from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from backend.app.schemas import OrgUnitRecord
from backend.app.storage.sqlite_store import AyatoriSQLiteStore
from backend.app.storage.master_data_store import MasterDataStore
from backend.app import runtime
from backend.app.api import org_units_api
from backend.app.api import common


# 業務を分類するための部門。人の所属ではない。
DEPARTMENTS = [
    {"id": "d16b40e3", "name": "IT・情報システム", "tenantId": "default"},
    {"id": "acct0001", "name": "経理・財務", "tenantId": "default"},
]
# 人の所属を表す組織単位。部門・課・チームの階層を持つ。
ORG_UNITS = [
    OrgUnitRecord(id="itdept01", name="情報システム部", kind="部門", sort_order=0),
    OrgUnitRecord(id="itsec001", parent_id="itdept01", name="基幹システム課", kind="課", sort_order=1),
    OrgUnitRecord(id="itteam01", parent_id="itsec001", name="第一チーム", kind="チーム", sort_order=2),
    OrgUnitRecord(id="acdept01", name="経理部", kind="部門", sort_order=3),
]



def request_for(user: dict | None, tenant_id: str = "default") -> SimpleNamespace:
    return SimpleNamespace(state=SimpleNamespace(user=user, tenant_id=tenant_id))


class OrgUnitLinkageTest(unittest.TestCase):
    """人の所属は組織単位のIDで突合する。業務領域のdepartmentsとは別物。"""

    def setUp(self) -> None:
        import backend.app.main as main

        self.main = main
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        store = AyatoriSQLiteStore(root / "ayatori.sqlite")
        master = MasterDataStore(root / "master-data")
        master.save({"departments": DEPARTMENTS, "businessMasters": []}, "default")
        for patcher in (
            patch.object(runtime, "store", store),
            patch.object(runtime, "master_data_store", master),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        for unit in ORG_UNITS:
            store.save_org_unit(unit, "default")
        self.store = store

    def test_org_unit_resolves_from_both_id_and_name(self) -> None:
        self.assertEqual(
            common._resolve_org_unit("itsec001", "default"), ("itsec001", "基幹システム課")
        )
        self.assertEqual(
            common._resolve_org_unit("基幹システム課", "default"), ("itsec001", "基幹システム課")
        )

    def test_unknown_org_unit_is_not_resolved(self) -> None:
        for value in ("管理者", "存在しない組織", ""):
            with self.subTest(value=value):
                self.assertEqual(common._resolve_org_unit(value, "default"), ("", ""))

    def test_business_departments_are_not_treated_as_an_affiliation(self) -> None:
        """業務領域の部門名は、人の所属としては解決しない。"""
        self.assertEqual(common._resolve_org_unit("経理・財務", "default"), ("", ""))

    def test_subtree_includes_descendants_only(self) -> None:
        self.assertEqual(
            sorted(common._org_unit_subtree_ids("itdept01", "default")),
            ["itdept01", "itsec001", "itteam01"],
        )
        self.assertEqual(common._org_unit_subtree_ids("itteam01", "default"), ["itteam01"])

    def test_auth_response_carries_the_org_unit_id(self) -> None:
        """画面はauth応答のorg_unit_idで所属を判定するため、欠けると設定しても反映されない。"""
        user = common._auth_user_from_dict(
            {
                "email": "sato@example.com",
                "name": "佐藤",
                "org_unit_id": "itsec001",
                "role": "none",
                "tenant_memberships": [],
            }
        )

        self.assertEqual(user.org_unit_id, "itsec001")

    def test_org_units_bootstrap_from_business_departments_when_empty(self) -> None:
        """組織が未整備のテナントは、業務領域を写して初期化する。以降は独立して編集する。"""
        for unit in ORG_UNITS:
            self.store.delete_org_unit(unit.id, "default")

        units = common._tenant_org_units("default")

        self.assertEqual(
            {unit.name for unit in units}, {"IT・情報システム", "経理・財務"}
        )

    def test_bootstrapped_units_get_fresh_ids_and_an_explicit_link(self) -> None:
        """IDを流用すると紐づいて見えて実体がないため、新しいIDを振り関係はリンクで表す。"""
        for unit in ORG_UNITS:
            self.store.delete_org_unit(unit.id, "default")

        units = common._tenant_org_units("default")

        department_ids = {department["id"] for department in DEPARTMENTS}
        self.assertFalse([unit for unit in units if unit.id in department_ids])
        by_name = {unit.name: unit for unit in units}
        self.assertEqual(by_name["経理・財務"].department_ids, ["acct0001"])

    def test_units_reusing_a_department_id_are_given_an_explicit_link(self) -> None:
        """旧実装でIDを流用していた組織へ、担当関係を補う。"""
        self.store.save_org_unit(
            OrgUnitRecord(id="acct0001", name="経理部", kind="部門", updated_at="now"), "default"
        )

        units = {unit.id: unit for unit in common._tenant_org_units("default")}

        self.assertEqual(units["acct0001"].department_ids, ["acct0001"])

    def test_departments_are_linked_many_to_many(self) -> None:
        from backend.app.schemas import OrgUnitUpsert

        request = request_for({"role": "admin"})
        created = org_units_api.create_org_unit(
            OrgUnitUpsert(
                name="購買課",
                kind="課",
                department_ids=["acct0001", "d16b40e3"],
            ),
            request,
        )

        self.assertEqual(created.department_ids, ["acct0001", "d16b40e3"])
        stored = {unit.id: unit for unit in common._tenant_org_units("default")}
        self.assertEqual(stored[created.id].department_ids, ["acct0001", "d16b40e3"])

    def test_one_department_can_be_shared_by_several_org_units(self) -> None:
        from backend.app.schemas import OrgUnitUpsert

        request = request_for({"role": "admin"})
        for name in ("購買課", "資材課"):
            org_units_api.create_org_unit(
                OrgUnitUpsert(name=name, kind="課", department_ids=["acct0001"]), request
            )

        holders = [
            unit.name
            for unit in common._tenant_org_units("default")
            if "acct0001" in unit.department_ids
        ]

        self.assertIn("購買課", holders)
        self.assertIn("資材課", holders)

    def test_unknown_department_cannot_be_linked(self) -> None:
        from backend.app.schemas import OrgUnitUpsert

        with self.assertRaises(HTTPException) as raised:
            org_units_api.create_org_unit(
                OrgUnitUpsert(name="購買課", kind="課", department_ids=["zzzzzzzz"]),
                request_for({"role": "admin"}),
            )

        self.assertEqual(raised.exception.status_code, 422)

    def test_links_to_removed_departments_are_hidden(self) -> None:
        """業務領域が削除された場合、担当関係は表示しない。"""
        self.store.save_org_unit_departments("itsec001", ["acct0001", "gone0001"], "default")

        units = {unit.id: unit for unit in common._tenant_org_units("default")}

        self.assertEqual(units["itsec001"].department_ids, ["acct0001"])

    def test_deleting_an_org_unit_removes_its_links(self) -> None:
        self.store.save_org_unit_departments("itteam01", ["acct0001"], "default")
        self.store.delete_org_unit("itteam01", "default")
        self.store.save_org_unit(
            OrgUnitRecord(id="itteam01", name="再利用", kind="チーム", updated_at="now"), "default"
        )

        units = {unit.id: unit for unit in self.store.list_org_units("default")}

        self.assertEqual(units["itteam01"].department_ids, [])


if __name__ == "__main__":
    unittest.main()
