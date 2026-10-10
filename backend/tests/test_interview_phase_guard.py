import unittest

from backend.app.schemas import (
    InterviewDecision,
    InterviewMessage,
    InterviewRequest,
    InterviewSessionState,
)
from backend.app.services import llm_interview


def _request(business_context: dict | None = None) -> InterviewRequest:
    return InterviewRequest(
        session_id="s-1",
        department="経理・財務",
        participant="佐藤",
        stage=1,
        messages=[InterviewMessage(role="user", text="請求書が届いたら台帳に記入します。")],
        business_context=business_context,
    )


def _state(phase: str, completion_score: int = 30) -> InterviewSessionState:
    return InterviewSessionState(
        session_id="s-1",
        department="経理・財務",
        participant="佐藤",
        phase=phase,
        completion_score=completion_score,
    )


def _decision(phase: str, completion_score: int = 40) -> InterviewDecision:
    return InterviewDecision(
        reply="ありがとうございます。次の作業を教えてください。",
        next_stage=1,
        fragment_action="none",
        phase=phase,
        completion_score=completion_score,
    )


class InterviewPhaseGuardTest(unittest.TestCase):
    def test_phase_regression_is_repaired(self) -> None:
        reason = llm_interview._find_phase_repair_reason(
            _request(), _state("システム・データ"), _decision("基本フロー")
        )
        self.assertIsNotNone(reason)
        self.assertIn("後退", reason)

    def test_completion_score_regression_is_repaired(self) -> None:
        reason = llm_interview._find_phase_repair_reason(
            _request(), _state("基本フロー", completion_score=50), _decision("基本フロー", completion_score=20)
        )
        self.assertIsNotNone(reason)
        self.assertIn("カバレッジ", reason)

    def test_leap_from_basic_flow_to_gap_review_is_repaired(self) -> None:
        reason = llm_interview._find_phase_repair_reason(
            _request(), _state("基本フロー"), _decision("補足確認")
        )
        self.assertIsNotNone(reason)
        self.assertIn("飛ばした", reason)

    def test_leap_skipping_only_issue_phase_is_repaired(self) -> None:
        reason = llm_interview._find_phase_repair_reason(
            _request(), _state("判断・例外"), _decision("補足確認")
        )
        self.assertIsNotNone(reason)

    def test_stepwise_advance_is_accepted(self) -> None:
        self.assertIsNone(
            llm_interview._find_phase_repair_reason(
                _request(), _state("基本フロー"), _decision("役割・引き継ぎ")
            )
        )

    def test_gap_review_after_issue_phase_is_accepted(self) -> None:
        self.assertIsNone(
            llm_interview._find_phase_repair_reason(
                _request(), _state("差異・課題"), _decision("補足確認")
            )
        )

    def test_refinement_mode_may_enter_gap_review_early(self) -> None:
        self.assertIsNone(
            llm_interview._find_phase_repair_reason(
                _request({"analysis_mode": "refinement"}),
                _state("スコープ・目的"),
                _decision("補足確認"),
            )
        )


if __name__ == "__main__":
    unittest.main()
