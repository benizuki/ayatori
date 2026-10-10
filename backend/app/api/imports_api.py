"""業務フロー資料の取り込みジョブ。"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile

from .. import runtime
from ..runtime import LOCAL_USAGE_USER, MAX_BUSINESS_FLOW_IMPORT_BYTES
from ..schemas import BusinessFlowImportCandidateUpdate, BusinessFlowImportCommitRequest, BusinessFlowImportJob
from .common import _request_tenant_id, _request_user_email_or_empty

router = APIRouter()


def _business_flow_import_response(record: dict[str, Any]) -> BusinessFlowImportJob:
    return BusinessFlowImportJob.model_validate({
        key: value
        for key, value in record.items()
        if key not in {"tenant_id", "owner_email", "mime_type", "file_path", "cancel_requested", "attempts"}
    })


def _get_business_flow_import_or_404(job_id: str, request: Request) -> dict[str, Any]:
    record = runtime.store.get_business_flow_import(job_id, _request_tenant_id(request))
    if record is None:
        raise HTTPException(status_code=404, detail="業務フロー資料の解析ジョブが見つかりません。")
    return record


@router.post("/api/business-flow-imports", response_model=BusinessFlowImportJob, status_code=202)
async def create_business_flow_import(
    request: Request,
    department_id: str = Form(min_length=1, max_length=200),
    file: UploadFile = File(...),
) -> BusinessFlowImportJob:
    mime_type = (file.content_type or "").split(";", 1)[0].strip().lower()
    allowed_types = {"application/pdf", "image/png", "image/jpeg", "image/webp"}
    if mime_type not in allowed_types:
        raise HTTPException(status_code=415, detail="PDF・PNG・JPEG・WebPのみ読み込めます。")
    original_name = Path(file.filename or "business-flow-document").name
    safe_name = re.sub(r"[\x00-\x1f]", "", original_name).strip()[:255]
    if not safe_name:
        safe_name = "business-flow-document.pdf" if mime_type == "application/pdf" else "business-flow-image"
    tenant_id = _request_tenant_id(request)
    job_id = f"flow-import-{uuid4().hex}"
    job_dir = runtime.BUSINESS_FLOW_IMPORT_DIR / tenant_id / job_id
    job_dir.mkdir(parents=True, exist_ok=False)
    destination = job_dir / safe_name
    total = 0
    try:
        with destination.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_BUSINESS_FLOW_IMPORT_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"資料は{MAX_BUSINESS_FLOW_IMPORT_BYTES // (1024 * 1024)}MB以下にしてください。",
                    )
                output.write(chunk)
        if total == 0:
            raise HTTPException(status_code=400, detail="資料が空です。")
        destination.chmod(0o600)
        now = datetime.now(timezone.utc).isoformat()
        record = {
            "id": job_id,
            "tenant_id": tenant_id,
            "owner_email": _request_user_email_or_empty(request) or LOCAL_USAGE_USER,
            "department_id": department_id,
            "file_name": safe_name,
            "mime_type": mime_type,
            "file_path": str(destination),
            "file_size": total,
            "created_at": now,
        }
        runtime.store.create_business_flow_import(record)
    except Exception:
        if destination.is_file():
            destination.unlink()
        if job_dir.is_dir() and not any(job_dir.iterdir()):
            job_dir.rmdir()
        raise
    finally:
        await file.close()
    runtime.business_flow_import_worker.notify()
    created = runtime.store.get_business_flow_import(job_id, tenant_id)
    if created is None:
        raise HTTPException(status_code=500, detail="解析ジョブを作成できませんでした。")
    return _business_flow_import_response(created)


@router.get("/api/business-flow-imports", response_model=list[BusinessFlowImportJob])
def list_business_flow_import_jobs(request: Request) -> list[BusinessFlowImportJob]:
    return [
        _business_flow_import_response({**record, "candidates": []})
        for record in runtime.store.list_business_flow_imports(_request_tenant_id(request))
    ]


@router.get("/api/business-flow-imports/{job_id}", response_model=BusinessFlowImportJob)
def get_business_flow_import(job_id: str, request: Request) -> BusinessFlowImportJob:
    return _business_flow_import_response(_get_business_flow_import_or_404(job_id, request))


@router.patch(
    "/api/business-flow-imports/{job_id}/candidates/{candidate_id}",
    response_model=BusinessFlowImportJob,
)
def update_business_flow_import_candidate(
    job_id: str,
    candidate_id: str,
    update: BusinessFlowImportCandidateUpdate,
    request: Request,
) -> BusinessFlowImportJob:
    record = _get_business_flow_import_or_404(job_id, request)
    if record["status"] not in {"ready_for_review", "completed"}:
        raise HTTPException(status_code=409, detail="解析完了後に候補を編集できます。")
    candidates = record["candidates"]
    candidate = next((item for item in candidates if item.get("id") == candidate_id), None)
    if candidate is None:
        raise HTTPException(status_code=404, detail="業務候補が見つかりません。")
    changes = update.model_dump(exclude_none=True)
    candidate.update(changes)
    runtime.store.update_business_flow_import(job_id, candidates=candidates)
    return _business_flow_import_response(_get_business_flow_import_or_404(job_id, request))


@router.post("/api/business-flow-imports/{job_id}/commit", response_model=BusinessFlowImportJob)
def commit_business_flow_import(
    job_id: str,
    payload: BusinessFlowImportCommitRequest,
    request: Request,
) -> BusinessFlowImportJob:
    record = _get_business_flow_import_or_404(job_id, request)
    if record["status"] != "ready_for_review":
        raise HTTPException(status_code=409, detail="レビュー待ちの解析ジョブだけ確定できます。")
    selected_ids = set(payload.candidate_ids)
    available_ids = {item.get("id") for item in record["candidates"]}
    if not selected_ids.issubset(available_ids):
        raise HTTPException(status_code=422, detail="存在しない業務候補が含まれています。")
    candidates = [
        {**item, "selected": item.get("id") in selected_ids}
        for item in record["candidates"]
    ]
    runtime.store.update_business_flow_import(
        job_id, status="completed", stage="業務マスターへ反映済み",
        candidates=candidates, candidate_count=len(selected_ids), progress=100,
    )
    return _business_flow_import_response(_get_business_flow_import_or_404(job_id, request))


@router.post("/api/business-flow-imports/{job_id}/cancel", response_model=BusinessFlowImportJob)
def cancel_business_flow_import(job_id: str, request: Request) -> BusinessFlowImportJob:
    record = _get_business_flow_import_or_404(job_id, request)
    if record["status"] in {"completed", "cancelled"}:
        return _business_flow_import_response(record)
    if record["status"] in {"queued", "failed", "ready_for_review"}:
        runtime.store.update_business_flow_import(
            job_id, status="cancelled", stage="キャンセル済み", cancel_requested=1,
        )
    else:
        runtime.store.update_business_flow_import(job_id, stage="キャンセル処理中", cancel_requested=1)
    return _business_flow_import_response(_get_business_flow_import_or_404(job_id, request))


@router.post("/api/business-flow-imports/{job_id}/retry", response_model=BusinessFlowImportJob)
def retry_business_flow_import(job_id: str, request: Request) -> BusinessFlowImportJob:
    record = _get_business_flow_import_or_404(job_id, request)
    if record["status"] not in {"failed", "cancelled"}:
        raise HTTPException(status_code=409, detail="失敗またはキャンセル済みのジョブだけ再実行できます。")
    runtime.store.update_business_flow_import(
        job_id, status="queued", stage="再実行待ち", error="", cancel_requested=0,
    )
    runtime.business_flow_import_worker.notify()
    return _business_flow_import_response(_get_business_flow_import_or_404(job_id, request))
