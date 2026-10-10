"""テナント管理と、業務領域のテナント間移管。"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request

from .. import runtime
from ..core.auth import (
    create_tenant_entry,
    get_tenant,
    list_tenants,
    update_tenant_entry,
)
from ..runtime import (
    interview_histories,
    interview_sessions,
    interview_updated_at,
    session_lock,
)
from ..schemas import (
    DepartmentTenantMoveRequest,
    DepartmentTenantMoveResponse,
    TenantRecord,
    TenantUpdate,
)
from ..services.tenant_transfer import DepartmentTransferError, move_department_payloads
from ..storage.interview_attachment_store import InterviewAttachmentStorageError, move_interview_attachments
from .common import _interview_key, _request_tenant_id
from .interviews_api import _persist_interview_sessions

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/api/tenants", response_model=list[TenantRecord])
def tenants(request: Request) -> list[TenantRecord]:
    all_tenants = list_tenants()
    user = getattr(request.state, "user", None)
    # システムadminとシステムviewerは全テナントを見る。viewerの書き込みは各APIで止まる。
    if isinstance(user, dict) and user.get("role") not in {"admin", "viewer"}:
        permitted_ids = {
            membership.get("tenant_id")
            for membership in user.get("tenant_memberships", [])
            if isinstance(membership, dict)
        }
        all_tenants = [tenant for tenant in all_tenants if tenant["id"] in permitted_ids]
    return [TenantRecord(**tenant) for tenant in all_tenants]


@router.post("/api/tenants", response_model=TenantRecord)
def create_tenant(payload: TenantRecord) -> TenantRecord:
    tenant = create_tenant_entry(
        tenant_id=payload.id,
        name=payload.name,
        description=payload.description,
        enabled=payload.enabled,
    )
    return TenantRecord(**tenant)


@router.put("/api/tenants/{tenant_id}", response_model=TenantRecord)
def update_tenant(tenant_id: str, payload: TenantUpdate) -> TenantRecord:
    tenant = update_tenant_entry(tenant_id, payload.model_dump())
    return TenantRecord(**tenant)


@router.put(
    "/api/departments/{department_id}/tenant",
    response_model=DepartmentTenantMoveResponse,
)
def move_department_tenant(
    department_id: str,
    payload: DepartmentTenantMoveRequest,
    request: Request,
) -> DepartmentTenantMoveResponse:
    source_tenant_id = _request_tenant_id(request)
    target_tenant_id = payload.target_tenant_id.strip().lower()
    if target_tenant_id == source_tenant_id:
        raise HTTPException(status_code=400, detail="移管先は現在と異なるテナントを指定してください。")
    get_tenant(target_tenant_id)
    source_payload = runtime.master_data_store.merge_into_app_state(
        runtime.store.load_app_state(source_tenant_id),
        source_tenant_id,
    )
    target_payload = runtime.master_data_store.merge_into_app_state(
        runtime.store.load_app_state(target_tenant_id),
        target_tenant_id,
    )
    try:
        next_source, next_target, moved_interview_ids = move_department_payloads(
            source_payload,
            target_payload,
            department_id,
            target_tenant_id,
        )
    except DepartmentTransferError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    with session_lock:
        for session_id in moved_interview_ids:
            target_key = _interview_key(target_tenant_id, session_id)
            if target_key in interview_sessions:
                raise HTTPException(
                    status_code=409,
                    detail=f"移管先に同じヒアリングIDが存在します: {session_id}",
                )
        updated_at = datetime.now(timezone.utc).isoformat()
        source_operational, _ = runtime.master_data_store.split_from_app_state(
            next_source,
            source_tenant_id,
        )
        target_operational, _ = runtime.master_data_store.split_from_app_state(
            next_target,
            target_tenant_id,
        )
        source_operational["updatedAt"] = updated_at
        target_operational["updatedAt"] = updated_at
        runtime.store.save_app_states(
            {
                source_tenant_id: source_operational,
                target_tenant_id: target_operational,
            },
            updated_at,
        )
        for session_id in moved_interview_ids:
            source_key = _interview_key(source_tenant_id, session_id)
            target_key = _interview_key(target_tenant_id, session_id)
            state = interview_sessions.pop(source_key, None)
            if state is None:
                continue
            state.tenant_id = target_tenant_id
            interview_sessions[target_key] = state
            interview_histories[target_key] = interview_histories.pop(source_key, [])
            interview_updated_at[target_key] = interview_updated_at.pop(source_key, updated_at)
        _persist_interview_sessions()
        for session_id in moved_interview_ids:
            try:
                move_interview_attachments(
                    runtime.INTERVIEW_ATTACHMENT_DIR,
                    source_tenant_id,
                    target_tenant_id,
                    session_id,
                )
            except InterviewAttachmentStorageError as exc:
                logger.warning("Interview attachments could not be moved: %s", exc)

    return DepartmentTenantMoveResponse(
        department_id=department_id,
        source_tenant_id=source_tenant_id,
        target_tenant_id=target_tenant_id,
        moved_interview_ids=moved_interview_ids,
    )
