from __future__ import annotations

import unittest

from pydantic import ValidationError

from backend.app.schemas import (
    InterviewMessage,
    InterviewRequest,
    InterviewSessionRecord,
    InterviewSessionState,
    InterviewSessionSummaryRecord,
    StartInterviewRequest,
)
from backend.app.storage.session_store import discard_blank_interview_sessions


class InterviewSessionValidationTest(unittest.TestCase):
    def test_start_rejects_a_blank_session_id(self) -> None:
        with self.assertRaises(ValidationError):
            StartInterviewRequest(session_id="", department="経理", participant="担当者")

    def test_response_turn_rejects_a_blank_session_id(self) -> None:
        with self.assertRaises(ValidationError):
            InterviewRequest(
                session_id=" ",
                department="経理",
                participant="担当者",
                stage=0,
                messages=[InterviewMessage(role="user", text="回答")],
            )

    def test_blank_legacy_records_are_discarded(self) -> None:
        blank = InterviewSessionRecord(
            session_state=InterviewSessionState(
                session_id="",
                department="経理",
                participant="担当者",
            )
        )
        valid = InterviewSessionRecord(
            session_state=InterviewSessionState(
                session_id="interview-1",
                department="経理",
                participant="担当者",
            )
        )

        cleaned, discarded = discard_blank_interview_sessions({"": blank, "interview-1": valid})

        self.assertEqual(cleaned, {"interview-1": valid})
        self.assertEqual(discarded, [""])

    def test_summary_exposes_the_source_process_for_refinement_grouping(self) -> None:
        summary = InterviewSessionSummaryRecord(
            session_id="interview-refine-1",
            department="経理",
            participant="担当者",
            phase="差異・課題",
            completion_score=60,
            message_count=4,
            analysis_mode="refinement",
            source_process_id="ap-invoice",
        )

        self.assertEqual(summary.source_process_id, "ap-invoice")


if __name__ == "__main__":
    unittest.main()
