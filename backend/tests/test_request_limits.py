from __future__ import annotations

import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi import HTTPException

from backend.app import main
from backend.app import runtime
from backend.app.api import app_state_api


class AppStateLimitTest(unittest.TestCase):
    """アプリ状態は任意のJSONを受けるため、総量の上限が無いと際限なく積める。"""

    def test_a_normal_payload_passes(self) -> None:
        app_state_api._assert_app_state_within_limits({"processes": [{"id": "p1"}]})

    def test_an_oversized_payload_is_rejected(self) -> None:
        payload = {"blob": "あ" * 2_000_000}

        with self.assertRaises(HTTPException) as context:
            app_state_api._assert_app_state_within_limits(payload)

        self.assertEqual(context.exception.status_code, 413)

    def test_a_deeply_nested_payload_is_rejected(self) -> None:
        payload: dict[str, object] = {}
        node = payload
        for _ in range(runtime.MAX_APP_STATE_DEPTH + 5):
            child: dict[str, object] = {}
            node["child"] = child
            node = child

        with self.assertRaises(HTTPException) as context:
            app_state_api._assert_app_state_within_limits(payload)

        self.assertEqual(context.exception.status_code, 413)

    def test_a_payload_with_too_many_elements_is_rejected(self) -> None:
        payload = {"rows": [{"i": index} for index in range(runtime.MAX_APP_STATE_NODES)]}

        with self.assertRaises(HTTPException) as context:
            app_state_api._assert_app_state_within_limits(payload)

        self.assertEqual(context.exception.status_code, 413)


class LoginRateLimitTest(unittest.TestCase):
    """/api/auth/google は未認証で呼べて、1回ごとにGoogleの検証まで進む。"""

    def setUp(self) -> None:
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        patcher = patch.dict(os.environ, {
            "GOOGLE_OAUTH_CLIENT_ID": "test-client-id",
            "APP_AUTH_SECRET": "test-secret",
            "AYATORI_AUTH_DIR": str(Path(directory.name) / "auth"),
        })
        patcher.start()
        self.addCleanup(patcher.stop)
        runtime._login_limiter.reset()
        self.addCleanup(runtime._login_limiter.reset)

        from fastapi.testclient import TestClient

        self.client = TestClient(main.app, raise_server_exceptions=False)

    def test_repeated_logins_from_one_client_are_throttled(self) -> None:
        headers = {"Host": "127.0.0.1:8000", "X-Forwarded-For": "203.0.113.9"}
        statuses = []
        for _ in range(runtime.LOGIN_RATE_PER_MINUTE + 2):
            response = self.client.post(
                "/api/auth/google", json={"credential": "not-a-real-token"}, headers=headers
            )
            statuses.append(response.status_code)

        self.assertNotIn(429, statuses[: runtime.LOGIN_RATE_PER_MINUTE])
        self.assertEqual(statuses[-1], 429)

    def test_an_oversized_credential_is_rejected_before_verification(self) -> None:
        response = self.client.post(
            "/api/auth/google",
            json={"credential": "a" * 20_000},
            headers={"Host": "127.0.0.1:8000", "X-Forwarded-For": "203.0.113.10"},
        )

        self.assertEqual(response.status_code, 422)

    def test_a_request_declaring_a_huge_body_is_rejected(self) -> None:
        response = self.client.request(
            "PUT",
            "/api/app-state",
            content=b"{}",
            headers={
                "Host": "127.0.0.1:8000",
                "Content-Type": "application/json",
                "Content-Length": str(runtime.MAX_REQUEST_BYTES + 1),
            },
        )

        self.assertEqual(response.status_code, 413)

    def test_spoofed_forwarded_for_values_share_one_bucket(self) -> None:
        """X-Forwarded-For の左側を毎回変えても、プロキシが足した接続元で数える。"""
        statuses = []
        for index in range(runtime.LOGIN_RATE_PER_MINUTE + 2):
            response = self.client.post(
                "/api/auth/google",
                json={"credential": "not-a-real-token"},
                headers={
                    "Host": "127.0.0.1:8000",
                    "X-Forwarded-For": f"198.51.100.{index}, 203.0.113.20",
                },
            )
            statuses.append(response.status_code)

        self.assertEqual(statuses[-1], 429)


class ClientIpTest(unittest.TestCase):
    def client_ip(self, forwarded: str, hops: str) -> str:
        from starlette.requests import Request

        from backend.app.api.middleware import _client_ip

        request = Request({
            "type": "http",
            "headers": [(b"x-forwarded-for", forwarded.encode())],
            "client": ("10.0.0.1", 12345),
        })
        with patch.dict(os.environ, {"AYATORI_TRUSTED_PROXY_HOPS": hops}):
            return _client_ip(request)

    def test_uses_the_value_added_by_trusted_proxies(self) -> None:
        self.assertEqual(self.client_ip("1.1.1.1, 203.0.113.5", "1"), "203.0.113.5")
        self.assertEqual(self.client_ip("1.1.1.1, 203.0.113.5, 34.0.0.1", "2"), "203.0.113.5")

    def test_falls_back_to_the_peer_when_the_header_is_untrusted_or_short(self) -> None:
        self.assertEqual(self.client_ip("203.0.113.5", "0"), "10.0.0.1")
        self.assertEqual(self.client_ip("203.0.113.5", "2"), "10.0.0.1")


if __name__ == "__main__":
    unittest.main()
