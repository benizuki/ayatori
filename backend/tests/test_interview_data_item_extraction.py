from __future__ import annotations

import unittest

from pydantic import ValidationError
from unittest.mock import patch

from backend.app.services import gemini, llm_interview
from backend.app.schemas import (
    BusinessDocumentExtractionDecision,
    InterviewAttachment,
    InterviewDecision,
    InterviewMessage,
    InterviewRequest,
    InterviewSessionState,
    WorkFragmentContext,
)


class InterviewDataItemExtractionTest(unittest.TestCase):
    def test_gemini_document_values_are_normalized_before_validation(self) -> None:
        raw = {
            "document_kind": "その他",
            "fragments": [
                {
                    "title": "申請内容を確認する",
                    "description": "申請書の記載内容を確認する",
                    "actor": "担当者",
                    "trigger": "申請書を受領する",
                    "output": "確認済み申請書",
                    "next_step": "承認する",
                    "personalization": "低",
                    "source_document": "application.pdf",
                    "confidence": 0.875,
                    "data_items": [
                        {
                            "name": "申請番号",
                            "confidence": 82.5,
                        },
                        "申請日",
                        "   ",
                    ],
                }
            ],
        }

        normalized = gemini._normalize_generated_values(raw)
        decision = BusinessDocumentExtractionDecision.model_validate(normalized)

        self.assertEqual(decision.fragments[0].confidence, 88)
        self.assertEqual(decision.fragments[0].data_items[0].confidence, 83)
        self.assertEqual(
            [item.name for item in decision.fragments[0].data_items],
            ["申請番号", "申請日"],
        )
        self.assertEqual(decision.fragments[0].data_items[1].source_document, "application.pdf")

    def test_work_fragment_accepts_structured_document_fields(self) -> None:
        fragment = WorkFragmentContext.model_validate(
            {
                "title": "請求書を確認する",
                "description": "添付された請求書を確認する",
                "actor": "買掛金担当",
                "trigger": "請求書を受領",
                "tools": ["請求書PDF"],
                "output": "確認済み請求書",
                "next_step": "SAPへ登録する",
                "next_actor": "買掛金担当",
                "data_items": [
                    {
                        "name": "請求書番号",
                        "description": "請求書を識別する番号",
                        "data_type": "識別子",
                        "source_document": "invoice.pdf",
                        "confidence": 96,
                    },
                    {
                        "name": "請求金額",
                        "description": "請求書の合計金額欄",
                        "data_type": "金額",
                        "source_document": "invoice.pdf",
                        "confidence": 94,
                    },
                ],
                "personalization": "低",
                "confidence": 92,
            }
        )

        self.assertEqual([item.name for item in fragment.data_items], ["請求書番号", "請求金額"])
        self.assertEqual(fragment.data_items[0].source_document, "invoice.pdf")

    def test_legacy_work_fragment_defaults_to_no_data_items(self) -> None:
        fragment = WorkFragmentContext.model_validate(
            {
                "title": "申請する",
                "description": "申請を送信する",
                "actor": "申請者",
                "trigger": "申請が必要になる",
                "output": "申請",
                "next_step": "承認する",
                "personalization": "低",
                "confidence": 80,
            }
        )

        self.assertEqual(fragment.data_items, [])

    def test_unknown_data_type_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            WorkFragmentContext.model_validate(
                {
                    "title": "帳票を確認する",
                    "description": "帳票を確認する",
                    "actor": "担当者",
                    "trigger": "帳票を受領",
                    "output": "確認結果",
                    "next_step": "登録する",
                    "data_items": [
                        {
                            "name": "申請番号",
                            "data_type": "バーコード",
                            "source_document": "form.png",
                        }
                    ],
                    "personalization": "低",
                    "confidence": 80,
                }
            )

    def test_interview_instruction_excludes_values_and_persists_fields(self) -> None:
        instruction = llm_interview.SYSTEM_INSTRUCTION

        self.assertIn("入力欄・項目ラベル・表の列見出し", instruction)
        self.assertIn("実データ値は保存しない", instruction)
        self.assertIn("fragmentへdata_itemsを必ず保存", instruction)
        self.assertIn("source_document", instruction)

    def test_flow_diagram_can_return_all_readable_steps_in_one_decision(self) -> None:
        common = {
            "description": "図から読み取った工程",
            "trigger": "未確認",
            "output": "未確認",
            "personalization": "低",
            "confidence": 85,
        }
        decision = InterviewDecision.model_validate(
            {
                "reply": "図の流れを取り込みました。実際の運用もこの流れで合っていますか？",
                "next_stage": 1,
                "fragment_action": "none",
                "fragment": None,
                "extracted_fragments": [
                    {
                        **common,
                        "title": "申請内容を確認する",
                        "actor": "申請受付担当",
                        "tools": ["申請システム"],
                        "next_step": "承認する",
                        "next_actor": "部門長",
                    },
                    {
                        **common,
                        "title": "承認する",
                        "actor": "部門長",
                        "tools": ["申請システム"],
                        "next_step": "未確認",
                        "next_actor": "未確認",
                    },
                ],
                "phase": "基本フロー",
                "completion_score": 30,
            }
        )

        self.assertEqual(
            [(fragment.actor, fragment.title, fragment.next_actor) for fragment in decision.extracted_fragments],
            [("申請受付担当", "申請内容を確認する", "部門長"), ("部門長", "承認する", "未確認")],
        )

    def test_interview_instruction_requires_full_flow_extraction(self) -> None:
        instruction = llm_interview.SYSTEM_INSTRUCTION

        self.assertIn("図全体を最初から最後まで走査", instruction)
        self.assertIn("extracted_fragments", instruction)
        self.assertIn("next_stepとnext_actor", instruction)

    def test_dedicated_document_result_is_persisted_without_general_llm_reextracting(self) -> None:
        source = InterviewAttachment(
            name="業務一覧.pdf",
            mime_type="application/pdf",
            data="JVBERg==",
        )
        extracted = BusinessDocumentExtractionDecision.model_validate(
            {
                "document_kind": "業務リスト",
                "summary": "12件の業務一覧",
                "actors": ["経理担当"],
                "systems": ["SAP"],
                "fragments": [
                    {
                        "title": f"業務{i + 1}を処理する",
                        "description": "一覧表から抽出",
                        "actor": "経理担当",
                        "trigger": "前工程の完了",
                        "tools": ["SAP"],
                        "output": "処理結果",
                        "next_step": f"業務{i + 2}を処理する" if i < 11 else "未確認",
                        "next_actor": "経理担当" if i < 11 else "未確認",
                        "standard_time": f"{i + 1}分/件",
                        "processing_volume": f"月{i + 1}00件",
                        "source_document": "業務一覧.pdf",
                        "source_reference": f"p.1 行{i + 2}",
                        "personalization": "低",
                        "confidence": 90,
                    }
                    for i in range(12)
                ],
            }
        )
        generated = InterviewDecision.model_validate(
            {
                "reply": "一覧を読み取りました。現在もこの流れですか？",
                "next_stage": 1,
                "fragment_action": "none",
                "phase": "基本フロー",
                "completion_score": 25,
            }
        )
        request = InterviewRequest(
            session_id="session-1",
            department="経理",
            participant="担当者",
            stage=0,
            messages=[InterviewMessage(role="user", text="添付を確認してください")],
            attachments=[source],
        )
        state = InterviewSessionState(
            session_id="session-1",
            department="経理",
            participant="担当者",
        )

        with patch.object(llm_interview, "extract_business_documents", return_value=extracted) as extract, patch.object(
            llm_interview,
            "_generate_structured_response",
            return_value=generated,
        ) as respond:
            decision = llm_interview.generate_interview_response(request, state)

        extract.assert_called_once_with([source])
        self.assertIsNone(respond.call_args.args[1])
        self.assertEqual(len(decision.extracted_fragments), 12)
        self.assertEqual(decision.extracted_fragments[9].standard_time, "10分/件")
        self.assertEqual(decision.extracted_fragments[9].processing_volume, "月1000件")

    def test_business_document_extractor_uses_dedicated_instruction(self) -> None:
        source = InterviewAttachment(
            name="flow.png",
            mime_type="image/png",
            data="aW1hZ2U=",
        )
        expected = BusinessDocumentExtractionDecision(document_kind="業務フロー図")

        with patch.object(llm_interview, "_generate_model_response", return_value=expected) as generate:
            result = llm_interview.extract_business_documents([source])

        self.assertEqual(result, expected)
        prompt, schema, instruction, attachments = generate.call_args.args
        self.assertIn("専用の業務文書解析", prompt)
        self.assertIs(schema, BusinessDocumentExtractionDecision)
        self.assertIn("代表的な3件だけに要約しない", instruction)
        self.assertIn("左から右を既定の順序にせず", instruction)
        self.assertIn("複数列を右から左へ読む", instruction)
        self.assertIn("detected_task_count", instruction)
        self.assertIn("standard_time", instruction)
        self.assertIn('"data_items":[{"name":"入力欄・列見出し"', instruction)
        self.assertEqual(attachments, [source])
        self.assertEqual(
            generate.call_args.kwargs["thinking_level_override"],
            "HIGH",
        )
        self.assertEqual(
            generate.call_args.kwargs["media_resolution_override"],
            "MEDIA_RESOLUTION_HIGH",
        )
        self.assertEqual(
            generate.call_args.kwargs["request_timeout_ms_override"],
            300_000,
        )
        self.assertTrue(generate.call_args.kwargs["attachments_first"])

    def test_vertical_document_metadata_and_missing_task_warning_are_preserved(self) -> None:
        source = InterviewAttachment(
            name="vertical-flow.png",
            mime_type="image/png",
            data="aW1hZ2U=",
        )
        extracted = BusinessDocumentExtractionDecision.model_validate(
            {
                "document_kind": "業務フロー図",
                "layout_direction": "縦方向",
                "writing_direction": "縦書き",
                "detected_task_count": 10,
                "fragments": [
                    {
                        "title": f"作業{i + 1}を行う",
                        "description": "縦方向の工程",
                        "actor": "担当者",
                        "trigger": "前工程の完了",
                        "output": "処理結果",
                        "next_step": "未確認",
                        "personalization": "低",
                        "confidence": 80,
                    }
                    for i in range(8)
                ],
            }
        )

        with patch.object(llm_interview, "_generate_model_response", return_value=extracted):
            result = llm_interview.extract_business_documents([source])

        self.assertEqual(result.layout_direction, "縦方向")
        self.assertEqual(result.writing_direction, "縦書き")
        self.assertTrue(any("10件" in warning and "8件" in warning for warning in result.warnings))

    def test_document_task_count_over_100_is_preserved(self) -> None:
        source = InterviewAttachment(
            name="dense-flow.pdf",
            mime_type="application/pdf",
            data="aW1hZ2U=",
        )
        extracted = BusinessDocumentExtractionDecision.model_validate(
            {
                "document_kind": "業務フロー図",
                "detected_task_count": 137,
                "fragments": [],
            }
        )

        with patch.object(llm_interview, "_generate_model_response", return_value=extracted):
            result = llm_interview.extract_business_documents([source])

        self.assertEqual(result.detected_task_count, 137)
        self.assertTrue(any("137件" in warning and "0件" in warning for warning in result.warnings))

    def test_interview_and_document_use_different_thinking_levels(self) -> None:
        generated = InterviewDecision.model_validate(
            {
                "reply": "次の作業を教えてください。",
                "next_stage": 1,
                "fragment_action": "none",
                "phase": "基本フロー",
                "completion_score": 20,
            }
        )

        with patch.object(llm_interview, "_generate_model_response", return_value=generated) as generate:
            llm_interview._generate_structured_response("ヒアリング")

        self.assertEqual(
            generate.call_args.kwargs["thinking_level_override"],
            "LOW",
        )

    def test_invalid_thinking_level_is_rejected_before_request(self) -> None:
        from google.genai import types

        with self.assertRaisesRegex(gemini.GeminiError, "MINIMAL、LOW、MEDIUM、HIGH"):
            gemini._build_generate_content_config(
                types,
                "instruction",
                "VERY_HIGH",
            )

    def test_thinking_level_is_added_to_generation_config(self) -> None:
        from google.genai import types

        config = gemini._build_generate_content_config(
            types,
            "instruction",
            "high",
        )

        self.assertEqual(config.thinking_config.thinking_level.value, "HIGH")
        self.assertFalse(config.thinking_config.include_thoughts)

    def test_document_generation_config_uses_high_media_resolution(self) -> None:
        from google.genai import types

        config = gemini._build_generate_content_config(
            types,
            "instruction",
            "HIGH",
            "MEDIA_RESOLUTION_HIGH",
        )

        self.assertEqual(config.media_resolution.value, "MEDIA_RESOLUTION_HIGH")

    def test_http_options_retry_deadline_exceeded(self) -> None:
        from google.genai import types

        options = gemini._build_http_options(types, 300_000)

        self.assertEqual(options.timeout, 300_000)
        self.assertEqual(options.retry_options.attempts, 3)
        self.assertIn(504, options.retry_options.http_status_codes)
        # Vertex AI は GA の v1 を明示し、Gemini API は SDK の既定に任せる。
        self.assertIsNone(options.api_version)
        self.assertEqual(gemini._build_http_options(types, 300_000, "v1").api_version, "v1")

    def test_process_draft_instruction_maps_fields_to_task_information(self) -> None:
        """項目は書類・データのまとまり（情報）が持ち、アセットは置き場所だけにする。"""
        instruction = llm_interview.PROCESS_DRAFT_SYSTEM_INSTRUCTION

        self.assertIn("nodes[].inputs", instruction)
        self.assertIn("情報のitemsへ項目名だけ", instruction)
        self.assertIn("assetsは情報の置き場所だけ", instruction)
        self.assertIn("同じ書類・データは、工程をまたいで同じ情報名", instruction)
        self.assertIn("実データ値や個人情報", instruction)


if __name__ == "__main__":
    unittest.main()
