from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import sqlite3

from backend.app.storage.sqlite_store import AyatoriSQLiteStore


class UserInterviewPreferenceStoreTest(unittest.TestCase):
    def test_legacy_preference_is_migrated_to_default_tenant(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "ayatori.sqlite"
            connection = sqlite3.connect(str(path), isolation_level=None)
            connection.execute(
                """
                CREATE TABLE user_interview_preferences (
                    user_email TEXT PRIMARY KEY,
                    active_interview_id TEXT,
                    updated_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                INSERT INTO user_interview_preferences
                VALUES ('legacy@example.com', 'legacy-interview', 'first')
                """
            )
            connection.close()

            store = AyatoriSQLiteStore(path)

            self.assertEqual(
                store.load_user_interview_preference(
                    "legacy@example.com",
                    "default",
                )["active_interview_id"],
                "legacy-interview",
            )

    def test_app_state_is_scoped_by_tenant(self) -> None:
        with TemporaryDirectory() as directory:
            store = AyatoriSQLiteStore(Path(directory) / "ayatori.sqlite")
            store.save_app_state({"departments": ["default"]}, "first", "default")
            store.save_app_state({"departments": ["east"]}, "second", "east")

            self.assertEqual(
                store.load_app_state("default")["departments"],
                ["default"],
            )
            self.assertEqual(
                store.load_app_state("east")["departments"],
                ["east"],
            )
            self.assertEqual(
                store.load_app_states(),
                {
                    "default": {"departments": ["default"]},
                    "east": {"departments": ["east"]},
                },
            )

    def test_preference_is_scoped_by_normalized_user_email(self) -> None:
        with TemporaryDirectory() as directory:
            store = AyatoriSQLiteStore(Path(directory) / "ayatori.sqlite")

            store.save_user_interview_preference(
                " User.One@example.com ",
                "interview-user-one",
                "2026-07-28T00:00:00+00:00",
            )
            store.save_user_interview_preference(
                "user.two@example.com",
                "interview-user-two",
                "2026-07-28T00:01:00+00:00",
            )

            self.assertEqual(
                store.load_user_interview_preference("user.one@example.com")["active_interview_id"],
                "interview-user-one",
            )
            self.assertEqual(
                store.load_user_interview_preference("USER.TWO@example.com")["active_interview_id"],
                "interview-user-two",
            )

    def test_preference_can_be_cleared_without_affecting_other_users(self) -> None:
        with TemporaryDirectory() as directory:
            store = AyatoriSQLiteStore(Path(directory) / "ayatori.sqlite")
            store.save_user_interview_preference("one@example.com", "interview-one", "first")
            store.save_user_interview_preference("two@example.com", "interview-two", "first")

            store.save_user_interview_preference("one@example.com", None, "second")

            self.assertIsNone(
                store.load_user_interview_preference("one@example.com")["active_interview_id"]
            )
            self.assertEqual(
                store.load_user_interview_preference("two@example.com")["active_interview_id"],
                "interview-two",
            )

    def test_preference_is_scoped_by_tenant(self) -> None:
        with TemporaryDirectory() as directory:
            store = AyatoriSQLiteStore(Path(directory) / "ayatori.sqlite")
            store.save_user_interview_preference(
                "one@example.com",
                "default-interview",
                "first",
                "default",
            )
            store.save_user_interview_preference(
                "one@example.com",
                "east-interview",
                "second",
                "east",
            )

            self.assertEqual(
                store.load_user_interview_preference("one@example.com", "default")["active_interview_id"],
                "default-interview",
            )
            self.assertEqual(
                store.load_user_interview_preference("one@example.com", "east")["active_interview_id"],
                "east-interview",
            )


if __name__ == "__main__":
    unittest.main()
