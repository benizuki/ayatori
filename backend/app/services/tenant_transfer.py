from __future__ import annotations

from copy import deepcopy
from typing import Any

from ..schemas import InterviewSessionRecord


class DepartmentTransferError(ValueError):
    pass


ARRAY_COLLECTION_KEYS = (
    "interviewSessions",
    "workFragments",
    "businessMasters",
)


def migrate_legacy_interview_tenants(
    records: dict[str, InterviewSessionRecord],
    app_states: dict[str, dict[str, Any]],
) -> tuple[dict[str, InterviewSessionRecord], list[str]]:
    """Move legacy default-tenant conversations when app state has one clear owner."""
    owners_by_session: dict[str, set[str]] = {}
    for tenant_id, payload in app_states.items():
        normalized_tenant_id = tenant_id.strip().lower()
        for session in _dict_items(payload.get("interviewSessions")):
            session_id = str(session.get("id") or "").strip()
            if session_id:
                owners_by_session.setdefault(session_id, set()).add(normalized_tenant_id)

    migrated_session_ids: list[str] = []
    canonical_records: dict[str, InterviewSessionRecord] = {}
    for record in records.values():
        state = record.session_state
        tenant_id = state.tenant_id.strip().lower() or "default"
        owners = owners_by_session.get(state.session_id, set())
        if tenant_id == "default" and len(owners) == 1:
            inferred_tenant_id = next(iter(owners))
            if inferred_tenant_id != "default":
                tenant_id = inferred_tenant_id
                state.tenant_id = inferred_tenant_id
                migrated_session_ids.append(state.session_id)

        storage_key = f"{tenant_id}::{state.session_id}"
        existing = canonical_records.get(storage_key)
        if existing is None or (
            len(record.messages),
            record.updated_at,
        ) > (
            len(existing.messages),
            existing.updated_at,
        ):
            canonical_records[storage_key] = record

    return canonical_records, sorted(set(migrated_session_ids))


def move_department_payloads(
    source_payload: dict[str, Any],
    target_payload: dict[str, Any],
    department_id: str,
    target_tenant_id: str,
) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
    source = deepcopy(source_payload)
    target = deepcopy(target_payload)
    source_departments = _dict_items(source.get("departments"))
    department = next(
        (item for item in source_departments if str(item.get("id")) == department_id),
        None,
    )
    if department is None:
        raise DepartmentTransferError("部門が現在のテナントに見つかりません。")
    if len(source_departments) <= 1:
        raise DepartmentTransferError("最後の1部門は別テナントへ移動できません。")

    target_departments = _dict_items(target.get("departments"))
    if any(str(item.get("id")) == department_id for item in target_departments):
        raise DepartmentTransferError("移管先テナントに同じ部門IDが既に存在します。")

    moved_department = {**department, "tenantId": target_tenant_id}
    source["departments"] = [
        item for item in source_departments if str(item.get("id")) != department_id
    ]
    target["departments"] = [*target_departments, moved_department]

    moved_interview_ids: list[str] = []
    moved_business_ids: set[str] = set()
    for key in ARRAY_COLLECTION_KEYS:
        source_items = _dict_items(source.get(key))
        moved_items = [
            item
            for item in source_items
            if str(item.get("departmentId")) == department_id
        ]
        retained_items = [
            item
            for item in source_items
            if str(item.get("departmentId")) != department_id
        ]
        target_items = _dict_items(target.get(key))
        _assert_no_id_conflicts(key, moved_items, target_items)
        source[key] = retained_items
        target[key] = [*target_items, *moved_items]
        if key == "interviewSessions":
            moved_interview_ids = [
                str(item.get("id"))
                for item in moved_items
                if str(item.get("id") or "").strip()
            ]
        if key == "businessMasters":
            moved_business_ids.update(
                str(item.get("id"))
                for item in moved_items
                if str(item.get("id") or "").strip()
            )

    source_models = _dict_map(source.get("processModels"))
    moved_models = {
        key: value
        for key, value in source_models.items()
        if str(value.get("departmentId")) == department_id or key in moved_business_ids
    }
    target_models = _dict_map(target.get("processModels"))
    model_conflicts = sorted(set(moved_models) & set(target_models))
    if model_conflicts:
        raise DepartmentTransferError(
            f"移管先に同じAs-Is IDが存在します: {', '.join(model_conflicts)}"
        )
    source["processModels"] = {
        key: value for key, value in source_models.items() if key not in moved_models
    }
    target["processModels"] = {**target_models, **moved_models}

    version_ids = set(moved_models) | moved_business_ids
    source_versions = _dict_map_any(source.get("processVersions"))
    moved_versions = {
        key: value for key, value in source_versions.items() if key in version_ids
    }
    target_versions = _dict_map_any(target.get("processVersions"))
    version_conflicts = sorted(set(moved_versions) & set(target_versions))
    if version_conflicts:
        raise DepartmentTransferError(
            f"移管先に同じ版管理IDが存在します: {', '.join(version_conflicts)}"
        )
    source["processVersions"] = {
        key: value for key, value in source_versions.items() if key not in moved_versions
    }
    target["processVersions"] = {**target_versions, **moved_versions}

    return source, target, moved_interview_ids


def _dict_items(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _dict_map(value: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict):
        return {}
    return {
        str(key): item
        for key, item in value.items()
        if isinstance(item, dict)
    }


def _dict_map_any(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return {str(key): item for key, item in value.items()}


def _assert_no_id_conflicts(
    collection_name: str,
    moved_items: list[dict[str, Any]],
    target_items: list[dict[str, Any]],
) -> None:
    moved_ids = {
        str(item.get("id"))
        for item in moved_items
        if str(item.get("id") or "").strip()
    }
    target_ids = {
        str(item.get("id"))
        for item in target_items
        if str(item.get("id") or "").strip()
    }
    conflicts = sorted(moved_ids & target_ids)
    if conflicts:
        raise DepartmentTransferError(
            f"移管先の{collection_name}に同じIDが存在します: {', '.join(conflicts)}"
        )
