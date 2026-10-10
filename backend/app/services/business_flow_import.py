from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from pydantic import BaseModel, Field
from ..core.ai_usage import begin_token_capture, summarize_tokens
from ..schemas import InterviewAttachment, ProcessDraftFragment, ProcessDraftRequest
from ..storage.sqlite_store import AyatoriSQLiteStore
from .llm_interview import (
    LLMInterviewError,
    _generate_model_response,
    extract_business_documents,
    generate_process_draft,
)


logger = logging.getLogger(__name__)
PDF_PAGES_PER_CHUNK = 8
PDF_CHUNK_OVERLAP = 1
MAX_IMPORT_PAGES = 200
MAX_IMPORT_FRAGMENTS = 500
MAX_DRAFT_FRAGMENTS = 150
MAX_MODEL_ATTACHMENT_BYTES = 8 * 1024 * 1024


class _BusinessGroup(BaseModel):
    title: str
    summary: str = ""
    fragment_indexes: list[int] = Field(default_factory=list)
    confidence: int = Field(default=50, ge=0, le=100)
    warnings: list[str] = Field(default_factory=list)


class _BusinessGroupingDecision(BaseModel):
    groups: list[_BusinessGroup] = Field(default_factory=list)


GROUPING_INSTRUCTION = """あなたは業務フロー資料から抽出済みの工程を、独立した業務単位へ分類する専門家です。
工程名、担当、前後関係、ページ位置を根拠に分類してください。

必須ルール:
- 1つの資料に複数業務があればgroupsを分ける。同一業務が複数ページに続く場合は同じgroupにする。
- fragment_indexesには入力にあるindexだけを重複なく設定する。
- 全indexをいずれか1つのgroupへ必ず含める。根拠が弱い場合は最も近いgroupへ入れてwarningsへ記録する。
- titleは資料から判断できる業務名。不明なら主要工程を表す仮称にする。
- 改善案や資料にない工程は追加しない。
- 最大50業務までとする。
- JSONオブジェクトだけを返す。
{"groups":[{"title":"業務名","summary":"範囲","fragment_indexes":[0],"confidence":80,"warnings":[]}]}
"""


class ImportCancelled(Exception):
    pass


