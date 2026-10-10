"""FastAPIアプリの組み立て。各APIは api/ のルーター、共有の状態は runtime にある。"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import runtime
from .api import (
    ai_usage_api,
    app_state_api,
    auth_api,
    backups_api,
    frontend_api,
    imports_api,
    interviews_api,
    user_preferences_api,
    org_units_api,
    process_api,
    settings_api,
    system_api,
    tenants_api,
    users_api,
)
from .api.common import _resolve_org_unit
from .api.middleware import _prune_ai_usage, allowed_origins, authorize_api_requests
from .core.auth import (
    ensure_auth_secret,
    ensure_user_master,
    list_user_master_entries,
    migrate_system_roles,
    update_user_master_entry,
    validate_auth_configuration,
)
from .core.security_headers import SecurityHeadersMiddleware
from .runtime import is_production

logger = logging.getLogger(__name__)


def _backfill_membership_org_units() -> None:
    """テナントを持たない旧いorg_unit_idを、その組織があるテナントの所属へ移す。"""
    moved = 0
    for entry in list_user_master_entries():
        legacy = str(entry.get("org_unit_id") or "").strip()
        if not legacy:
            continue
        memberships = [dict(membership) for membership in entry.get("tenant_memberships", [])]
        changed = False
        for membership in memberships:
            if membership.get("org_unit_id"):
                continue
            resolved, _ = _resolve_org_unit(legacy, str(membership.get("tenant_id") or ""))
            if resolved:
                membership["org_unit_id"] = resolved
                changed = True
        if not changed:
            # どのテナントにも無い組織は、手掛かりとして残したまま画面で設定し直してもらう。
            continue
        update_user_master_entry(entry["email"], {
            **entry,
            "tenant_memberships": memberships,
            "org_unit_id": None,
        })
        moved += 1
    if moved:
        logger.info("Moved organization units into tenant memberships for %s users", moved)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    validate_auth_configuration()
    ensure_user_master()
    ensure_auth_secret()
    migrate_system_roles()
    _backfill_membership_org_units()
    _prune_ai_usage()
    runtime.business_flow_import_worker.start()
    try:
        yield
    finally:
        runtime.business_flow_import_worker.stop()


app = FastAPI(
    title="Ayatori API",
    version="0.1.0",
    lifespan=lifespan,
    # 本番では保護APIを含む全スキーマを未認証で公開しないよう、API仕様を配信しない。
    docs_url=None if is_production() else "/docs",
    redoc_url=None if is_production() else "/redoc",
    openapi_url=None if is_production() else "/openapi.json",
)

# 画面を返す受け口（/{full_path:path}）より先に登録し、APIが先に解決されるようにする。
for router_module in (
    settings_api,
    system_api,
    backups_api,
    auth_api,
    tenants_api,
    users_api,
    interviews_api,
    user_preferences_api,
    app_state_api,
    ai_usage_api,
    process_api,
    org_units_api,
    imports_api,
    frontend_api,
):
    app.include_router(router_module.router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["*"],
)
app.add_middleware(SecurityHeadersMiddleware)
# 最後に足したミドルウェアが最も外側で動く。Host・Origin・認証の検査を最初に通す。
app.middleware("http")(authorize_api_requests)
