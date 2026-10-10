from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path

from backend.app.storage.interview_attachment_store import (
    InterviewAttachmentStorageError,
    delete_interview_attachments,
    interview_attachment_directory,
    move_interview_attachments,
    resolve_interview_attachment,
    save_interview_attachments,
)
from backend.app.schemas import (
    InterviewAttachment,
    InterviewMessage,
    InterviewSessionRecord,
    InterviewSessionState,
)
from backend.app.storage.session_store import load_interview_sessions, save_interview_sessions


def attachment(name: str, content: bytes) -> InterviewAttachment:
    return InterviewAttachment(
        name=name,
        mime_type="application/pdf",
        data=base64.b64encode(content).decode("ascii"),
    )


class InterviewAttachmentStoreTest(unittest.TestCase):
    def test_saves_and_resolves_attachment_in_tenant_session_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)

            saved = save_interview_attachments(
                root,
                "tenant/east",
                "../interview-1",
                [attachment("../../請求書.pdf", b"%PDF-test")],
            )

            self.assertEqual(len(saved), 1)
            self.assertEqual(saved[0].name, "../../請求書.pdf")
            self.assertEqual(saved[0].size, len(b"%PDF-test"))
            stored_path = resolve_interview_attachment(
                root,
                "tenant/east",
                "../interview-1",
                saved[0].id,
            )
            self.assertIsNotNone(stored_path)
            assert stored_path is not None
            self.assertEqual(stored_path.read_bytes(), b"%PDF-test")
            self.assertTrue(stored_path.is_relative_to(root))
            self.assertNotIn("..", stored_path.name)

    def test_repeated_identical_upload_reuses_one_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            upload = attachment("form.pdf", b"same content")

            first = save_interview_attachments(root, "tenant", "session", [upload])
            second = save_interview_attachments(root, "tenant", "session", [upload])

            self.assertEqual(first[0].id, second[0].id)
            directory = interview_attachment_directory(root, "tenant", "session")
            self.assertEqual(
                [item for item in directory.iterdir() if not item.name.startswith(".")],
                [resolve_interview_attachment(root, "tenant", "session", first[0].id)],
            )

    def test_invalid_base64_does_not_create_session_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            invalid = InterviewAttachment(
                name="broken.pdf",
                mime_type="application/pdf",
                data="not-base64!",
            )

            with self.assertRaises(InterviewAttachmentStorageError):
                save_interview_attachments(root, "tenant", "session", [invalid])

            self.assertFalse(
                interview_attachment_directory(root, "tenant", "session").exists()
            )

    def test_move_and_delete_only_affect_requested_session(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            moved = save_interview_attachments(
                root,
                "source",
                "session-a",
                [attachment("a.pdf", b"a")],
            )
            kept = save_interview_attachments(
                root,
                "source",
                "session-b",
                [attachment("b.pdf", b"b")],
            )

            move_interview_attachments(root, "source", "target", "session-a")

            self.assertIsNone(
                resolve_interview_attachment(
                    root, "source", "session-a", moved[0].id
                )
            )
            self.assertIsNotNone(
                resolve_interview_attachment(
                    root, "target", "session-a", moved[0].id
                )
            )
            self.assertIsNotNone(
                resolve_interview_attachment(
                    root, "source", "session-b", kept[0].id
                )
            )

            delete_interview_attachments(root, "target", "session-a")

            self.assertIsNone(
                resolve_interview_attachment(
                    root, "target", "session-a", moved[0].id
                )
            )
            self.assertIsNotNone(
                resolve_interview_attachment(
                    root, "source", "session-b", kept[0].id
                )
            )

    def test_legacy_message_defaults_to_no_saved_attachments(self) -> None:
        message = InterviewMessage.model_validate(
            {"role": "user", "text": "従来のヒアリング回答"}
        )

        self.assertEqual(message.attachments, [])

    def test_saved_attachment_metadata_round_trips_through_session_history(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            saved = save_interview_attachments(
                root / "files",
                "tenant",
                "session",
                [attachment("source.pdf", b"source")],
            )
            store_path = root / "sessions.json"
            save_interview_sessions(
                store_path,
                {
                    "tenant::session": InterviewSessionRecord(
                        session_state=InterviewSessionState(
                            session_id="session",
                            tenant_id="tenant",
                            department="経理",
                            participant="担当者",
                        ),
                        messages=[
                            InterviewMessage(
                                role="user",
                                text="この帳票を確認してください",
                                attachments=saved,
                            )
                        ],
                    )
                },
            )

            loaded = load_interview_sessions(store_path)

            restored = loaded["tenant::session"].messages[0].attachments[0]
            self.assertEqual(restored.id, saved[0].id)
            self.assertEqual(restored.name, "source.pdf")
            self.assertEqual(restored.size, len(b"source"))


if __name__ == "__main__":
    unittest.main()
