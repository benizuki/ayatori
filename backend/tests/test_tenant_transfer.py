from __future__ import annotations

import unittest

from backend.app.services.tenant_transfer import (
    DepartmentTransferError,
    migrate_legacy_interview_tenants,
    move_department_payloads,
)
from backend.app.schemas import InterviewMessage, InterviewSessionRecord, InterviewSessionState


class TenantTransferTest(unittest.TestCase):
    def test_legacy_interview_is_moved_to_its_only_app_state_tenant(self) -> None:
        record = InterviewSessionRecord(
            session_state=InterviewSessionState(
                session_id="legacy-interview",
                department="経理",
                participant="担当者",
            ),
            messages=[InterviewMessage(role="user", text="旧ヒアリング")],
        )

        migrated, moved_ids = migrate_legacy_interview_tenants(
            {"legacy-interview": record},
            {
                "east": {
                    "interviewSessions": [
                        {"id": "legacy-interview", "departmentId": "accounting"},
                    ],
                },
            },
        )

        self.assertEqual(moved_ids, ["legacy-interview"])
        self.assertIn("east::legacy-interview", migrated)
        self.assertEqual(
            migrated["east::legacy-interview"].session_state.tenant_id,
            "east",
        )
        self.assertEqual(len(migrated["east::legacy-interview"].messages), 1)

    def test_legacy_interview_stays_default_when_app_state_owner_is_ambiguous(self) -> None:
        record = InterviewSessionRecord(
            session_state=InterviewSessionState(
                session_id="shared-interview",
                department="経理",
                participant="担当者",
            ),
        )

        migrated, moved_ids = migrate_legacy_interview_tenants(
            {"shared-interview": record},
            {
                "default": {"interviewSessions": [{"id": "shared-interview"}]},
                "east": {"interviewSessions": [{"id": "shared-interview"}]},
            },
        )

        self.assertEqual(moved_ids, [])
        self.assertIn("default::shared-interview", migrated)

    def test_department_and_linked_records_are_moved_together(self) -> None:
        source = {
            "departments": [
                {"id": "dept-a", "name": "経理", "tenantId": "source"},
                {"id": "dept-b", "name": "人事", "tenantId": "source"},
            ],
            "interviewSessions": [
                {"id": "interview-a", "departmentId": "dept-a"},
                {"id": "interview-b", "departmentId": "dept-b"},
            ],
            "workFragments": [{"id": "fragment-a", "departmentId": "dept-a"}],
            "businessMasters": [{"id": "business-a", "departmentId": "dept-a"}],
            "processModels": {
                "business-a": {"businessId": "business-a", "departmentId": "dept-a"},
                "business-b": {"businessId": "business-b", "departmentId": "dept-b"},
            },
            "processVersions": {
                "business-a": [{"id": "version-a"}],
                "business-b": [{"id": "version-b"}],
            },
        }

        next_source, next_target, interview_ids = move_department_payloads(
            source,
            {},
            "dept-a",
            "target",
        )

        self.assertEqual(
            [item["id"] for item in next_source["departments"]],
            ["dept-b"],
        )
        self.assertEqual(next_target["departments"][0]["tenantId"], "target")
        self.assertEqual(interview_ids, ["interview-a"])
        self.assertIn("business-a", next_target["processModels"])
        self.assertNotIn("business-a", next_source["processModels"])
        self.assertIn("business-a", next_target["processVersions"])

    def test_transfer_rejects_department_id_conflict(self) -> None:
        source = {
            "departments": [
                {"id": "dept-a"},
                {"id": "dept-b"},
            ],
        }
        target = {"departments": [{"id": "dept-a"}]}

        with self.assertRaisesRegex(DepartmentTransferError, "同じ部門ID"):
            move_department_payloads(source, target, "dept-a", "target")

    def test_last_department_cannot_be_transferred(self) -> None:
        source = {"departments": [{"id": "dept-a"}]}

        with self.assertRaisesRegex(DepartmentTransferError, "最後の1部門"):
            move_department_payloads(source, {}, "dept-a", "target")


if __name__ == "__main__":
    unittest.main()
