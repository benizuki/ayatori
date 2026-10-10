"""業務振り返り（daily_reflection）は廃止した。保存済みデータの保護と、新規受付の拒否だけを確かめる。"""

import unittest
from types import SimpleNamespace

from fastapi import HTTPException

from backend.app.api.interviews_api import _ensure_reflection_owner, _reject_retired_reflection_mode
from backend.app.schemas import InterviewSessionState


class RetiredDailyReflectionTest(unittest.TestCase):
    def test_new_reflection_sessions_are_rejected(self) -> None:
        with self.assertRaises(HTTPException) as error:
            _reject_retired_reflection_mode({"analysis_mode": "daily_reflection"})
        self.assertEqual(error.exception.status_code, 410)
        _reject_retired_reflection_mode({"analysis_mode": "discovery"})
        _reject_retired_reflection_mode(None)

    def test_saved_reflection_transcript_stays_visible_only_to_owner(self) -> None:
        state = InterviewSessionState(
            session_id="reflection-1",
            department="経理・財務",
            participant="佐藤",
            analysis_mode="daily_reflection",
            owner_email="sato@example.com",
        )
        owner_request = SimpleNamespace(state=SimpleNamespace(user={"email": "sato@example.com"}))
        _ensure_reflection_owner(state, owner_request)  # type: ignore[arg-type]
        other_request = SimpleNamespace(state=SimpleNamespace(user={"email": "manager@example.com"}))
        with self.assertRaises(HTTPException) as error:
            _ensure_reflection_owner(state, other_request)  # type: ignore[arg-type]
        self.assertEqual(error.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
