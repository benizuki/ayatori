from __future__ import annotations

import io
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient
from backend.app import runtime
from backend.tests.support import patch_auth_enabled
from backend.app.api import middleware


class _WorkerStub:
    def __init__(self) -> None:
        self.notifications = 0

    def notify(self) -> None:
        self.notifications += 1


class BusinessFlowImportApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        from backend.app import main
        from backend.app.storage.sqlite_store import AyatoriSQLiteStore

        root = Path(self.directory.name)
        self.store = AyatoriSQLiteStore(root / "ayatori.sqlite")
        self.worker = _WorkerStub()
        patchers = (
            patch.object(runtime, "store", self.store),
            patch.object(runtime, "business_flow_import_worker", self.worker),
            patch.object(runtime, "BUSINESS_FLOW_IMPORT_DIR", root / "imports"),
            patch_auth_enabled(False),
        )
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        self.client = TestClient(main.app)

    @staticmethod
    def _candidate(job_id: str) -> dict:
        fragment = {
            "id": f"{job_id}-fragment-1",
            "title": "申請を確認する",
            "description": "申請内容を確認する",
            "actor": "担当者",
            "trigger": "申請受領",
            "tools": ["申請システム"],
            "output": "確認済み申請",
            "next_step": "承認する",
            "next_actor": "承認者",
            "standard_time": "未確認",
            "processing_volume": "未確認",
            "source_document": "flow.pdf",
            "source_reference": "p.1 左から1番目",
            "data_items": [],
            "personalization": "低",
            "confidence": 90,
            "source_quote": "flow.pdf p.1",
            "source_time": "資料インポート",
        }
        return {
            "id": f"{job_id}-candidate-1",
            "title": "申請業務",
            "summary": "申請を確認して承認する業務",
            "confidence": 85,
            "page_references": ["p.1"],
            "fragments": [fragment],
            "warnings": ["処理時間を確認してください。"],
            "draft": {
                "title": "申請業務 As-Is",
                "summary": "申請業務",
                "start_condition": "申請受領",
                "end_condition": "承認完了",
                "lanes": ["担当者"],
                "nodes": [{
                    "key": "task-1", "label": "申請を確認する", "type": "task",
                    "actor": "担当者", "order": 1, "confidence": 90,
                    "source_fragment_ids": [fragment["id"]], "needs_review": True,
                }],
                "flows": [], "assets": [], "asset_links": [],
                "assumptions": [], "review_items": ["処理時間を確認してください。"],
            },
            "selected": True,
            "target_business_id": "",
        }

    def test_upload_review_update_and_commit(self) -> None:
        response = self.client.post(
            "/api/business-flow-imports",
            data={"department_id": "accounting"},
            files={"file": ("flow.pdf", b"%PDF-test", "application/pdf")},
        )
        self.assertEqual(response.status_code, 202)
        job = response.json()
        self.assertEqual(job["status"], "queued")
        self.assertEqual(self.worker.notifications, 1)
        self.assertTrue(Path(self.store.get_business_flow_import(job["id"])["file_path"]).is_file())

        candidate = self._candidate(job["id"])
        self.store.update_business_flow_import(
            job["id"], status="ready_for_review", stage="内容を確認してください",
            progress=100, candidate_count=1, candidates=[candidate],
        )
        detail = self.client.get(f"/api/business-flow-imports/{job['id']}")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["candidates"][0]["title"], "申請業務")

        updated = self.client.patch(
            f"/api/business-flow-imports/{job['id']}/candidates/{candidate['id']}",
            json={"title": "支払申請業務", "target_business_id": "existing-business"},
        )
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json()["candidates"][0]["title"], "支払申請業務")

        committed = self.client.post(
            f"/api/business-flow-imports/{job['id']}/commit",
            json={"candidate_ids": [candidate["id"]]},
        )
        self.assertEqual(committed.status_code, 200)
        self.assertEqual(committed.json()["status"], "completed")

    def test_cancelled_job_can_be_retried(self) -> None:
        response = self.client.post(
            "/api/business-flow-imports",
            data={"department_id": "accounting"},
            files={"file": ("flow.png", b"\x89PNG\r\n\x1a\n", "image/png")},
        )
        job_id = response.json()["id"]
        cancelled = self.client.post(f"/api/business-flow-imports/{job_id}/cancel")
        self.assertEqual(cancelled.json()["status"], "cancelled")
        retried = self.client.post(f"/api/business-flow-imports/{job_id}/retry")
        self.assertEqual(retried.json()["status"], "queued")
        self.assertEqual(self.worker.notifications, 2)

    def test_import_routes_use_tenant_roles(self) -> None:
        from backend.app import main

        with patch_auth_enabled(True):
            self.assertEqual(middleware._required_role_for_request("GET", "/api/business-flow-imports"), "viewer")
            self.assertEqual(middleware._required_role_for_request("POST", "/api/business-flow-imports"), "user")
            self.assertEqual(
                middleware._required_role_for_request("PATCH", "/api/business-flow-imports/job/candidates/candidate"),
                "user",
            )


class BusinessFlowPdfChunkTest(unittest.TestCase):
    def test_pdf_is_split_with_one_page_overlap(self) -> None:
        from pypdf import PdfWriter
        from backend.app.services.business_flow_import import _pdf_chunks

        with TemporaryDirectory() as directory:
            path = Path(directory) / "flow.pdf"
            writer = PdfWriter()
            for _ in range(10):
                writer.add_blank_page(width=100, height=100)
            with path.open("wb") as output:
                writer.write(output)
            total_pages, chunks = _pdf_chunks(path)

        self.assertEqual(total_pages, 10)
        self.assertEqual([(start, end) for start, end, _ in chunks], [(1, 8), (8, 10)])


if __name__ == "__main__":
    unittest.main()
