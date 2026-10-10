import unittest

from backend.app.api.interviews_api import _enforce_interview_transition, _update_session_state
from backend.app.schemas import InterviewDecision, InterviewSessionState


def _state(phase: str, **overrides) -> InterviewSessionState:
    defaults = dict(
        session_id="s-1",
        department="IT・情報システム",
        participant="鈴木",
        phase=phase,
        missing_items=["工程ごとの実行担当", "件数・時間・待ち時間"],
    )
    defaults.update(overrides)
    return InterviewSessionState(**defaults)


def _decision(phase: str, **overrides) -> InterviewDecision:
    defaults = dict(
        reply="ありがとうございます。この申請はどんな連絡が来たら始まりますか？",
        next_stage=1,
        fragment_action="none",
        phase=phase,
        completion_score=40,
        process_end_confirmed=True,
    )
    defaults.update(overrides)
    return InterviewDecision(**defaults)


class EnforceInterviewTransitionTest(unittest.TestCase):
    def test_end_confirmation_does_not_force_gap_review_before_coverage(self) -> None:
        state = _state("基本フロー")
        decision = _decision("補足確認", gap_review_status="確認中")
        _enforce_interview_transition(state, decision)
        self.assertEqual(decision.phase, "基本フロー")
        self.assertEqual(decision.gap_review_status, "未開始")
        self.assertNotIn("補足", decision.reply)
        self.assertNotIn("残り", decision.reply)

    def test_milestone_phase_is_kept_while_end_already_confirmed(self) -> None:
        state = _state("役割・引き継ぎ", process_end_confirmed=True)
        decision = _decision("システム・データ")
        _enforce_interview_transition(state, decision)
        self.assertEqual(decision.phase, "システム・データ")

    def test_gap_review_banner_has_no_item_count(self) -> None:
        state = _state("差異・課題", process_end_confirmed=True)
        decision = _decision("要約確認", gap_review_status="確認中")
        _enforce_interview_transition(state, decision)
        self.assertEqual(decision.phase, "補足確認")
        self.assertIn("補足", decision.reply[:80])
        self.assertNotIn("残り", decision.reply)
        self.assertFalse(any(char.isdigit() for char in decision.reply.split("。")[0]))

    def test_banner_is_not_duplicated_when_reply_already_announces(self) -> None:
        state = _state("差異・課題", process_end_confirmed=True)
        reply = "一連の流れを確認できました。ここからいくつか補足で伺います。月の件数はどのくらいですか？"
        decision = _decision("補足確認", gap_review_status="確認中", reply=reply)
        _enforce_interview_transition(state, decision)
        self.assertEqual(decision.reply, reply)

    def test_no_banner_on_subsequent_gap_review_turns(self) -> None:
        state = _state("補足確認", process_end_confirmed=True, gap_review_status="確認中")
        decision = _decision("補足確認", gap_review_status="確認中")
        original_reply = decision.reply
        _enforce_interview_transition(state, decision)
        self.assertEqual(decision.reply, original_reply)

    def test_refinement_mode_allows_early_gap_review(self) -> None:
        state = _state("スコープ・目的")
        decision = _decision("補足確認", gap_review_status="確認中")
        _enforce_interview_transition(state, decision, analysis_mode="refinement")
        self.assertEqual(decision.phase, "補足確認")

    def test_empty_ledger_moves_to_summary_confirmation(self) -> None:
        state = _state("補足確認", process_end_confirmed=True, gap_review_status="確認中", missing_items=[])
        decision = _decision("補足確認", gap_review_status="確認中", missing_items=[], resolved_items=[])
        _enforce_interview_transition(state, decision)
        self.assertEqual(decision.phase, "要約確認")
        self.assertEqual(decision.gap_review_status, "完了")


class UpdateSessionStateTest(unittest.TestCase):
    def test_state_phase_follows_milestone_after_end_confirmed(self) -> None:
        state = _state("役割・引き継ぎ")
        decision = _decision("システム・データ")
        _enforce_interview_transition(state, decision)
        _update_session_state(state, decision, "台帳に記入します")
        self.assertEqual(state.phase, "システム・データ")
        self.assertEqual(state.gap_review_status, "未開始")
        self.assertTrue(state.process_end_confirmed)

    def test_state_enters_gap_review_only_after_coverage(self) -> None:
        state = _state("差異・課題", process_end_confirmed=True)
        decision = _decision("補足確認", gap_review_status="確認中")
        _enforce_interview_transition(state, decision)
        _update_session_state(state, decision, "特にないです")
        self.assertEqual(state.phase, "補足確認")
        self.assertEqual(state.gap_review_status, "確認中")


if __name__ == "__main__":
    unittest.main()
