from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

from ..schemas import (
    InterviewSessionRecord,
    OrgUnitRecord,
    SQLiteDatabaseStatistics,
    SQLiteTableStatistics,
)


class AyatoriSQLiteStore:
    """アプリ状態とヒアリング・日報の保存先。

    問い合わせはすべて主キー検索か絞り込み＋整列で、集計はPython側で行う。
    書き込みはアプリ状態のJSONを繰り返し上書きする形が中心のため、
    ページを再利用するSQLiteを使う。
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        # isolation_level=Noneで暗黙のトランザクションを止め、
        # BEGIN/COMMITを明示している箇所と挙動を揃える。
        connection = sqlite3.connect(str(self.path), isolation_level=None, timeout=30.0)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.execute("PRAGMA busy_timeout=30000")
        return connection

    @contextmanager
    def _connection(self):
        connection = self._connect()
        try:
            yield connection
        finally:
            connection.close()

    @staticmethod
    def _column_names(connection: sqlite3.Connection, table: str) -> set[str]:
        return {
            str(row[1])
            for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
        }

    @staticmethod
    def _table_exists(connection: sqlite3.Connection, table: str) -> bool:
        row = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table,),
        ).fetchone()
        return bool(row)

    def _initialize(self) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS interview_sessions (
                    session_id TEXT PRIMARY KEY,
                    record_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS app_state (
                    state_key TEXT PRIMARY KEY,
                    payload_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            # 利用者ごとの設定（読み上げの声など）。テナントを跨いで同じ人には同じ好みを使う。
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS user_preferences (
                    user_email TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    record_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (user_email, kind)
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS user_interview_preferences_v2 (
                    tenant_id TEXT NOT NULL,
                    user_email TEXT NOT NULL,
                    active_interview_id TEXT,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (tenant_id, user_email)
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS org_units (
                    tenant_id TEXT NOT NULL,
                    id TEXT NOT NULL,
                    parent_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    sort_order INTEGER NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (tenant_id, id)
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS ai_usage (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    tenant_id TEXT NOT NULL,
                    user_email TEXT NOT NULL,
                    feature TEXT NOT NULL,
                    endpoint TEXT NOT NULL,
                    outcome TEXT NOT NULL,
                    duration_ms INTEGER NOT NULL,
                    prompt_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0,
                    total_tokens INTEGER NOT NULL DEFAULT 0,
                    occurred_at TEXT NOT NULL
                )
                """
            )
            # トークン数を後から足したため、既存テーブルには列を追加する。
            usage_columns = self._column_names(connection, "ai_usage")
            for column in ("prompt_tokens", "output_tokens", "total_tokens"):
                if column not in usage_columns:
                    connection.execute(
                        f"ALTER TABLE ai_usage ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0"
                    )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS ai_usage_tenant_time"
                " ON ai_usage (tenant_id, occurred_at)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS ai_usage_tenant_user_time"
                " ON ai_usage (tenant_id, user_email, occurred_at)"
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS business_flow_import_jobs (
                    id TEXT PRIMARY KEY,
                    tenant_id TEXT NOT NULL,
                    owner_email TEXT NOT NULL,
                    department_id TEXT NOT NULL,
                    file_name TEXT NOT NULL,
                    mime_type TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    file_size INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    stage TEXT NOT NULL,
                    progress INTEGER NOT NULL DEFAULT 0,
                    total_pages INTEGER NOT NULL DEFAULT 0,
                    processed_pages INTEGER NOT NULL DEFAULT 0,
                    candidate_count INTEGER NOT NULL DEFAULT 0,
                    error TEXT NOT NULL DEFAULT '',
                    result_json TEXT NOT NULL DEFAULT '[]',
                    cancel_requested INTEGER NOT NULL DEFAULT 0,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS business_flow_import_tenant_time"
                " ON business_flow_import_jobs (tenant_id, created_at DESC)"
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS business_flow_import_chunks (
                    job_id TEXT NOT NULL,
                    chunk_index INTEGER NOT NULL,
                    page_from INTEGER NOT NULL,
                    page_to INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    result_json TEXT NOT NULL DEFAULT '',
                    error TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (job_id, chunk_index),
                    FOREIGN KEY (job_id) REFERENCES business_flow_import_jobs(id) ON DELETE CASCADE
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS org_unit_departments (
                    tenant_id TEXT NOT NULL,
                    org_unit_id TEXT NOT NULL,
                    department_id TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (tenant_id, org_unit_id, department_id)
                )
                """
            )
            if self._table_exists(connection, "user_interview_preferences"):
                # SQLiteはINSERT...SELECTにON CONFLICTを付けると構文が曖昧になるため、
                # 同じ意味のOR IGNOREを使う。
                connection.execute(
                    """
                    INSERT OR IGNORE INTO user_interview_preferences_v2 (
                        tenant_id, user_email, active_interview_id, updated_at
                    )
                    SELECT 'default', user_email, active_interview_id, updated_at
                    FROM user_interview_preferences
                    """
                )

    def create_backup(self, destination: Path) -> None:
        """稼働中のDBから一貫性のあるSQLiteスナップショットを作成する。

        WALファイルを単純にコピーすると、チェックポイントのタイミング次第で復元に
        必要な内容が欠ける。そのためSQLite標準のbackup APIを使い、全ストア書き込みと
        同じロックの中でコピーする。
        """
        destination.parent.mkdir(parents=True, exist_ok=True)
        with self._lock, self._connection() as source:
            target = sqlite3.connect(str(destination), isolation_level=None)
            try:
                source.backup(target)
            finally:
                target.close()
        destination.chmod(0o600)

    def get_database_statistics(self) -> SQLiteDatabaseStatistics:
        """稼働DBのファイル、ページ、テーブル別使用量を読み取り専用で集計する。"""
        with self._lock, self._connection() as connection:
            page_size = int(connection.execute("PRAGMA page_size").fetchone()[0])
            page_count = int(connection.execute("PRAGMA page_count").fetchone()[0])
            freelist_count = int(connection.execute("PRAGMA freelist_count").fetchone()[0])
            journal_mode = str(connection.execute("PRAGMA journal_mode").fetchone()[0]).upper()
            schema_rows = connection.execute(
                """
                SELECT name, type, tbl_name
                FROM sqlite_schema
                WHERE type IN ('table', 'index')
                ORDER BY name
                """
            ).fetchall()
            table_names = [
                str(name)
                for name, object_type, _ in schema_rows
                if object_type == "table" and not str(name).startswith("sqlite_")
            ]
            index_owners = {
                str(name): str(table_name)
                for name, object_type, table_name in schema_rows
                if object_type == "index" and str(table_name) in table_names
            }
            object_sizes: dict[str, int] = {}
            try:
                object_sizes = {
                    str(name): int(size or 0)
                    for name, size in connection.execute(
                        "SELECT name, SUM(pgsize) FROM dbstat GROUP BY name"
                    ).fetchall()
                }
            except sqlite3.OperationalError:
                # dbstatが無効なSQLiteビルドでも、件数とDB全体の統計は表示できる。
                object_sizes = {}

            index_sizes = {name: 0 for name in table_names}
            for index_name, owner in index_owners.items():
                index_sizes[owner] += object_sizes.get(index_name, 0)

            tables: list[SQLiteTableStatistics] = []
            for table_name in table_names:
                quoted_name = table_name.replace('"', '""')
                row_count = int(
                    connection.execute(f'SELECT COUNT(*) FROM "{quoted_name}"').fetchone()[0]
                )
                table_bytes = object_sizes.get(table_name, 0)
                index_bytes = index_sizes[table_name]
                tables.append(
                    SQLiteTableStatistics(
                        name=table_name,
                        row_count=row_count,
                        table_bytes=table_bytes,
                        index_bytes=index_bytes,
                        total_bytes=table_bytes + index_bytes,
                    )
                )

        wal_path = Path(f"{self.path}-wal")
        shm_path = Path(f"{self.path}-shm")
        database_stat = self.path.stat() if self.path.is_file() else None
        wal_stat = wal_path.stat() if wal_path.is_file() else None
        shm_stat = shm_path.stat() if shm_path.is_file() else None
        database_bytes = database_stat.st_size if database_stat else 0
        wal_bytes = wal_stat.st_size if wal_stat else 0
        shm_bytes = shm_stat.st_size if shm_stat else 0
        allocated_bytes = page_count * page_size
        unused_bytes = freelist_count * page_size
        logical_used_bytes = max(0, allocated_bytes - unused_bytes)
        usage_percent = (
            round(logical_used_bytes / allocated_bytes * 100, 1) if allocated_bytes else 0.0
        )
        tables.sort(key=lambda item: (-item.total_bytes, -item.row_count, item.name))
        modified_timestamps = [item.st_mtime for item in (database_stat, wal_stat) if item]
        modified_at = datetime.fromtimestamp(
            max(modified_timestamps, default=datetime.now(timezone.utc).timestamp()),
            timezone.utc,
        ).isoformat()
        return SQLiteDatabaseStatistics(
            database_filename=self.path.name,
            journal_mode=journal_mode,
            last_modified_at=modified_at,
            database_bytes=database_bytes,
            wal_bytes=wal_bytes,
            shm_bytes=shm_bytes,
            active_files_bytes=database_bytes + wal_bytes + shm_bytes,
            allocated_bytes=allocated_bytes,
            logical_used_bytes=logical_used_bytes,
            unused_bytes=unused_bytes,
            usage_percent=usage_percent,
            total_records=sum(item.row_count for item in tables),
            table_count=len(tables),
            backup_bytes=0,
            backup_count=0,
            tables=tables,
        )

    @staticmethod
    def _business_flow_import_from_row(row: tuple[Any, ...]) -> dict[str, Any]:
        keys = (
            "id", "tenant_id", "owner_email", "department_id", "file_name", "mime_type",
            "file_path", "file_size", "status", "stage", "progress", "total_pages",
            "processed_pages", "candidate_count", "error", "result_json",
            "cancel_requested", "attempts", "created_at", "updated_at",
        )
        record = dict(zip(keys, row, strict=True))
        try:
            record["candidates"] = json.loads(str(record.pop("result_json") or "[]"))
        except json.JSONDecodeError:
            record["candidates"] = []
        record["cancel_requested"] = bool(record["cancel_requested"])
        return record

    def create_business_flow_import(self, record: dict[str, Any]) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                """
                INSERT INTO business_flow_import_jobs (
                    id, tenant_id, owner_email, department_id, file_name, mime_type,
                    file_path, file_size, status, stage, progress, total_pages,
                    processed_pages, candidate_count, error, result_json,
                    cancel_requested, attempts, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
                """,
                (
                    record["id"], record["tenant_id"], record["owner_email"],
                    record["department_id"], record["file_name"], record["mime_type"],
                    record["file_path"], record["file_size"], "queued", "受付済み", 0, 0,
                    0, 0, "", "[]", record["created_at"], record["created_at"],
                ),
            )

    def get_business_flow_import(self, job_id: str, tenant_id: str = "") -> dict[str, Any] | None:
        sql = "SELECT * FROM business_flow_import_jobs WHERE id = ?"
        params: tuple[str, ...] = (job_id,)
        if tenant_id:
            sql += " AND tenant_id = ?"
            params += (tenant_id.strip().lower(),)
        with self._lock, self._connection() as connection:
            row = connection.execute(sql, params).fetchone()
        return self._business_flow_import_from_row(row) if row else None

    def list_business_flow_imports(self, tenant_id: str, limit: int = 20) -> list[dict[str, Any]]:
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                """
                SELECT * FROM business_flow_import_jobs
                WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?
                """,
                (tenant_id.strip().lower(), max(1, min(100, limit))),
            ).fetchall()
        return [self._business_flow_import_from_row(row) for row in rows]

    def update_business_flow_import(self, job_id: str, **updates: Any) -> None:
        allowed = {
            "status", "stage", "progress", "total_pages", "processed_pages",
            "candidate_count", "error", "cancel_requested", "attempts",
        }
        values = {key: value for key, value in updates.items() if key in allowed}
        if "candidates" in updates:
            values["result_json"] = json.dumps(updates["candidates"], ensure_ascii=False)
        if not values:
            return
        values["updated_at"] = datetime.now(timezone.utc).isoformat()
        assignments = ", ".join(f"{key} = ?" for key in values)
        with self._lock, self._connection() as connection:
            connection.execute(
                f"UPDATE business_flow_import_jobs SET {assignments} WHERE id = ?",
                (*values.values(), job_id),
            )

    def claim_business_flow_import(self) -> dict[str, Any] | None:
        """待機ジョブを1件だけ取得し、同時ワーカーによる二重実行を防ぐ。"""
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                row = connection.execute(
                    "SELECT * FROM business_flow_import_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1"
                ).fetchone()
                if not row:
                    connection.execute("COMMIT")
                    return None
                job_id = str(row[0])
                connection.execute(
                    """
                    UPDATE business_flow_import_jobs
                    SET status = 'preprocessing', stage = 'ファイルを確認中',
                        attempts = attempts + 1, updated_at = ?
                    WHERE id = ? AND status = 'queued'
                    """,
                    (now, job_id),
                )
                claimed = connection.execute(
                    "SELECT * FROM business_flow_import_jobs WHERE id = ?",
                    (job_id,),
                ).fetchone()
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise
        return self._business_flow_import_from_row(claimed) if claimed else None

    def recover_business_flow_imports(self) -> int:
        """再起動で中断した処理をキューへ戻す。完了済みチャンクは再利用する。"""
        active = ("preprocessing", "classifying", "extracting", "assembling", "committing")
        placeholders = ",".join("?" for _ in active)
        with self._lock, self._connection() as connection:
            cursor = connection.execute(
                f"""
                UPDATE business_flow_import_jobs
                SET status = 'queued', stage = '再開待ち', updated_at = ?
                WHERE status IN ({placeholders}) AND cancel_requested = 0
                """,
                (datetime.now(timezone.utc).isoformat(), *active),
            )
        return cursor.rowcount

    def upsert_business_flow_import_chunk(
        self,
        job_id: str,
        chunk_index: int,
        page_from: int,
        page_to: int,
        *,
        status: str,
        result: dict[str, Any] | None = None,
        error: str = "",
    ) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                """
                INSERT INTO business_flow_import_chunks (
                    job_id, chunk_index, page_from, page_to, status, attempts,
                    result_json, error, updated_at
                ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
                ON CONFLICT (job_id, chunk_index) DO UPDATE SET
                    page_from = excluded.page_from,
                    page_to = excluded.page_to,
                    status = excluded.status,
                    attempts = business_flow_import_chunks.attempts + 1,
                    result_json = excluded.result_json,
                    error = excluded.error,
                    updated_at = excluded.updated_at
                """,
                (
                    job_id, chunk_index, page_from, page_to, status,
                    json.dumps(result, ensure_ascii=False) if result is not None else "",
                    error, datetime.now(timezone.utc).isoformat(),
                ),
            )

    def list_business_flow_import_chunks(self, job_id: str) -> list[dict[str, Any]]:
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                """
                SELECT chunk_index, page_from, page_to, status, attempts, result_json, error
                FROM business_flow_import_chunks WHERE job_id = ? ORDER BY chunk_index
                """,
                (job_id,),
            ).fetchall()
        chunks = []
        for index, page_from, page_to, status, attempts, result_json, error in rows:
            try:
                result = json.loads(result_json) if result_json else None
            except json.JSONDecodeError:
                result = None
            chunks.append({
                "chunk_index": index, "page_from": page_from, "page_to": page_to,
                "status": status, "attempts": attempts, "result": result, "error": error,
            })
        return chunks

    def load_interview_sessions(self) -> dict[str, InterviewSessionRecord]:
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                "SELECT session_id, record_json FROM interview_sessions"
            ).fetchall()
        sessions: dict[str, InterviewSessionRecord] = {}
        for session_id, record_json in rows:
            payload = json.loads(record_json) if isinstance(record_json, str) else record_json
            sessions[str(session_id)] = InterviewSessionRecord.model_validate(payload)
        return sessions

    def save_interview_sessions(self, sessions: dict[str, InterviewSessionRecord]) -> None:
        rows = [
            (
                session_id,
                json.dumps(record.model_dump(mode="json"), ensure_ascii=False),
                record.updated_at,
            )
            for session_id, record in sessions.items()
        ]
        with self._lock, self._connection() as connection:
            connection.execute("BEGIN")
            try:
                connection.execute("DELETE FROM interview_sessions")
                if rows:
                    connection.executemany(
                        """
                        INSERT INTO interview_sessions (session_id, record_json, updated_at)
                        VALUES (?, ?, ?)
                        """,
                        rows,
                    )
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def load_app_state(self, tenant_id: str = "default") -> dict[str, Any]:
        with self._lock, self._connection() as connection:
            row = connection.execute(
                "SELECT payload_json FROM app_state WHERE state_key = ?",
                (tenant_id.strip().lower(),),
            ).fetchone()
        if not row:
            return {}
        payload = row[0]
        return json.loads(payload) if isinstance(payload, str) else payload

    def load_app_states(self) -> dict[str, dict[str, Any]]:
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                "SELECT state_key, payload_json FROM app_state"
            ).fetchall()
        return {
            str(tenant_id).strip().lower(): (
                json.loads(payload) if isinstance(payload, str) else payload
            )
            for tenant_id, payload in rows
        }

    def save_app_state(
        self,
        payload: dict[str, Any],
        updated_at: str,
        tenant_id: str = "default",
    ) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                """
                INSERT INTO app_state (state_key, payload_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT (state_key) DO UPDATE SET
                    payload_json = excluded.payload_json,
                    updated_at = excluded.updated_at
                """,
                (tenant_id.strip().lower(), json.dumps(payload, ensure_ascii=False), updated_at),
            )

    def save_app_states(
        self,
        states: dict[str, dict[str, Any]],
        updated_at: str,
    ) -> None:
        rows = [
            (
                tenant_id.strip().lower(),
                json.dumps(payload, ensure_ascii=False),
                updated_at,
            )
            for tenant_id, payload in states.items()
        ]
        with self._lock, self._connection() as connection:
            connection.execute("BEGIN")
            try:
                connection.executemany(
                    """
                    INSERT INTO app_state (state_key, payload_json, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT (state_key) DO UPDATE SET
                        payload_json = excluded.payload_json,
                        updated_at = excluded.updated_at
                    """,
                    rows,
                )
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def get_user_preference(self, user_email: str, kind: str) -> dict[str, Any] | None:
        with self._lock, self._connection() as connection:
            row = connection.execute(
                "SELECT record_json FROM user_preferences WHERE user_email = ? AND kind = ?",
                (user_email.strip().lower(), kind),
            ).fetchone()
        return json.loads(row[0]) if row else None

    def save_user_preference(self, user_email: str, kind: str, record: dict[str, Any]) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                """
                INSERT INTO user_preferences (user_email, kind, record_json, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(user_email, kind) DO UPDATE SET
                    record_json = excluded.record_json,
                    updated_at = excluded.updated_at
                """,
                (
                    user_email.strip().lower(),
                    kind,
                    json.dumps(record, ensure_ascii=False),
                    datetime.now(timezone.utc).isoformat(),
                ),
            )

    def load_user_interview_preference(
        self,
        user_email: str,
        tenant_id: str = "default",
    ) -> dict[str, str | None]:
        with self._lock, self._connection() as connection:
            row = connection.execute(
                """
                SELECT active_interview_id, updated_at
                FROM user_interview_preferences_v2
                WHERE tenant_id = ? AND user_email = ?
                """,
                (tenant_id.strip().lower(), user_email.strip().lower()),
            ).fetchone()
        if not row:
            return {"active_interview_id": None, "updated_at": ""}
        return {"active_interview_id": row[0], "updated_at": row[1]}

    def save_user_interview_preference(
        self,
        user_email: str,
        active_interview_id: str | None,
        updated_at: str,
        tenant_id: str = "default",
    ) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                """
                INSERT INTO user_interview_preferences_v2 (
                    tenant_id, user_email, active_interview_id, updated_at
                )
                VALUES (?, ?, ?, ?)
                ON CONFLICT (tenant_id, user_email) DO UPDATE SET
                    active_interview_id = excluded.active_interview_id,
                    updated_at = excluded.updated_at
                """,
                (
                    tenant_id.strip().lower(),
                    user_email.strip().lower(),
                    active_interview_id,
                    updated_at,
                ),
            )

    def list_org_units(self, tenant_id: str = "default") -> list[OrgUnitRecord]:
        normalized = tenant_id.strip().lower()
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                "SELECT id, parent_id, name, kind, sort_order, updated_at FROM org_units"
                " WHERE tenant_id = ? ORDER BY sort_order, name",
                (normalized,),
            ).fetchall()
            links = connection.execute(
                "SELECT org_unit_id, department_id FROM org_unit_departments"
                " WHERE tenant_id = ? ORDER BY department_id",
                (normalized,),
            ).fetchall()
        departments_by_unit: dict[str, list[str]] = {}
        for org_unit_id, department_id in links:
            departments_by_unit.setdefault(str(org_unit_id), []).append(str(department_id))
        return [
            OrgUnitRecord(
                id=str(identifier),
                tenant_id=normalized,
                parent_id=str(parent_id or ""),
                name=str(name),
                kind=str(kind),  # type: ignore[arg-type]
                sort_order=int(sort_order or 0),
                department_ids=departments_by_unit.get(str(identifier), []),
                updated_at=str(updated_at or ""),
            )
            for identifier, parent_id, name, kind, sort_order, updated_at in rows
        ]

    def save_org_unit_departments(
        self,
        org_unit_id: str,
        department_ids: list[str],
        tenant_id: str = "default",
    ) -> list[str]:
        """組織単位が担当する業務領域を置き換える。"""
        normalized = tenant_id.strip().lower()
        targets = sorted({value.strip() for value in department_ids if value.strip()})
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._connection() as connection:
            connection.execute(
                "DELETE FROM org_unit_departments WHERE tenant_id = ? AND org_unit_id = ?",
                (normalized, org_unit_id.strip()),
            )
            for department_id in targets:
                connection.execute(
                    """
                    INSERT INTO org_unit_departments (
                        tenant_id, org_unit_id, department_id, updated_at
                    )
                    VALUES (?, ?, ?, ?)
                    """,
                    (normalized, org_unit_id.strip(), department_id, now),
                )
        return targets

    def save_org_unit(self, record: OrgUnitRecord, tenant_id: str = "default") -> OrgUnitRecord:
        with self._lock, self._connection() as connection:
            connection.execute(
                """
                INSERT INTO org_units (
                    tenant_id, id, parent_id, name, kind, sort_order, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (tenant_id, id) DO UPDATE SET
                    parent_id = excluded.parent_id,
                    name = excluded.name,
                    kind = excluded.kind,
                    sort_order = excluded.sort_order,
                    updated_at = excluded.updated_at
                """,
                (
                    tenant_id.strip().lower(),
                    record.id,
                    record.parent_id,
                    record.name,
                    record.kind,
                    record.sort_order,
                    record.updated_at,
                ),
            )
        return record

    def delete_org_unit(self, org_unit_id: str, tenant_id: str = "default") -> bool:
        normalized = tenant_id.strip().lower()
        with self._lock, self._connection() as connection:
            cursor = connection.execute(
                "DELETE FROM org_units WHERE tenant_id = ? AND id = ?",
                (normalized, org_unit_id.strip()),
            )
            deleted = cursor.rowcount > 0
            # 担当関係を残すと、次に同じIDが割り当たったときに紛れ込む。
            connection.execute(
                "DELETE FROM org_unit_departments WHERE tenant_id = ? AND org_unit_id = ?",
                (normalized, org_unit_id.strip()),
            )
        return deleted

    def record_ai_usage(
        self,
        *,
        tenant_id: str,
        user_email: str,
        feature: str,
        endpoint: str,
        outcome: str,
        duration_ms: int,
        occurred_at: str,
        prompt_tokens: int = 0,
        output_tokens: int = 0,
        total_tokens: int = 0,
    ) -> None:
        """AI呼び出し1件を記録する。利用状況の可視化と1日あたりの上限判定に使う。"""
        with self._lock, self._connection() as connection:
            connection.execute(
                """
                INSERT INTO ai_usage (
                    tenant_id, user_email, feature, endpoint, outcome, duration_ms,
                    prompt_tokens, output_tokens, total_tokens, occurred_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    tenant_id.strip().lower(),
                    user_email.strip().lower(),
                    feature,
                    endpoint,
                    outcome,
                    max(0, int(duration_ms)),
                    max(0, int(prompt_tokens)),
                    max(0, int(output_tokens)),
                    max(0, int(total_tokens)),
                    occurred_at,
                ),
            )

    def count_ai_usage_since(
        self,
        *,
        tenant_id: str,
        user_email: str,
        since: str,
    ) -> int:
        """1日あたりの上限判定。プロセスをまたいで数えるためDBで数える。"""
        with self._lock, self._connection() as connection:
            row = connection.execute(
                """
                SELECT COUNT(*) FROM ai_usage
                WHERE tenant_id = ? AND user_email = ? AND occurred_at >= ? AND outcome != 'rate-limited'
                """,
                (tenant_id.strip().lower(), user_email.strip().lower(), since),
            ).fetchone()
        return int(row[0]) if row else 0

    def summarize_ai_usage(
        self,
        *,
        tenant_id: str,
        date_from: str,
        date_to: str,
        user_email: str = "",
    ) -> dict[str, list[tuple]]:
        """利用状況の集計。利用者別・機能別・日別をそれぞれ返す。"""
        clauses = ["tenant_id = ?", "occurred_at >= ?", "occurred_at < ?"]
        parameters: list[str] = [tenant_id.strip().lower(), date_from, date_to]
        if user_email.strip():
            clauses.append("user_email = ?")
            parameters.append(user_email.strip().lower())
        where = " AND ".join(clauses)
        with self._lock, self._connection() as connection:
            by_user = connection.execute(
                f"""
                SELECT user_email, COUNT(*), SUM(duration_ms),
                       SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END),
                       SUM(CASE WHEN outcome = 'rate-limited' THEN 1 ELSE 0 END),
                       SUM(prompt_tokens), SUM(output_tokens), SUM(total_tokens)
                FROM ai_usage WHERE {where}
                GROUP BY user_email ORDER BY COUNT(*) DESC
                """,
                parameters,
            ).fetchall()
            by_feature = connection.execute(
                f"SELECT feature, COUNT(*), SUM(duration_ms), SUM(total_tokens)"
                f" FROM ai_usage WHERE {where} GROUP BY feature ORDER BY COUNT(*) DESC",
                parameters,
            ).fetchall()
            by_day = connection.execute(
                f"SELECT substr(occurred_at, 1, 10) AS day, COUNT(*), SUM(total_tokens)"
                f" FROM ai_usage WHERE {where} GROUP BY day ORDER BY day",
                parameters,
            ).fetchall()
        return {"by_user": by_user, "by_feature": by_feature, "by_day": by_day}

    def prune_ai_usage(self, *, before: str) -> int:
        """保存期間を過ぎた記録を消す。件数の記録なので長期保持する必要はない。"""
        with self._lock, self._connection() as connection:
            cursor = connection.execute("DELETE FROM ai_usage WHERE occurred_at < ?", (before,))
            return cursor.rowcount
