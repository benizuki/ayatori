from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from google.auth.exceptions import InvalidValue, TransportError

from backend.app.core import auth

FIRST_GOOGLE_USER = {
    "google_subject": "subject",
    "email": "admin@example.com",
    "name": "Admin",
    "picture": "",
}


class GoogleAuthVerificationTest(unittest.TestCase):
    @patch.dict(os.environ, {"AYATORI_BOOTSTRAP_ADMIN_EMAILS": "Admin@Example.com"})
    @patch.object(auth, "create_user_master_entry")
    @patch.object(auth, "list_user_master_entries", return_value=[])
    @patch.object(auth, "verify_google_credential")
    def test_first_google_user_is_created_without_an_org_assignment(
        self,
        verify_credential,
        _list_users,
        create_user,
    ) -> None:
        verify_credential.return_value = dict(FIRST_GOOGLE_USER)
        create_user.return_value = {
            "email": "admin@example.com",
            "google_subject": "subject",
            "name": "Admin",
            "department": None,
            "department_id": None,
            "org_unit_id": None,
            "role": "admin",
            "tenant_memberships": [],
            "enabled": True,
        }

        user = auth.authenticate_google_credential("credential")

        create_user.assert_called_once_with(
            email="admin@example.com",
            google_subject="subject",
            name="Admin",
            department=None,
            department_id=None,
            org_unit_id=None,
            role="admin",
            enabled=True,
        )
        self.assertEqual(user["email"], "admin@example.com")

    @patch.dict(os.environ, {"AYATORI_BOOTSTRAP_ADMIN_EMAILS": ""})
    @patch.object(auth, "create_user_master_entry")
    @patch.object(auth, "list_user_master_entries", return_value=[])
    @patch.object(auth, "verify_google_credential")
    def test_empty_user_master_does_not_hand_admin_to_the_first_visitor(
        self,
        verify_credential,
        _list_users,
        create_user,
    ) -> None:
        """許可リストが無いまま自動作成すると、公開URLの第三者が管理者になる。"""
        verify_credential.return_value = dict(FIRST_GOOGLE_USER)

        with self.assertRaises(HTTPException) as context:
            auth.authenticate_google_credential("credential")

        self.assertEqual(context.exception.status_code, 403)
        create_user.assert_not_called()

    @patch.dict(os.environ, {"AYATORI_BOOTSTRAP_ADMIN_EMAILS": "owner@example.com"})
    @patch.object(auth, "create_user_master_entry")
    @patch.object(auth, "list_user_master_entries", return_value=[])
    @patch.object(auth, "verify_google_credential")
    def test_bootstrap_admin_is_limited_to_the_allow_list(
        self,
        verify_credential,
        _list_users,
        create_user,
    ) -> None:
        verify_credential.return_value = dict(FIRST_GOOGLE_USER)

        with self.assertRaises(HTTPException) as context:
            auth.authenticate_google_credential("credential")

        self.assertEqual(context.exception.status_code, 403)
        create_user.assert_not_called()

    @patch("google.oauth2.id_token.verify_oauth2_token")
    @patch.object(auth, "google_oauth_client_id", return_value="client-id")
    def test_google_token_verification_allows_small_clock_skew(
        self,
        _client_id,
        verify_token,
    ) -> None:
        verify_token.return_value = {
            "sub": "subject",
            "email": "user@example.com",
            "email_verified": True,
            "name": "User",
        }

        user = auth.verify_google_credential("credential")

        self.assertEqual(user["email"], "user@example.com")
        self.assertEqual(
            verify_token.call_args.kwargs["clock_skew_in_seconds"],
            auth.GOOGLE_TOKEN_CLOCK_SKEW_SECONDS,
        )

    @patch("google.oauth2.id_token.verify_oauth2_token")
    @patch.object(auth, "google_oauth_client_id", return_value="client-id")
    def test_audience_mismatch_returns_actionable_message(
        self,
        _client_id,
        verify_token,
    ) -> None:
        verify_token.side_effect = InvalidValue("Token has wrong audience")

        with self.assertRaises(HTTPException) as context:
            auth.verify_google_credential("credential")

        self.assertEqual(context.exception.status_code, 401)
        self.assertIn("クライアントID", str(context.exception.detail))

    @patch("google.oauth2.id_token.verify_oauth2_token")
    @patch.object(auth, "google_oauth_client_id", return_value="client-id")
    def test_certificate_transport_failure_is_service_unavailable(
        self,
        _client_id,
        verify_token,
    ) -> None:
        verify_token.side_effect = TransportError("certificate endpoint unavailable")

        with self.assertRaises(HTTPException) as context:
            auth.verify_google_credential("credential")

        self.assertEqual(context.exception.status_code, 503)

    @patch("google.oauth2.id_token.verify_oauth2_token")
    @patch.object(auth, "google_oauth_client_id", return_value="client-id")
    def test_unverified_email_is_rejected(self, _client_id, verify_token) -> None:
        """未確認のメールで照合すると、他人のアドレスを名乗るアカウントが通る。"""
        for claims in (
            {"sub": "subject", "email": "user@example.com", "email_verified": False},
            {"sub": "subject", "email": "user@example.com"},
        ):
            verify_token.return_value = claims
            with self.assertRaises(HTTPException) as context:
                auth.verify_google_credential("credential")
            self.assertEqual(context.exception.status_code, 401)

    @patch.object(auth, "update_user_master_entry")
    @patch.object(auth, "_find_user_by_email")
    @patch.object(auth, "_find_user_by_subject", return_value=None)
    @patch.object(auth, "verify_google_credential")
    def test_registered_subject_must_match(
        self,
        verify_credential,
        _find_by_subject,
        find_by_email,
        update_user,
    ) -> None:
        """Googleアカウントに結びついた利用者を、同じメールの別アカウントから使わせない。"""
        verify_credential.return_value = {**FIRST_GOOGLE_USER, "google_subject": "other"}
        find_by_email.return_value = {"email": "admin@example.com", "google_subject": "subject"}

        with self.assertRaises(HTTPException) as context:
            auth.authenticate_google_credential("credential")

        self.assertEqual(context.exception.status_code, 403)
        update_user.assert_not_called()


if __name__ == "__main__":
    unittest.main()
