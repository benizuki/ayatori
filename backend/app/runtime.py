"""プロセス全体で共有する実行時の状態（保存先、ストア、ヒアリングの記録）。

ルーターは `runtime.store` などを呼び出しのたびに属性として参照する。
テストはこの属性を差し替えて一時DBを使う（`from ..runtime import store` では差し替えが効かない）。"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from threading import Lock

from .core.ai_usage import BurstLimiter
from .core.paths import RUNTIME_DATA_DIR
from .services.business_flow_import import BusinessFlowImportWorker
from .services.tenant_transfer import migrate_legacy_interview_tenants
from .storage.master_data_store import MasterDataStore
from .storage.session_store import discard_blank_interview_sessions, load_interview_sessions
from .storage.sqlite_store import AyatoriSQLiteStore

SESSION_STORE_PATH = Path(
    os.getenv(
        "AYATORI_SESSION_STORE",
        str(RUNTIME_DATA_DIR / "interview-sessions.json"),
    )
)
INTERVIEW_ATTACHMENT_DIR = Path(
    os.getenv(
        "AYATORI_INTERVIEW_ATTACHMENT_DIR",
        str(RUNTIME_DATA_DIR / "interview-attachments"),
    )
)
BUSINESS_FLOW_IMPORT_DIR = Path(
    os.getenv(
        "AYATORI_BUSINESS_FLOW_IMPORT_DIR",
        str(RUNTIME_DATA_DIR / "business-flow-imports"),
    )
)
SQLITE_STORE_PATH = Path(
    os.getenv(
        "AYATORI_SQLITE_PATH",
        str(RUNTIME_DATA_DIR / "ayatori.sqlite"),
    )
)
SQLITE_BACKUP_DIR = Path(
    os.getenv(
        "AYATORI_SQLITE_BACKUP_DIR",
        str(RUNTIME_DATA_DIR / "backups"),
    )
)
MASTER_DATA_DIR = Path(
    os.getenv(
        "AYATORI_MASTER_DATA_DIR",
        str(RUNTIME_DATA_DIR / "master-data"),
    )
)
TIMESTAMP_ONLY_PATTERN = re.compile(r"^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d+)?\s*$")
# APIボディ全体の上限。最大の入力は資料添付のbase64(12MB)なので、その2倍を既定にする。
# リバースプロキシ側の上限が外れていても、アプリだけで巨大ボディを弾けるようにする。
MAX_REQUEST_BYTES = int(os.getenv("AYATORI_MAX_REQUEST_BYTES", str(24 * 1024 * 1024)))
# 未認証で呼べるログインエンドポイントの、IPあたりの1分間の試行回数。
LOGIN_RATE_PER_MINUTE = int(os.getenv("AYATORI_LOGIN_RATE_PER_MINUTE", "10"))
# /api/app-state に保存できるJSONの上限。業務要件に合わせて環境変数で調整する。
MAX_APP_STATE_BYTES = int(os.getenv("AYATORI_MAX_APP_STATE_BYTES", str(4 * 1024 * 1024)))
MAX_APP_STATE_DEPTH = int(os.getenv("AYATORI_MAX_APP_STATE_DEPTH", "64"))
MAX_APP_STATE_NODES = int(os.getenv("AYATORI_MAX_APP_STATE_NODES", "200000"))
MAX_BUSINESS_FLOW_IMPORT_BYTES = int(
    os.getenv("AYATORI_MAX_BUSINESS_FLOW_IMPORT_BYTES", str(50 * 1024 * 1024))
)
SQLITE_BACKUP_ID_PATTERN = re.compile(r"^ayatori-\d{8}T\d{6}\d{6}Z-[a-f0-9]{8}$")


def is_production() -> bool:
    return os.getenv("APP_ENV", "").strip().lower() in {"prod", "production"}


logger = logging.getLogger(__name__)
store = AyatoriSQLiteStore(SQLITE_STORE_PATH)
business_flow_import_worker = BusinessFlowImportWorker(store)
master_data_store = MasterDataStore(MASTER_DATA_DIR)
_ai_burst_limiter = BurstLimiter()
# ログインは未認証で呼べるため、利用者ではなく接続元IPで数える。
_login_limiter = BurstLimiter()
LOGIN_LIMIT_SCOPE = "__login__"
# 認証を無効にした開発モードで記録する擬似利用者。
LOCAL_USAGE_USER = "local"
stored_interview_records = store.load_interview_sessions()
# 正本はSQLite。旧版が書いていた互換JSONは、まだ取り込んでいない記録だけを一度移す（書き込みはしない）。
json_interview_records = load_interview_sessions(SESSION_STORE_PATH)
missing_json_records = {
    session_id: record
    for session_id, record in json_interview_records.items()
    if session_id not in stored_interview_records
}


if missing_json_records:
    stored_interview_records = {**stored_interview_records, **missing_json_records}
    store.save_interview_sessions(stored_interview_records)


stored_interview_records, discarded_blank_interview_ids = discard_blank_interview_sessions(
    stored_interview_records
)


if discarded_blank_interview_ids:
    store.save_interview_sessions(stored_interview_records)
    logger.warning(
        "Blank interview session IDs were removed from persisted history: %s",
        len(discarded_blank_interview_ids),
    )


stored_interview_records, migrated_legacy_interview_ids = migrate_legacy_interview_tenants(
    stored_interview_records,
    store.load_app_states(),
)


if migrated_legacy_interview_ids:
    store.save_interview_sessions(stored_interview_records)
    logger.info(
        "Legacy interview sessions were assigned to tenants: %s",
        ", ".join(migrated_legacy_interview_ids),
    )


interview_sessions = {
    f"{record.session_state.tenant_id}::{record.session_state.session_id}": record.session_state
    for record in stored_interview_records.values()
}
interview_histories = {
    f"{record.session_state.tenant_id}::{record.session_state.session_id}": list(record.messages)
    for record in stored_interview_records.values()
}
interview_updated_at = {
    f"{record.session_state.tenant_id}::{record.session_state.session_id}": record.updated_at
    for record in stored_interview_records.values()
}
session_lock = Lock()
MAX_AUDIO_BYTES = 8 * 1024 * 1024
MIN_AUDIO_BYTES = 8 * 1024
SUPPORTED_AUDIO_MIME_TYPES = {
    "audio/webm",
    "audio/mp4",
    "audio/ogg",
    "audio/wav",
    "audio/x-wav",
    "audio/mpeg",
}
