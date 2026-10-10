from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app import runtime
from backend.app.storage.master_data_store import MasterDataStore
from backend.app.storage.sqlite_store import AyatoriSQLiteStore


class TenantUserAdminScopeTest(unittest.TestCase):
    """テナント管理者は、アカウント全体に効く項目を他テナントの利用者に対して変えられない。"""

    def setUp(self) -> None:
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        auth_dir = root / "auth"
        auth_dir.mkdir(parents=True, exist_ok=True)
        (auth_dir / "tenant_master.json").write_text(
            json.dumps([
                {"id": "a", "name": "A", "enabled": True},
                {"id": "b", "name": "B", "enabled": True},
            ]),
            encoding="utf-8",
        )
        (auth_dir / "user_master.json").write_text(
            json.dumps([
                {
                    "email": "admin-a@example.com", "name": "A管理者", "role": "none", "enabled": True,
                    "tenant_memberships": [{"tenant_id": "a", "role": "admin"}],
                },
                {
                    "email": "shared@example.com", "name": "兼務", "role": "viewer", "enabled": True,
                    "google_subject": "shared-subject",
                    "tenant_memberships": [
                        {"tenant_id": "a", "role": "viewer"},
                        {"tenant_id": "b", "role": "admin"},
                    ],
                },
                {
                    "email": "retired@example.com", "name": "退職者", "role": "none", "enabled": False,
                    "tenant_memberships": [
                        {"tenant_id": "a", "role": "user"},
                        {"tenant_id": "b", "role": "user"},
                    ],
                },
                {
                    "email": "local@example.com", "name": "A専任", "role": "none", "enabled": True,
                    "tenant_memberships": [{"tenant_id": "a", "role": "user"}],
                },
            ], ensure_ascii=False),
            encoding="utf-8",
        )
        env = patch.dict(os.environ, {
            "GOOGLE_OAUTH_CLIENT_ID": "test-client-id",
            "APP_AUTH_SECRET": "test-secret",
        })
        env.start()
        self.addCleanup(env.stop)

        import backend.app.core.auth as auth
        import backend.app.main as main

        for attribute, value in (
            ("AUTH_DIR", auth_dir),
            ("USER_MASTER_FILE", auth_dir / "user_master.json"),
            ("TENANT_MASTER_FILE", auth_dir / "tenant_master.json"),
        ):
            auth_patcher = patch.object(auth, attribute, value)
            auth_patcher.start()
            self.addCleanup(auth_patcher.stop)
        master = MasterDataStore(root / "master-data")
        for tenant_id in ("a", "b"):
            master.save({"departments": [], "businessMasters": []}, tenant_id)
        for patcher in (
            patch.object(runtime, "store", AyatoriSQLiteStore(root / "ayatori.sqlite")),
            patch.object(runtime, "master_data_store", master),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.auth = auth
        token = auth.issue_app_token(auth._find_user_by_email("admin-a@example.com"))
        self.headers = {"Authorization": f"Bearer {token}", "Host": "127.0.0.1:8000", "X-Tenant-ID": "a"}
        self.client = TestClient(main.app, raise_server_exceptions=False)

    def entry(self, email: str) -> dict:
        return next(row for row in self.auth.list_user_master_entries() if row["email"] == email)

    def test_cannot_rebind_a_user_shared_with_other_tenants(self) -> None:
        response = self.client.put("/api/users/shared@example.com", headers=self.headers, json={
            "name": "兼務",
            "email": "attacker@example.com",
            "google_subject": None,
            "tenant_memberships": [{"tenant_id": "a", "role": "viewer"}],
        })

        self.assertEqual(response.status_code, 200)
        shared = self.entry("shared@example.com")
        self.assertEqual(shared["google_subject"], "shared-subject")
        self.assertEqual(shared["role"], "viewer")
        self.assertNotIn("attacker@example.com", [row["email"] for row in self.auth.list_user_master_entries()])

    def test_cannot_re_enable_a_user_shared_with_other_tenants(self) -> None:
        for enabled in (None, True):
            payload = {"name": "退職者", "tenant_memberships": [{"tenant_id": "a", "role": "user"}]}
            if enabled is not None:
                payload["enabled"] = enabled
            response = self.client.put("/api/users/retired@example.com", headers=self.headers, json=payload)
            self.assertEqual(response.status_code, 200)
            self.assertFalse(self.entry("retired@example.com")["enabled"])

    def test_can_manage_identity_of_a_tenant_only_user(self) -> None:
        response = self.client.put("/api/users/local@example.com", headers=self.headers, json={
            "name": "A専任",
            "email": "local-new@example.com",
            "enabled": False,
            "tenant_memberships": [{"tenant_id": "a", "role": "user"}],
        })

        self.assertEqual(response.status_code, 200)
        self.assertFalse(self.entry("local-new@example.com")["enabled"])


class UserMasterUpdateDefaultsTest(unittest.TestCase):
    """更新で省いた項目は現在の値を保つ。"""

    def test_omitted_fields_keep_current_values(self) -> None:
        import backend.app.core.auth as auth

        with TemporaryDirectory() as directory:
            auth_dir = Path(directory)
            (auth_dir / "user_master.json").write_text(json.dumps([{
                "email": "user@example.com", "name": "User", "role": "none",
                "enabled": False, "google_subject": "subject", "tenant_memberships": [],
            }]), encoding="utf-8")
            with patch.object(auth, "AUTH_DIR", auth_dir), \
                    patch.object(auth, "USER_MASTER_FILE", auth_dir / "user_master.json"), \
                    patch.object(auth, "TENANT_MASTER_FILE", auth_dir / "tenant_master.json"):
                updated = auth.update_user_master_entry("user@example.com", {"name": "Renamed"})

        self.assertFalse(updated["enabled"])
        self.assertEqual(updated["google_subject"], "subject")


if __name__ == "__main__":
    unittest.main()
