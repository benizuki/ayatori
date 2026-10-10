"""テナントごとのアプリ状態（業務マスターはマスターファイルへ振り分ける）。"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from .. import runtime
from ..runtime import MAX_APP_STATE_BYTES, MAX_APP_STATE_DEPTH, MAX_APP_STATE_NODES
from ..resources.sample_processes import sample_process_models
from ..schemas import AppStateRecord
from ..storage.master_data_store import MASTER_DATA_KEYS
from .common import _request_tenant_id

router = APIRouter()


def _assert_app_state_within_limits(payload: dict[str, Any]) -> None:
    """アプリ状態の総量を制限する。

    payloadは任意のJSONを受けるため、上限が無いと正規利用者でもSQLite容量と
    読み書き時間をいくらでも消費できてしまう。深さと要素数はシリアライズ前に
    数え、再帰やメモリを先に使い切らないようにする。
    """
    stack: list[tuple[Any, int]] = [(payload, 1)]
    nodes = 0
    while stack:
        node, depth = stack.pop()
        if depth > MAX_APP_STATE_DEPTH:
            raise HTTPException(status_code=413, detail="アプリ状態のネストが深すぎます。")
        if isinstance(node, dict):
            children: Any = node.values()
        elif isinstance(node, list):
            children = node
        else:
            continue
        nodes += len(node)
        if nodes > MAX_APP_STATE_NODES:
            raise HTTPException(status_code=413, detail="アプリ状態の要素数が多すぎます。")
        stack.extend((child, depth + 1) for child in children)
    try:
        size = len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="アプリ状態を保存できる形式ではありません。") from exc
    if size > MAX_APP_STATE_BYTES:
        raise HTTPException(status_code=413, detail="アプリ状態のデータ量が上限を超えています。")


@router.get("/api/app-state", response_model=AppStateRecord)
def get_app_state(request: Request) -> AppStateRecord:
    tenant_id = _request_tenant_id(request)
    stored_payload = runtime.store.load_app_state(tenant_id)
    payload = runtime.master_data_store.merge_into_app_state(
        stored_payload,
        tenant_id,
    )
    if not stored_payload:
        # まだ保存したことのないテナントには、同梱の業務マスターに合わせたサンプルのAs-Isを渡す。
        # 保存はしない。画面が最初に保存した時点で、そのテナントのデータになる。
        business_masters = payload.get("businessMasters")
        payload["processModels"] = sample_process_models(
            business_masters if isinstance(business_masters, list) else []
        )
    updated_at = str(payload.get("updatedAt", "")) if isinstance(payload, dict) else ""
    if any(key in stored_payload for key in MASTER_DATA_KEYS):
        operational_state, master_data = runtime.master_data_store.split_from_app_state(
            payload,
            tenant_id,
        )
        updated_at = updated_at or datetime.now(timezone.utc).isoformat()
        operational_state["updatedAt"] = updated_at
        runtime.store.save_app_state(operational_state, updated_at, tenant_id)
        payload = {**operational_state, **master_data}
    return AppStateRecord(payload=payload, updated_at=updated_at)


@router.put("/api/app-state", response_model=AppStateRecord)
def put_app_state(record: AppStateRecord, request: Request) -> AppStateRecord:
    _assert_app_state_within_limits(record.payload)
    tenant_id = _request_tenant_id(request)
    updated_at = datetime.now(timezone.utc).isoformat()
    operational_state, master_data = runtime.master_data_store.split_from_app_state(
        record.payload,
        tenant_id,
    )
    operational_state = {**operational_state, "updatedAt": updated_at}
    runtime.store.save_app_state(operational_state, updated_at, tenant_id)
    payload = {**operational_state, **master_data}
    return AppStateRecord(payload=payload, updated_at=updated_at)
