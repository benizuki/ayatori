from __future__ import annotations

import os
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

from backend.app import runtime
from backend.app.schemas import InterviewSessionState
from backend.tests.test_request_authorization import build_client


class InterviewSummaryCreatedAtTest(unittest.TestCase):
    """ヒアリング一覧の要約は、作成日時もサーバの記録から返す（画面側に保存しない）。"""

    def test_summary_returns_created_at_and_falls_back_to_updated_at(self) -> None:
        with TemporaryDirectory() as directory, patch.dict(os.environ, {"AYATORI_API_HOST": "127.0.0.1"}, clear=True):
            client = build_client(self, directory)
            states = {
                "default::new": InterviewSessionState(
                    session_id="new", department="経理", participant="佐藤", created_at="2026-10-01T00:00:00+00:00"
                ),
                "default::old": InterviewSessionState(session_id="old", department="経理", participant="鈴木"),
            }
            updated = {"default::new": "2026-10-02T00:00:00+00:00", "default::old": "2026-09-01T00:00:00+00:00"}
            with (
                patch.dict(runtime.interview_sessions, states, clear=True),
                patch.dict(runtime.interview_histories, {}, clear=True),
                patch.dict(runtime.interview_updated_at, updated, clear=True),
            ):
                rows = {row["session_id"]: row for row in client.get("/api/interviews").json()}

        self.assertEqual(rows["new"]["created_at"], "2026-10-01T00:00:00+00:00")
        # 作成日時を持たない古い記録は、更新日時で代用する。
        self.assertEqual(rows["old"]["created_at"], "2026-09-01T00:00:00+00:00")


if __name__ == "__main__":
    unittest.main()
