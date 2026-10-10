from __future__ import annotations

import json
import logging
from pathlib import Path

from ..schemas import InterviewSessionRecord, InterviewSessionState


logger = logging.getLogger(__name__)


def discard_blank_interview_sessions(
    sessions: dict[str, InterviewSessionRecord],
) -> tuple[dict[str, InterviewSessionRecord], list[str]]:
    """Remove legacy records that cannot be addressed by the path-based API."""
    valid: dict[str, InterviewSessionRecord] = {}
    discarded: list[str] = []
    for storage_id, record in sessions.items():
        if storage_id.strip() and record.session_state.session_id.strip():
            valid[storage_id] = record
        else:
            discarded.append(storage_id)
    return valid, discarded


def load_interview_sessions(path: Path) -> dict[str, InterviewSessionRecord]:
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("session store root must be an object")
        sessions: dict[str, InterviewSessionRecord] = {}
        raw_sessions = payload.get("sessions", payload)
        if not isinstance(raw_sessions, dict):
            raise ValueError("sessions must be an object")
        for session_id, raw_record in raw_sessions.items():
            try:
                if isinstance(raw_record, dict) and "session_state" in raw_record:
                    record = InterviewSessionRecord.model_validate(raw_record)
                else:
                    record = InterviewSessionRecord(
                        session_state=InterviewSessionState.model_validate(raw_record),
                    )
                sessions[str(session_id)] = record
            except Exception as exc:
                logger.warning("Invalid interview session %s was skipped: %s", session_id, exc)
        return sessions
    except Exception as exc:
        logger.warning("Interview session store could not be loaded: %s", exc)
        return {}


def save_interview_sessions(
    path: Path,
    sessions: dict[str, InterviewSessionRecord],
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(f"{path.suffix}.tmp")
    payload = {
        "version": 2,
        "sessions": {
            session_id: record.model_dump(mode="json")
            for session_id, record in sessions.items()
        },
    }
    temporary_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temporary_path.replace(path)