def _pdf_chunks(path: Path) -> tuple[int, list[tuple[int, int, bytes]]]:
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError as exc:
        raise RuntimeError("PDF解析ライブラリがインストールされていません。uv syncを実行してください。") from exc
    reader = PdfReader(str(path))
    if reader.is_encrypted and not reader.decrypt(""):
        raise ValueError("暗号化されたPDFは解析できません。暗号化を解除して再度お試しください。")
    total_pages = len(reader.pages)
    if not total_pages:
        raise ValueError("PDFにページがありません。")
    if total_pages > MAX_IMPORT_PAGES:
        raise ValueError(f"PDFは{MAX_IMPORT_PAGES}ページ以下にしてください。")
    chunks: list[tuple[int, int, bytes]] = []
    start = 0
    while start < total_pages:
        end = min(total_pages, start + PDF_PAGES_PER_CHUNK)
        while True:
            writer = PdfWriter()
            for page_index in range(start, end):
                writer.add_page(reader.pages[page_index])
            buffer = io.BytesIO()
            writer.write(buffer)
            chunk_bytes = buffer.getvalue()
            if len(chunk_bytes) <= MAX_MODEL_ATTACHMENT_BYTES or end - start == 1:
                break
            end = start + max(1, (end - start) // 2)
        if len(chunk_bytes) > MAX_MODEL_ATTACHMENT_BYTES:
            raise ValueError(f"{start + 1}ページ目が8MBを超えるため解析できません。")
        chunks.append((start + 1, end, chunk_bytes))
        if end >= total_pages:
            break
        start = end - PDF_CHUNK_OVERLAP
    return total_pages, chunks


def _source_reference_at_original_page(reference: str, page_offset: int) -> str:
    return re.sub(
        r"\bp\.(\d+)\b",
        lambda match: f"p.{int(match.group(1)) + page_offset}",
        reference,
        count=1,
        flags=re.IGNORECASE,
    )


def _extract_chunk(file_name: str, mime_type: str, data: bytes, page_from: int) -> dict[str, Any]:
    attachment = InterviewAttachment(
        name=file_name,
        mime_type=mime_type,  # type: ignore[arg-type]
        data=base64.b64encode(data).decode("ascii"),
    )
    result = extract_business_documents([attachment])
    page_offset = page_from - 1
    for fragment in result.fragments:
        fragment.source_document = file_name
        fragment.source_reference = _source_reference_at_original_page(
            fragment.source_reference,
            page_offset,
        )
        for data_item in fragment.data_items:
            data_item.source_document = file_name
    return result.model_dump(mode="json")


def _deduplicate_fragments(chunk_results: list[dict[str, Any]], job_id: str) -> list[ProcessDraftFragment]:
    fragments: list[ProcessDraftFragment] = []
    seen: set[tuple[str, str, str]] = set()
    for result in chunk_results:
        for raw in result.get("fragments", []):
            key = (
                str(raw.get("source_reference", "")).strip().casefold(),
                str(raw.get("title", "")).strip().casefold(),
                str(raw.get("actor", "")).strip().casefold(),
            )
            if key in seen:
                continue
            seen.add(key)
            fragments.append(ProcessDraftFragment(
                **raw,
                id=f"{job_id}-fragment-{len(fragments) + 1}",
                source_quote=f"{raw.get('source_document', '')} {raw.get('source_reference', '')}".strip(),
                source_time="資料インポート",
            ))
            if len(fragments) >= MAX_IMPORT_FRAGMENTS:
                return fragments
    return fragments


def _group_fragments(fragments: list[ProcessDraftFragment], fallback_title: str) -> list[_BusinessGroup]:
    payload = [
        {
            "index": index,
            "title": fragment.title,
            "actor": fragment.actor,
            "next_step": fragment.next_step,
            "source_reference": fragment.source_reference,
        }
        for index, fragment in enumerate(fragments)
    ]
    try:
        decision = _generate_model_response(
            "次の工程を業務単位に分類してください。\n\n"
            + json.dumps(payload, ensure_ascii=False),
            _BusinessGroupingDecision,
            GROUPING_INSTRUCTION,
        )
    except LLMInterviewError:
        logger.warning("Business grouping failed; using one document-level group", exc_info=True)
        return [_BusinessGroup(
            title=fallback_title,
            summary="資料全体を1つの業務候補として抽出しました。",
            fragment_indexes=list(range(len(fragments))),
            confidence=40,
            warnings=["業務境界を自動判定できなかったため、必要に応じて候補を確認してください。"],
        )]

    assigned: set[int] = set()
    groups: list[_BusinessGroup] = []
    for group in decision.groups[:50]:
        indexes = [index for index in group.fragment_indexes if 0 <= index < len(fragments) and index not in assigned]
        if not indexes:
            continue
        assigned.update(indexes)
        groups.append(group.model_copy(update={"fragment_indexes": indexes}))
    missing = [index for index in range(len(fragments)) if index not in assigned]
    if missing:
        if groups:
            groups[0].fragment_indexes.extend(missing)
            groups[0].warnings.append(f"業務境界が不明な{len(missing)}工程をこの候補へ含めています。")
        else:
            groups.append(_BusinessGroup(
                title=fallback_title,
                fragment_indexes=missing,
                confidence=40,
                warnings=["業務境界を確認してください。"],
            ))
    return groups


def process_business_flow_import(
    store: AyatoriSQLiteStore,
    job: dict[str, Any],
    should_cancel: Callable[[], bool],
) -> list[dict[str, Any]]:
    path = Path(job["file_path"])
    mime_type = str(job["mime_type"])
    if not path.is_file():
        raise ValueError("アップロードされた資料が見つかりません。")
    if mime_type == "application/pdf":
        with path.open("rb") as source:
            signature = source.read(5)
        if signature != b"%PDF-":
            raise ValueError("PDFファイルの形式が正しくありません。")
        total_pages, chunks = _pdf_chunks(path)
    else:
        source_bytes = path.read_bytes()
        valid_image = (
            (mime_type == "image/png" and source_bytes.startswith(b"\x89PNG\r\n\x1a\n"))
            or (mime_type == "image/jpeg" and source_bytes.startswith(b"\xff\xd8\xff"))
            or (
                mime_type == "image/webp" and source_bytes.startswith(b"RIFF")
                and source_bytes[8:12] == b"WEBP"
            )
        )
        if not valid_image:
            raise ValueError("画像ファイルの形式が正しくありません。")
        total_pages, chunks = 1, [(1, 1, source_bytes)]
    store.update_business_flow_import(
        job["id"], status="extracting", stage="ページごとの工程を抽出中",
        total_pages=total_pages, processed_pages=0, progress=5,
    )

    cached = {item["chunk_index"]: item for item in store.list_business_flow_import_chunks(job["id"])}
    results: list[dict[str, Any]] = []
    processed_pages = 0
    for index, (page_from, page_to, chunk_bytes) in enumerate(chunks):
        if should_cancel():
            raise ImportCancelled()
        existing = cached.get(index)
        if existing and existing["status"] == "completed" and existing["result"]:
            result = existing["result"]
        else:
            try:
                result = _extract_chunk(job["file_name"], mime_type, chunk_bytes, page_from)
                store.upsert_business_flow_import_chunk(
                    job["id"], index, page_from, page_to, status="completed", result=result,
                )
            except Exception as exc:
                store.upsert_business_flow_import_chunk(
                    job["id"], index, page_from, page_to, status="failed", error=str(exc)[:1000],
                )
                raise
        results.append(result)
        processed_pages = max(processed_pages, page_to)
        store.update_business_flow_import(
            job["id"], processed_pages=processed_pages,
            progress=5 + round(processed_pages / total_pages * 55),
            stage=f"{processed_pages}/{total_pages}ページを解析済み",
        )

    fragments = _deduplicate_fragments(results, job["id"])
    if not fragments:
        raise ValueError("資料から業務工程を抽出できませんでした。")
    store.update_business_flow_import(
        job["id"], status="classifying", stage="複数業務の境界を判定中", progress=65,
    )
    fallback_title = Path(job["file_name"]).stem or "資料から抽出した業務"
    groups = _group_fragments(fragments, fallback_title)

    candidates: list[dict[str, Any]] = []
    for index, group in enumerate(groups):
        if should_cancel():
            raise ImportCancelled()
        candidate_fragments = [fragments[item] for item in group.fragment_indexes]
        draft_fragments = candidate_fragments[:MAX_DRAFT_FRAGMENTS]
        warnings = list(group.warnings)
        if len(candidate_fragments) > MAX_DRAFT_FRAGMENTS:
            warnings.append(
                f"{len(candidate_fragments)}工程中、先頭{MAX_DRAFT_FRAGMENTS}工程でAs-Isを生成しました。"
            )
        department_name = str(job.get("department_id") or "未確認")
        draft = generate_process_draft(ProcessDraftRequest(
            session_id=job["id"],
            department=department_name,
            participant="業務フロー資料",
            business_context={
                "analysis_mode": "document_import",
                "target_business_name": group.title,
                "source_document": job["file_name"],
            },
            fragments=draft_fragments,
        ))
        page_references = sorted({
            fragment.source_reference.split(" ", 1)[0]
            for fragment in candidate_fragments
            if fragment.source_reference
        })
        candidates.append({
            "id": f"{job['id']}-candidate-{index + 1}",
            "title": group.title or draft.title,
            "summary": group.summary or draft.summary,
            "confidence": group.confidence,
            "page_references": page_references,
            "fragments": [fragment.model_dump(mode="json") for fragment in candidate_fragments],
            "warnings": warnings,
            "draft": draft.model_dump(mode="json"),
            "selected": True,
            "target_business_id": "",
        })
        store.update_business_flow_import(
            job["id"], status="assembling",
            stage=f"As-Is候補を生成中（{index + 1}/{len(groups)}）",
            progress=70 + round((index + 1) / max(1, len(groups)) * 25),
            candidate_count=len(candidates), candidates=candidates,
        )
    return candidates


class BusinessFlowImportWorker:
    def __init__(self, store: AyatoriSQLiteStore) -> None:
        self.store = store
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self.store.recover_business_flow_imports()
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="business-flow-import", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=5)

    def notify(self) -> None:
        self._wake.set()

    def _run(self) -> None:
        while not self._stop.is_set():
            job = self.store.claim_business_flow_import()
            if not job:
                self._wake.wait(2)
                self._wake.clear()
                continue
            started = time.monotonic()
            token_bucket = begin_token_capture()
            outcome = "ok"
            deadline = time.monotonic() + max(
                60,
                int(os.getenv("AYATORI_IMPORT_JOB_TIMEOUT_SECONDS", "1800")),
            )
            deadline_exceeded = False
            try:
                def cancelled() -> bool:
                    nonlocal deadline_exceeded
                    deadline_exceeded = time.monotonic() >= deadline
                    current = self.store.get_business_flow_import(job["id"])
                    return deadline_exceeded or self._stop.is_set() or bool(current and current["cancel_requested"])

                candidates = process_business_flow_import(self.store, job, cancelled)
                self.store.update_business_flow_import(
                    job["id"], status="ready_for_review", stage="内容を確認してください",
                    progress=100, candidate_count=len(candidates), candidates=candidates,
                )
            except ImportCancelled:
                if self._stop.is_set():
                    outcome = "interrupted"
                    self.store.update_business_flow_import(
                        job["id"], status="queued", stage="再起動後の再開待ち", error="",
                    )
                elif deadline_exceeded:
                    outcome = "error"
                    self.store.update_business_flow_import(
                        job["id"], status="failed", stage="制限時間を超過しました",
                        error="解析が30分以内に完了しませんでした。再実行すると完了済みページから再開します。",
                    )
                else:
                    outcome = "cancelled"
                    self.store.update_business_flow_import(
                        job["id"], status="cancelled", stage="キャンセル済み", error="",
                    )
            except Exception as exc:
                outcome = "error"
                logger.exception("Business flow import failed: %s", job["id"])
                self.store.update_business_flow_import(
                    job["id"], status="failed", stage="解析に失敗しました", error=str(exc)[:2000],
                )
            finally:
                tokens = summarize_tokens(token_bucket)
                try:
                    self.store.record_ai_usage(
                        tenant_id=job["tenant_id"], user_email=job["owner_email"],
                        feature="業務フロー資料インポート", endpoint="/api/business-flow-imports",
                        outcome=outcome, duration_ms=int((time.monotonic() - started) * 1000),
                        occurred_at=datetime.now(timezone.utc).isoformat(),
                        prompt_tokens=tokens.prompt, output_tokens=tokens.output,
                        total_tokens=tokens.total,
                    )
                except Exception:
                    logger.warning("Import AI usage record failed", exc_info=True)
