from __future__ import annotations

import base64
import binascii
import hashlib
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

from ..schemas import InterviewAttachment, SavedInterviewAttachment


ATTACHMENT_ID_PATTERN = re.compile(r"^[a-f0-9]{64}$")
MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024


class InterviewAttachmentStorageError(RuntimeError):
    pass


def _safe_segment(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip()).strip("._-")
    label = normalized[:64] or "item"
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:10]
    return f"{label}-{digest}"


def _safe_filename(filename: str) -> str:
    basename = Path(filename.replace("\\", "/")).name
    normalized = re.sub(r"[\x00-\x1f\x7f/\\]+", "_", basename).strip(" .")
    if not normalized:
        normalized = "attachment"
    stem = Path(normalized).stem[:120] or "attachment"
    suffix = Path(normalized).suffix[:16]
    return f"{stem}{suffix}"


def interview_attachment_directory(root: Path, tenant_id: str, session_id: str) -> Path:
    return root.expanduser() / _safe_segment(tenant_id) / _safe_segment(session_id)


def save_interview_attachments(
    root: Path,
    tenant_id: str,
    session_id: str,
    attachments: list[InterviewAttachment],
) -> list[SavedInterviewAttachment]:
    if not attachments:
        return []

    decoded: list[tuple[InterviewAttachment, bytes]] = []
    for attachment in attachments:
        try:
            content = base64.b64decode(attachment.data, validate=True)
        except (binascii.Error, ValueError, TypeError) as exc:
            raise InterviewAttachmentStorageError(
                f"添付ファイル「{attachment.name}」を読み込めませんでした。"
            ) from exc
        if len(content) > MAX_ATTACHMENT_BYTES:
            raise InterviewAttachmentStorageError(
                f"添付ファイル「{attachment.name}」は8MB以下にしてください。"
            )
        decoded.append((attachment, content))

    directory = interview_attachment_directory(root, tenant_id, session_id)
    try:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError as exc:
        raise InterviewAttachmentStorageError("添付ファイルの保存フォルダを作成できませんでした。") from exc

    saved: list[SavedInterviewAttachment] = []
    for attachment, content in decoded:
        digest = hashlib.sha256(
            attachment.name.encode("utf-8")
            + b"\0"
            + attachment.mime_type.encode("ascii")
            + b"\0"
            + content
        ).hexdigest()
        filename = f"{digest}__{_safe_filename(attachment.name)}"
        destination = directory / filename
        if not destination.exists():
            temporary = directory / f".{digest}.{uuid.uuid4().hex}.tmp"
            try:
                with temporary.open("xb") as file:
                    file.write(content)
                temporary.replace(destination)
            except OSError as exc:
                temporary.unlink(missing_ok=True)
                raise InterviewAttachmentStorageError(
                    f"添付ファイル「{attachment.name}」を保存できませんでした。"
                ) from exc

        saved.append(
            SavedInterviewAttachment(
                id=digest,
                name=attachment.name,
                mime_type=attachment.mime_type,
                size=len(content),
                uploaded_at=datetime.now(timezone.utc).isoformat(),
            )
        )
    return saved


def resolve_interview_attachment(
    root: Path,
    tenant_id: str,
    session_id: str,
    attachment_id: str,
) -> Path | None:
    if not ATTACHMENT_ID_PATTERN.fullmatch(attachment_id):
        return None
    directory = interview_attachment_directory(root, tenant_id, session_id)
    if not directory.is_dir():
        return None
    prefix = f"{attachment_id}__"
    for candidate in directory.iterdir():
        if candidate.is_file() and candidate.name.startswith(prefix):
            return candidate
    return None


def delete_interview_attachments(root: Path, tenant_id: str, session_id: str) -> None:
    directory = interview_attachment_directory(root, tenant_id, session_id)
    if directory.is_dir():
        shutil.rmtree(directory)


def move_interview_attachments(
    root: Path,
    source_tenant_id: str,
    target_tenant_id: str,
    session_id: str,
) -> None:
    source = interview_attachment_directory(root, source_tenant_id, session_id)
    if not source.is_dir():
        return
    target = interview_attachment_directory(root, target_tenant_id, session_id)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if target.exists():
        raise InterviewAttachmentStorageError(
            f"移管先に同じヒアリングの添付フォルダが存在します: {session_id}"
        )
    source.replace(target)
