from __future__ import annotations

import base64
import unittest
from unittest.mock import patch

from pydantic import ValidationError

from backend.app.services import llm_interview
from backend.app.schemas import (
    AssetDocumentExtractionDecision,
    AssetDocumentExtractionRequest,
)


class AssetDocumentExtractionTest(unittest.TestCase):
    def test_extraction_sends_the_document_and_existing_asset_context(self) -> None:
        request = AssetDocumentExtractionRequest.model_validate(
            {
                "asset_name": "端末管理台帳",
                "existing_description": "端末名",
                "attachment": {
                    "name": "ledger.png",
                    "mime_type": "image/png",
                    "data": base64.b64encode(b"image").decode("ascii"),
                },
            }
        )
        expected = AssetDocumentExtractionDecision.model_validate(
            {
                "document_type": "端末管理台帳",
                "summary": "端末情報を管理する一覧表",
                "fields": [
                    {
                        "name": "利用者",
                        "description": "端末の利用者",
                        "data_type": "文字列",
                        "confidence": 92,
                    }
                ],
                "warnings": [],
            }
        )

        with patch.object(
            llm_interview,
            "_generate_model_response",
            return_value=expected,
        ) as generate:
            result = llm_interview.extract_asset_document_fields(request)

        self.assertEqual(result, expected)
        prompt, schema, instruction, attachments = generate.call_args.args
        self.assertIn("端末管理台帳", prompt)
        self.assertIn("端末名", prompt)
        self.assertEqual(schema.__name__, "_AssetDocumentExtractionGeneration")
        self.assertIn("実データは返さない", instruction)
        self.assertEqual(attachments, [request.attachment])

    def test_generation_schema_does_not_send_validation_constraints_to_vertex(self) -> None:
        schema = llm_interview._AssetDocumentExtractionGeneration.model_json_schema()
        serialized = str(schema)

        self.assertNotIn("maxLength", serialized)
        self.assertNotIn("minLength", serialized)
        self.assertNotIn("maxItems", serialized)
        self.assertNotIn("maximum", serialized)
        self.assertNotIn("minimum", serialized)

    def test_request_rejects_unsupported_file_types(self) -> None:
        with self.assertRaises(ValidationError):
            AssetDocumentExtractionRequest.model_validate(
                {
                    "attachment": {
                        "name": "ledger.csv",
                        "mime_type": "text/csv",
                        "data": "YQ==",
                    }
                }
            )

    def test_decision_rejects_unknown_data_type(self) -> None:
        with self.assertRaises(ValidationError):
            AssetDocumentExtractionDecision.model_validate(
                {
                    "fields": [
                        {
                            "name": "端末名",
                            "data_type": "オブジェクト",
                            "confidence": 80,
                        }
                    ]
                }
            )

    def test_normalizes_common_gemini_field_aliases(self) -> None:
        normalized = llm_interview._normalize_asset_document_extraction(
            {
                "documentType": "端末管理台帳",
                "overview": "端末の管理項目",
                "data_items": [
                    {
                        "fieldName": "端末番号",
                        "purpose": "端末を識別する番号",
                        "type": "identifier",
                        "confidenceScore": "92%",
                    }
                ],
            }
        )

        self.assertEqual(normalized["document_type"], "端末管理台帳")
        self.assertEqual(normalized["summary"], "端末の管理項目")
        self.assertEqual(normalized["fields"][0]["name"], "端末番号")
        self.assertEqual(normalized["fields"][0]["data_type"], "識別子")
        self.assertEqual(normalized["fields"][0]["confidence"], 92)


if __name__ == "__main__":
    unittest.main()
