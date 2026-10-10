from __future__ import annotations

import unittest
from unittest.mock import patch

from backend.app.services import llm_interview
from backend.app.schemas import ProcessDraftDecision, ProcessDraftRequest


def fragment(
    fragment_id: str,
    actor: str,
    *,
    next_actor: str = "未確認",
    next_step: str = "次工程",
) -> dict:
    return {
        "id": fragment_id,
        "title": f"{fragment_id}を行う",
        "description": "ヒアリングで確認した作業",
        "actor": actor,
        "trigger": "前工程の完了",
        "tools": [],
        "output": "処理結果",
        "next_step": next_step,
        "next_actor": next_actor,
        "personalization": "低",
        "confidence": 90,
        "source_quote": "担当を明示した発言",
    }


def decision(nodes: list[dict], lanes: list[str]) -> ProcessDraftDecision:
    return ProcessDraftDecision.model_validate(
        {
            "title": "テスト As-Is",
            "lanes": lanes,
            "nodes": nodes,
            "flows": [],
        }
    )


class ProcessDraftLaneGroundingTest(unittest.TestCase):
    def test_normalizes_common_gemini_process_draft_aliases(self) -> None:
        normalized = llm_interview._normalize_process_draft(
            {
                "processTitle": "端末接続申請",
                "overview": "申請を確認して端末を登録する業務",
                "startCondition": "申請通知メールを受信",
                "endCondition": "接続確認を依頼",
                "swimlanes": ["IT担当"],
                "steps": [
                    {
                        "id": "step-1",
                        "name": "申請内容を確認する",
                        "nodeType": "task",
                        "role": "IT担当",
                        "sequence": "1",
                        "confidenceScore": "92%",
                        "needsReview": "false",
                    },
                    {
                        "id": "step-2",
                        "name": "登録する",
                        "nodeType": "task",
                        "role": "IT担当",
                        "sequence": "2",
                    },
                ],
                "connections": [{"source_node": {"id": "step-1"}, "target_node": {"id": "step-2"}, "condition": "完了"}],
                "operational_assets": [{"id": "asset-1", "asset_name": "端末管理システム", "asset_type": "system"}],
            }
        )

        self.assertEqual(normalized["title"], "端末接続申請")
        self.assertEqual(normalized["nodes"][0]["key"], "step-1")
        self.assertEqual(normalized["nodes"][0]["confidence"], 92)
        self.assertFalse(normalized["nodes"][0]["needs_review"])
        self.assertEqual(normalized["flows"][0]["from_key"], "step-1")
        self.assertEqual(normalized["flows"][0]["to_key"], "step-2")
        self.assertEqual(normalized["assets"][0]["type"], "業務システム")

    def test_normalizes_task_information_and_resolves_asset_references(self) -> None:
        """工程の入力・出力の情報は、アセットの名前で指定されてもkeyに読み替え、項目は名前だけにする。"""
        normalized = llm_interview._normalize_process_draft(
            {
                "title": "請求書処理",
                "nodes": [
                    {"key": "start", "label": "開始", "type": "start", "inputs": ["無視される"]},
                    {
                        "key": "register",
                        "label": "請求書を登録",
                        "type": "task",
                        "inputs": [{"name": "請求書", "assets": ["メール", "紙"], "items": [{"name": "請求番号"}, "金額"]}],
                        "outputs": ["請求書データ"],
                    },
                ],
                "flows": [{"from_key": "start", "to_key": "register"}],
                "assets": [
                    {"key": "asset-mail", "name": "メール", "type": "メール"},
                    {"key": "asset-paper", "name": "紙", "type": "紙帳票"},
                ],
            }
        )
        start, register = normalized["nodes"]
        self.assertNotIn("inputs", start)
        self.assertEqual(register["inputs"], [{"name": "請求書", "asset_keys": ["asset-mail", "asset-paper"], "items": ["請求番号", "金額"]}])
        self.assertEqual(register["outputs"], [{"name": "請求書データ", "asset_keys": [], "items": []}])
        decision = ProcessDraftDecision.model_validate(normalized)
        self.assertEqual(decision.nodes[1].inputs[0].asset_keys, ["asset-mail", "asset-paper"])

    def test_rebuilds_sequential_flows_when_gemini_omits_connections(self) -> None:
        normalized = llm_interview._normalize_process_draft(
            {
                "nodes": [
                    {"key": "start", "label": "開始", "type": "start", "order": 1},
                    {"key": "task-1", "label": "確認する", "type": "task", "order": 2},
                    {"key": "end", "label": "終了", "type": "end", "order": 3},
                ],
                "flows": [],
            }
        )

        self.assertEqual(
            [(flow["from_key"], flow["to_key"]) for flow in normalized["flows"]],
            [("start", "task-1"), ("task-1", "end")],
        )
        self.assertTrue(any("仮接続" in item for item in normalized["review_items"]))

    def test_classifies_chat_messages_separately_from_workflow_saas(self) -> None:
        normalized = llm_interview._normalize_process_draft(
            {
                "assets": [
                    {"key": "chat", "name": "チャット", "type": "SaaS"},
                    {"key": "teams", "name": "Microsoft Teams", "type": "SaaS"},
                    {"key": "workflow", "name": "Rakumo WF", "type": "SaaS"},
                ],
            }
        )

        self.assertEqual(
            [asset["type"] for asset in normalized["assets"]],
            ["チャット", "チャット", "SaaS"],
        )

    def test_preserves_data_items_for_each_asset_step_link(self) -> None:
        normalized = llm_interview._normalize_process_draft(
            {
                "nodes": [{"key": "approve", "label": "申請を承認", "type": "task", "actor": "承認者"}],
                "assets": [{"key": "ledger", "name": "申請台帳", "type": "Excel・台帳"}],
                "asset_links": [{
                    "asset_key": "ledger",
                    "node_key": "approve",
                    "relation": "更新",
                    "data_items": "申請番号、承認者、承認日時、承認状態",
                }],
            }
        )

        self.assertEqual(
            normalized["asset_links"][0]["data_description"],
            "申請番号、承認者、承認日時、承認状態",
        )

    def test_fragment_without_next_actor_remains_backward_compatible(self) -> None:
        legacy_fragment = fragment("step-1", "経理担当")
        legacy_fragment.pop("next_actor")
        request = ProcessDraftRequest.model_validate(
            {
                "session_id": "session-1",
                "department": "経理",
                "participant": "担当者",
                "fragments": [legacy_fragment],
            }
        )

        self.assertEqual(request.fragments[0].next_actor, "未確認")

    def test_distinct_fragment_actors_repair_flattened_generated_lanes(self) -> None:
        request = ProcessDraftRequest.model_validate(
            {
                "session_id": "session-1",
                "department": "経理",
                "participant": "担当者",
                "fragments": [
                    fragment("step-1", "経理担当"),
                    fragment("step-2", "部門承認者"),
                ],
            }
        )
        generated = decision(
            [
                {
                    "key": "node-1",
                    "label": "申請する",
                    "type": "task",
                    "actor": "経理担当",
                    "order": 1,
                    "source_fragment_ids": ["step-1"],
                },
                {
                    "key": "node-2",
                    "label": "承認する",
                    "type": "task",
                    "actor": "経理担当",
                    "order": 2,
                    "source_fragment_ids": ["step-2"],
                },
            ],
            ["経理担当"],
        )

        with patch.object(llm_interview, "_generate_model_response", return_value=generated):
            result = llm_interview.generate_process_draft(request)

        self.assertEqual([node.actor for node in result.nodes], ["経理担当", "部門承認者"])
        self.assertEqual(result.lanes, ["経理担当", "部門承認者"])
        self.assertTrue(result.nodes[1].needs_review)

    def test_explicit_next_actor_can_become_a_separate_lane(self) -> None:
        request = ProcessDraftRequest.model_validate(
            {
                "session_id": "session-1",
                "department": "経理",
                "participant": "担当者",
                "fragments": [
                    fragment("step-1", "経理担当", next_actor="申請部門", next_step="内容を回答する"),
                ],
            }
        )
        generated = decision(
            [
                {
                    "key": "node-1",
                    "label": "問い合わせる",
                    "type": "task",
                    "actor": "経理担当",
                    "order": 1,
                    "source_fragment_ids": ["step-1"],
                },
                {
                    "key": "node-2",
                    "label": "内容を回答する",
                    "type": "task",
                    "actor": "申請部門",
                    "order": 2,
                    "source_fragment_ids": ["step-1"],
                },
            ],
            ["経理担当", "申請部門"],
        )

        with patch.object(llm_interview, "_generate_model_response", return_value=generated):
            result = llm_interview.generate_process_draft(request)

        self.assertEqual(result.lanes, ["経理担当", "申請部門"])

    def test_explicit_time_and_volume_are_preserved_on_draft_node(self) -> None:
        source_fragment = fragment("step-1", "経理担当")
        source_fragment["standard_time"] = "15分/件"
        source_fragment["processing_volume"] = "1日50件"
        request = ProcessDraftRequest.model_validate(
            {
                "session_id": "session-1",
                "department": "経理",
                "participant": "担当者",
                "fragments": [source_fragment],
            }
        )
        draft = decision(
            [
                {
                    "key": "node-1",
                    "label": "処理する",
                    "type": "task",
                    "actor": "経理担当",
                    "order": 1,
                    "duration": "未確認",
                    "monthly_volume": "未確認",
                    "source_fragment_ids": ["step-1"],
                }
            ],
            ["経理担当"],
        )

        result = llm_interview._ground_process_draft_lanes(request, draft)

        self.assertEqual(result.nodes[0].duration, "15分/件")
        self.assertEqual(result.nodes[0].monthly_volume, "1日50件")

    def test_draft_instruction_requires_actor_and_handoff_analysis(self) -> None:
        self.assertIn("actorとnext_actorを照合", llm_interview.PROCESS_DRAFT_SYSTEM_INSTRUCTION)
        self.assertIn("システム自動処理", llm_interview.PROCESS_DRAFT_SYSTEM_INSTRUCTION)
        self.assertIn("最初の作業断片のactorを全ノードへ流用しない", llm_interview.PROCESS_DRAFT_SYSTEM_INSTRUCTION)

    def test_draft_instruction_merges_initial_and_refinement_evidence(self) -> None:
        self.assertIn("初回・追加ヒアリング根拠を統合", llm_interview.PROCESS_DRAFT_SYSTEM_INSTRUCTION)
        self.assertIn("利用者が確認・手修正した現在の正本", llm_interview.PROCESS_DRAFT_SYSTEM_INSTRUCTION)
        self.assertIn("そのstep.idをnode.keyとして再利用", llm_interview.PROCESS_DRAFT_SYSTEM_INSTRUCTION)
        self.assertIn("既存As-Isとして維持", llm_interview.PROCESS_DRAFT_SYSTEM_INSTRUCTION)


