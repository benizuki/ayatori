from __future__ import annotations

import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from backend.app.core.auth import auth_enabled, demo_login_enabled, validate_auth_configuration
from backend.tests.test_request_authorization import build_client
from backend.app import runtime


class DemoLoginConfigurationTest(unittest.TestCase):
    def test_demo_login_requires_login_without_google(self) -> None:
        with patch.dict(os.environ, {"AYATORI_API_HOST": "127.0.0.1", "AYATORI_DEMO_LOGIN": "1"}, clear=True):
            validate_auth_configuration()
            self.assertTrue(demo_login_enabled())
            self.assertTrue(auth_enabled())

    def test_demo_login_cannot_be_combined_with_google(self) -> None:
        with patch.dict(
            os.environ,
            {"AYATORI_API_HOST": "0.0.0.0", "GOOGLE_OAUTH_CLIENT_ID": "id", "AYATORI_DEMO_LOGIN": "1"},
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "AYATORI_DEMO_LOGIN"):
                validate_auth_configuration()

    def test_demo_login_is_rejected_on_public_bind_and_production(self) -> None:
        for extra in ({"AYATORI_API_HOST": "0.0.0.0"}, {"AYATORI_API_HOST": "127.0.0.1", "APP_ENV": "production"}):
            with patch.dict(os.environ, {"AYATORI_DEMO_LOGIN": "1", **extra}, clear=True):
                with self.assertRaises(RuntimeError):
                    validate_auth_configuration()


class DemoLoginApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        auth_dir = Path(self.directory.name) / "auth"
        patcher = patch.dict(os.environ, {"AYATORI_DEMO_LOGIN": "1", "AYATORI_API_HOST": "127.0.0.1"}, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        from backend.app import main
        from backend.app.core import auth

        # AUTH_DIR は読み込み時に決まるため、モジュールの値ごと一時ディレクトリへ差し替える。
        for name, value in (
            ("AUTH_DIR", auth_dir),
            ("USER_MASTER_FILE", auth_dir / "user_master.json"),
            ("TENANT_MASTER_FILE", auth_dir / "tenant_master.json"),
            ("MIGRATION_STATE_FILE", auth_dir / "migrations.json"),
            ("AUTH_SECRET_FILE", auth_dir / "app_auth_secret"),
            ("_stored_auth_secrets", {}),
        ):
            target = patch.object(auth, name, value)
            target.start()
            self.addCleanup(target.stop)
        runtime._login_limiter.__init__()
        self.auth_dir = auth_dir
        self.client = build_client(self, self.directory.name)

    def login(self, email: str):
        return self.client.post("/api/auth/demo", json={"email": email})

    def test_config_advertises_demo_login(self) -> None:
        body = self.client.get("/api/auth/config").json()
        self.assertTrue(body["demo_login_enabled"])
        self.assertFalse(body["google_oauth_enabled"])

    def test_requires_login_and_rejects_bad_email(self) -> None:
        self.assertEqual(self.client.get("/api/interviews").status_code, 401)
        self.assertEqual(self.login("not-an-email").status_code, 400)

    def test_first_user_is_admin_and_next_is_tenant_user(self) -> None:
        first = self.login("first@example.com")
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["user"]["role"], "admin")
        self.assertEqual(self.client.get("/api/auth/me").json()["email"], "first@example.com")
        # 署名鍵は未設定なので、生成した鍵がデータ領域に保存される。
        self.assertTrue((self.auth_dir / "app_auth_secret").read_text().strip())

        second_client = build_client(self, self.directory.name)
        second = second_client.post("/api/auth/demo", json={"email": "Second@Example.com"}).json()["user"]
        self.assertEqual(second["email"], "second@example.com")
        self.assertEqual(second["role"], "none")
        self.assertEqual(second["tenant_memberships"][0]["role"], "user")

    def test_same_email_logs_in_again_without_duplicating(self) -> None:
        self.login("a@example.com")
        again = self.login("a@example.com")
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.json()["user"]["role"], "admin")


class DemoLoginDisabledTest(unittest.TestCase):
    def test_endpoint_is_not_available_without_demo_flag(self) -> None:
        with TemporaryDirectory() as directory, patch.dict(os.environ, {"AYATORI_API_HOST": "127.0.0.1"}, clear=True):
            client = build_client(self, directory)
            self.assertEqual(client.post("/api/auth/demo", json={"email": "a@example.com"}).status_code, 404)
            self.assertFalse(client.get("/api/auth/config").json()["demo_login_enabled"])


if __name__ == "__main__":
    unittest.main()
