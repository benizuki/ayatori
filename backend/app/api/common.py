"""複数のルーターが使う、リクエストとテナント・組織の解決。"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import HTTPException, Request

from .. import runtime
from ..core.auth import DEFAULT_TENANT_ID
from ..schemas import AuthUser, OrgUnitRecord

def _auth_user_from_dict(user: dict[str, Any], tenant_id: str = DEFAULT_TENANT_ID) -> AuthUser:
    """画面が使う利用者情報。所属組織は選択中テナントのものへ解決して返す。"""
    return AuthUser(
        email=user["email"],
        name=user.get("name") or user["email"],
        google_subject=user.get("google_subject"),
        oauth_name=user.get("oauth_name"),
        oauth_picture=user.get("oauth_picture"),
        department=user.get("department"),
        department_id=user.get("department_id"),
        org_unit_id=_user_org_unit_id(user, tenant_id) or None,
        role=user.get("role", "viewer"),
        tenant_memberships=user.get("tenant_memberships", []),
    )


def _request_tenant_id(request: Request) -> str:
    return str(getattr(request.state, "tenant_id", DEFAULT_TENANT_ID)).strip().lower()


def _header_tenant_id(request: Request) -> str:
    """認証前でも参照できる選択中テナント。ログイン応答の所属解決に使う。"""
    header = request.headers.get("X-Tenant-ID", "").strip().lower()
    return header or _request_tenant_id(request)


def _interview_key(tenant_id: str, session_id: str) -> str:
    return f"{tenant_id}::{session_id}"


def _request_user_email_or_empty(request: Request) -> str:
    user = getattr(request.state, "user", None)
    return str(user.get("email", "") if isinstance(user, dict) else "").strip().lower()


def _tenant_departments(tenant_id: str) -> list[dict[str, Any]]:
    """業務を分類するための部門。人の所属を表すものではない。"""
    departments = runtime.master_data_store.load(tenant_id).get("departments", [])
    return [department for department in departments if isinstance(department, dict)]


def _tenant_department_ids(tenant_id: str) -> set[str]:
    return {
        str(department.get("id") or "").strip()
        for department in _tenant_departments(tenant_id)
        if str(department.get("id") or "").strip()
    }


def _bootstrap_org_units(tenant_id: str) -> None:
    """組織が未整備のテナントを、業務領域を手掛かりに初期化する。

    IDは新しく振り、写した業務領域は担当関係として明示的に記録する。IDを流用すると
    紐づいているように見えて実体がない状態になるため、関係はリンクで表す。
    """
    now = datetime.now(timezone.utc).isoformat()
    for index, department in enumerate(_tenant_departments(tenant_id)):
        name = str(department.get("name") or "").strip()
        department_id = str(department.get("id") or "").strip()
        if not name or not department_id:
            continue
        org_unit_id = uuid4().hex[:8]
        runtime.store.save_org_unit(
            OrgUnitRecord(
                id=org_unit_id,
                tenant_id=tenant_id,
                name=name,
                kind="部門",
                sort_order=index,
                updated_at=now,
            ),
            tenant_id,
        )
        runtime.store.save_org_unit_departments(org_unit_id, [department_id], tenant_id)


def _link_org_units_reusing_department_ids(tenant_id: str, units: list[OrgUnitRecord]) -> bool:
    """初期化でIDを流用していた組織へ、担当関係を明示的に補う。"""
    department_ids = _tenant_department_ids(tenant_id)
    repaired = False
    for unit in units:
        if unit.department_ids or unit.id not in department_ids:
            continue
        runtime.store.save_org_unit_departments(unit.id, [unit.id], tenant_id)
        repaired = True
    return repaired


def _tenant_org_units(tenant_id: str) -> list[OrgUnitRecord]:
    """人の所属を表す組織単位。担当する業務領域を多対多で保持する。"""
    units = runtime.store.list_org_units(tenant_id)
    if not units:
        _bootstrap_org_units(tenant_id)
        units = runtime.store.list_org_units(tenant_id)
    elif _link_org_units_reusing_department_ids(tenant_id, units):
        units = runtime.store.list_org_units(tenant_id)
    # 業務領域が削除されると担当関係が残るため、存在するものだけを見せる。
    department_ids = _tenant_department_ids(tenant_id)
    for unit in units:
        unit.department_ids = [
            department_id
            for department_id in unit.department_ids
            if department_id in department_ids
        ]
    return units


def _resolve_org_unit(value: str, tenant_id: str) -> tuple[str, str]:
    """組織単位のIDまたは名前から(ID, 名前)を引く。解決できない場合は空を返す。"""
    target = value.strip()
    if not target:
        return "", ""
    for unit in _tenant_org_units(tenant_id):
        if target in {unit.id, unit.name}:
            return unit.id, unit.name
    return "", ""


def _org_unit_subtree_ids(org_unit_id: str, tenant_id: str) -> list[str]:
    """指定した組織単位と、その配下すべてのIDを返す。

    種別が「全社」の組織は全部門を統括するポジションなので、部門を配下へ
    ぶら下げ直さなくてもテナント内の全組織を範囲に含める。
    """
    units = _tenant_org_units(tenant_id)
    if any(unit.id == org_unit_id and unit.kind == "全社" for unit in units):
        return [org_unit_id, *[unit.id for unit in units if unit.id != org_unit_id]]
    children: dict[str, list[str]] = {}
    for unit in units:
        children.setdefault(unit.parent_id, []).append(unit.id)
    collected: list[str] = []
    pending = [org_unit_id]
    while pending:
        current = pending.pop()
        if current in collected:
            continue
        collected.append(current)
        pending.extend(children.get(current, []))
    return collected


def _user_org_unit_id(user: dict[str, Any], tenant_id: str) -> str:
    """そのテナントでの所属組織。組織はテナントごとに別なので所属も所属先で持つ。"""
    for membership in user.get("tenant_memberships", []):
        if not isinstance(membership, dict) or membership.get("tenant_id") != tenant_id:
            continue
        resolved, _ = _resolve_org_unit(str(membership.get("org_unit_id") or ""), tenant_id)
        if resolved:
            return resolved
    # 移行前の利用者は、テナントを持たないorg_unit_idや部門の値からの解決を試みる。
    for key in ("org_unit_id", "department_id", "department"):
        resolved, _ = _resolve_org_unit(str(user.get(key) or ""), tenant_id)
        if resolved:
            return resolved
    return ""


def _request_user_is_admin(request: Request) -> bool:
    user = getattr(request.state, "user", None)
    return isinstance(user, dict) and str(user.get("role", "")).strip().lower() == "admin"


def _validated_department_ids(department_ids: list[str], tenant_id: str) -> list[str]:
    """担当する業務領域は、業務マスターに存在するIDだけを受け付ける。"""
    known = _tenant_department_ids(tenant_id)
    targets = sorted({value.strip() for value in department_ids if value.strip()})
    unknown = [value for value in targets if value not in known]
    if unknown:
        raise HTTPException(
            status_code=422,
            detail="業務マスターに存在しない業務領域が指定されています: " + ", ".join(unknown),
        )
    return targets


def _ensure_org_unit_parent(parent_id: str, tenant_id: str) -> None:
    if not parent_id.strip():
        return
    if parent_id.strip() not in {unit.id for unit in _tenant_org_units(tenant_id)}:
        raise HTTPException(status_code=422, detail="親の組織が見つかりません。")


def _request_user_email(request: Request) -> str:
    user = getattr(request.state, "user", None)
    email = str(user.get("email", "") if isinstance(user, dict) else "").strip().lower()
    if not email:
        raise HTTPException(status_code=401, detail="ログインが必要です。")
    return email