if __name__ == "__main__":
    unittest.main()


class SystemLaneAmbiguityTest(unittest.TestCase):
    def test_flags_system_lane_without_fragment_actor_evidence(self) -> None:
        request = ProcessDraftRequest.model_validate(
            {
                "session_id": "session-1",
                "department": "IT",
                "participant": "鈴木",
                "fragments": [fragment("step-1", "IT担当")],
            }
        )
        draft = ProcessDraftDecision.model_validate(
            {
                "title": "端末接続申請",
                "lanes": ["IT担当", "ワークフローシステム"],
                "nodes": [
                    {"key": "n1", "label": "申請内容を確認する", "type": "task", "actor": "IT担当", "order": 1, "source_fragment_ids": ["step-1"]},
                    {"key": "n2", "label": "申請を差し戻す", "type": "task", "actor": "ワークフローシステム", "order": 2},
                ],
                "flows": [{"from_key": "n1", "to_key": "n2", "label": ""}],
                "assets": [{"key": "a1", "name": "ワークフローシステム", "type": "SaaS"}],
            }
        )

        result = llm_interview._ground_process_draft_lanes(request, draft)

        self.assertTrue(any("レーンとアセットの両方" in item for item in result.review_items))

    def test_system_lane_backed_by_fragment_actor_is_not_flagged(self) -> None:
        request = ProcessDraftRequest.model_validate(
            {
                "session_id": "session-1",
                "department": "IT",
                "participant": "鈴木",
                "fragments": [
                    fragment("step-1", "IT担当", next_actor="ワークフローシステム"),
                    fragment("step-2", "ワークフローシステム"),
                ],
            }
        )
        draft = ProcessDraftDecision.model_validate(
            {
                "title": "端末接続申請",
                "lanes": ["IT担当", "ワークフローシステム"],
                "nodes": [
                    {"key": "n1", "label": "申請内容を確認する", "type": "task", "actor": "IT担当", "order": 1, "source_fragment_ids": ["step-1"]},
                    {"key": "n2", "label": "申請者へ自動通知する", "type": "task", "actor": "ワークフローシステム", "order": 2, "source_fragment_ids": ["step-2"]},
                ],
                "flows": [{"from_key": "n1", "to_key": "n2", "label": ""}],
                "assets": [{"key": "a1", "name": "ワークフローシステム", "type": "SaaS"}],
            }
        )

        result = llm_interview._ground_process_draft_lanes(request, draft)

        self.assertFalse(any("レーンとアセットの両方" in item for item in result.review_items))
