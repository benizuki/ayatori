from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import HTTPException

from .paths import RUNTIME_DATA_DIR

# テナント内のロールは3種類。
#   admin   … そのテナントの管理（ユーザー・組織・マスター）
#   user    … 自分の担当範囲を編集
#   viewer  … 閲覧のみ
# 保存済みの不明なロール（旧版のmanagerなど）は_normalize_roleでuserとして扱う。
Role = Literal["admin", "user", "viewer"]
# システムロールはテナントを跨いだ権限で3種類。
#   admin  … 全テナントのテナント管理・ユーザー管理・組織マスター・業務マスターを操作
#   viewer … 上記を全テナント横断で閲覧のみ
#   none   … システム権限なし。所属テナントの権限だけで動く
SystemRole = Literal["none", "admin", "viewer"]
VALID_ROLES = {"admin", "user", "viewer"}
VALID_SYSTEM_ROLES = {"none", "admin", "viewer"}
DEFAULT_TOKEN_TTL_SECONDS = 12 * 60 * 60
# 正常なトークンは1KB未満。これを超える入力は検証せずに弾く。
MAX_AUTH_TOKEN_LENGTH = 4096
LOCAL_UNAUTHENTICATED_HOST = "127.0.0.1"
AUTH_COOKIE_NAME = "ayatori_auth"

AUTH_DIR = Path(os.getenv("AYATORI_AUTH_DIR", str(RUNTIME_DATA_DIR / "auth")))
USER_MASTER_FILE = AUTH_DIR / "user_master.json"
TENANT_MASTER_FILE = AUTH_DIR / "tenant_master.json"
MIGRATION_STATE_FILE = AUTH_DIR / "migrations.json"
# お試しログインで APP_AUTH_SECRET が未設定のとき、初回に生成して保存する署名鍵。
AUTH_SECRET_FILE = AUTH_DIR / "app_auth_secret"
SYSTEM_ROLE_MIGRATION_KEY = "system_roles_admin_viewer_none"
DEFAULT_TENANT_ID = "default"
GOOGLE_TOKEN_CLOCK_SKEW_SECONDS = 30
logger = logging.getLogger(__name__)


def ensure_user_master() -> None:
  AUTH_DIR.mkdir(parents=True, exist_ok=True)
  if not USER_MASTER_FILE.exists():
    USER_MASTER_FILE.write_text("[]", encoding="utf-8")
  if not TENANT_MASTER_FILE.exists():
    now = datetime.now(timezone.utc).isoformat()
    TENANT_MASTER_FILE.write_text(
      json.dumps([{
        "id": DEFAULT_TENANT_ID,
        "name": "既定テナント",
        "description": "既存データを引き継ぐ既定のテナントです。",
        "enabled": True,
        "created_at": now,
        "updated_at": now,
      }], ensure_ascii=False, indent=2),
      encoding="utf-8",
    )


def _migration_state() -> dict[str, Any]:
  if not MIGRATION_STATE_FILE.exists():
    return {}
  try:
    state = json.loads(MIGRATION_STATE_FILE.read_text(encoding="utf-8"))
  except json.JSONDecodeError:
    return {}
  return state if isinstance(state, dict) else {}


def migrate_system_roles() -> None:
  """システムロールを admin/viewer/none の3種へ寄せる一度きりの移行。

  旧モデルの user と viewer はシステム権限を持たなかったため、新しい viewer
  （全テナント閲覧）へ繰り上げずに none とする。全テナントを閲覧させたい利用者は
  移行後にシステム管理者が viewer を付け直す。テナントの所属は失わないよう、
  ロールを書き換える前に当時のロールから所属を確定させる。
  """
  state = _migration_state()
  if state.get(SYSTEM_ROLE_MIGRATION_KEY):
    return
  rows = _load_rows()
  changed = False
  for index, row in enumerate(rows):
    if not isinstance(row, dict):
      continue
    stored_role = str(row.get("role") or "").strip().lower()
    if stored_role not in {"user", "viewer"}:
      continue
    memberships = row.get("tenant_memberships")
    if not isinstance(memberships, list):
      memberships = [{"tenant_id": DEFAULT_TENANT_ID, "role": _normalize_role(stored_role)}]
    rows[index] = {**row, "role": "none", "tenant_memberships": memberships}
    changed = True
  if changed:
    _save_rows(rows)
    logger.info("システムロールの移行: user/viewer を none へ書き換えました。")
  MIGRATION_STATE_FILE.write_text(
    json.dumps({**state, SYSTEM_ROLE_MIGRATION_KEY: True}, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
  )


def google_oauth_client_id() -> str:
  return os.getenv("GOOGLE_OAUTH_CLIENT_ID", "").strip()


def _demo_login_requested() -> bool:
  return os.getenv("AYATORI_DEMO_LOGIN", "").strip().lower() in {"1", "true", "yes"}


def demo_login_enabled() -> bool:
  """メールアドレスだけで入れるお試しログイン（Docker Composeの体験用）。

  パスワードもGoogleの確認も無いため、Googleログインとは併用できず、
  ログインなしの開発モードと同じく AYATORI_API_HOST=127.0.0.1 のときだけ使える。
  """
  return not google_oauth_client_id() and _demo_login_requested()


def bootstrap_admin_emails() -> set[str]:
  """初回adminを自動作成してよいメールアドレスの許可リスト。

  未設定なら空集合を返し、自動作成は行わない。公開URLでユーザーマスタが空に
  なった場合に、最初にログインした第三者がadminになることを防ぐ。
  """
  raw = os.getenv("AYATORI_BOOTSTRAP_ADMIN_EMAILS", "")
  return {value.strip().lower() for value in raw.split(",") if value.strip()}


def api_bind_host() -> str:
  return os.getenv("AYATORI_API_HOST", "").strip()


def validate_auth_configuration() -> None:
  if google_oauth_client_id():
    if _demo_login_requested():
      raise RuntimeError(
        "AYATORI_DEMO_LOGIN は GOOGLE_OAUTH_CLIENT_ID が未設定のときだけ使えます。"
        "メールアドレスだけで入れるため、Googleログインとは併用できません。"
      )
    return
  if _demo_login_requested() and os.getenv("APP_ENV", "").strip().lower() in {"prod", "production"}:
    raise RuntimeError("AYATORI_DEMO_LOGIN は本番環境（APP_ENV=production）では使えません。")
  if api_bind_host() == LOCAL_UNAUTHENTICATED_HOST:
    return
  raise RuntimeError(
    "GOOGLE_OAUTH_CLIENT_ID が未設定の場合、AYATORI_API_HOST は "
    f"{LOCAL_UNAUTHENTICATED_HOST} である必要があります。"
  )


def auth_enabled() -> bool:
  """ログイン（トークンと権限の判定）を使うか。Googleログインとお試しログインの両方を含む。"""
  validate_auth_configuration()
  return bool(google_oauth_client_id()) or demo_login_enabled()


def auth_token_ttl_seconds() -> int:
  raw_ttl = os.getenv("APP_AUTH_TOKEN_TTL_SECONDS", str(DEFAULT_TOKEN_TTL_SECONDS))
  try:
    return max(60, int(raw_ttl))
  except ValueError:
    logger.warning("APP_AUTH_TOKEN_TTL_SECONDS is invalid; using the default TTL.")
    return DEFAULT_TOKEN_TTL_SECONDS


def _auth_secret() -> str:
  secret = os.getenv("APP_AUTH_SECRET", "").strip()
  if secret:
    return secret
  # 本番のGoogleログインでは鍵を明示させる。生成した鍵はインスタンス間で共有されないため。
  if demo_login_enabled():
    return _stored_auth_secret()
  raise HTTPException(status_code=500, detail="APP_AUTH_SECRET が設定されていません。")


_stored_auth_secrets: dict[Path, str] = {}


def _stored_auth_secret() -> str:
  """APP_AUTH_SECRET が未設定のお試しログインで使う、保存済みの署名鍵。

  無ければ生成して AUTH_SECRET_FILE に保存する。メモリ上だけの鍵では、再起動で
  全員がログアウトになり、ワーカーごとに鍵が違ってトークンが通らなくなる。
  鍵を入れ替えるときはファイルを消して再起動する（全員ログアウトになる）。
  """
  path = AUTH_SECRET_FILE
  cached = _stored_auth_secrets.get(path)
  if cached:
    return cached
  secret = _read_auth_secret_file(path)
  if not secret:
    path.parent.mkdir(parents=True, exist_ok=True)
    # 書き終えた一時ファイルをリンクで置く。複数ワーカーが同時に起動しても、
    # 書きかけを読まれず、最初に置かれた1つを全員が使う。
    fd, temp_name = tempfile.mkstemp(dir=path.parent, prefix=".app_auth_secret.")
    try:
      with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(secrets.token_urlsafe(64))
        handle.flush()
        os.fsync(handle.fileno())
      try:
        os.link(temp_name, path)
        logger.info("APP_AUTH_SECRET が未設定のため、署名鍵を生成して保存しました。")
      except FileExistsError:
        pass
    finally:
      os.unlink(temp_name)
    secret = _read_auth_secret_file(path)
  if not secret:
    raise HTTPException(status_code=500, detail="署名鍵を用意できませんでした。")
  _stored_auth_secrets[path] = secret
  return secret


def _read_auth_secret_file(path: Path) -> str:
  try:
    return path.read_text(encoding="utf-8").strip()
  except FileNotFoundError:
    return ""


def ensure_auth_secret() -> None:
  """起動時に署名鍵を用意する。保存先に書けない等の問題を、ログイン時ではなく起動時に出す。"""
  if demo_login_enabled():
    _auth_secret()


def _b64url_encode(raw: bytes) -> str:
  return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
  padding = "=" * (-len(value) % 4)
  return base64.urlsafe_b64decode(f"{value}{padding}")


def _load_rows() -> list[dict[str, Any]]:
  ensure_user_master()
  try:
    data = json.loads(USER_MASTER_FILE.read_text(encoding="utf-8"))
  except json.JSONDecodeError as exc:
    raise HTTPException(status_code=500, detail="user_master.json の形式が不正です。") from exc
  return data if isinstance(data, list) else []


def _save_rows(rows: list[dict[str, Any]]) -> None:
  ensure_user_master()
  USER_MASTER_FILE.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")


def _load_tenant_rows() -> list[dict[str, Any]]:
  ensure_user_master()
  try:
    data = json.loads(TENANT_MASTER_FILE.read_text(encoding="utf-8"))
  except json.JSONDecodeError as exc:
    raise HTTPException(status_code=500, detail="tenant_master.json の形式が不正です。") from exc
  return data if isinstance(data, list) else []


def _save_tenant_rows(rows: list[dict[str, Any]]) -> None:
  ensure_user_master()
  TENANT_MASTER_FILE.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")


def _normalize_tenant(row: dict[str, Any]) -> dict[str, Any]:
  tenant_id = str(row.get("id") or "").strip().lower()
  return {
    "id": tenant_id,
    "name": str(row.get("name") or tenant_id).strip(),
    "description": str(row.get("description") or "").strip(),
    "enabled": row.get("enabled", True) is not False,
    "created_at": str(row.get("created_at") or "").strip() or None,
    "updated_at": str(row.get("updated_at") or "").strip() or None,
  }


def list_tenants(*, include_disabled: bool = True) -> list[dict[str, Any]]:
  tenants = [
    _normalize_tenant(row)
    for row in _load_tenant_rows()
    if isinstance(row, dict) and str(row.get("id") or "").strip()
  ]
  return tenants if include_disabled else [tenant for tenant in tenants if tenant["enabled"]]


def get_tenant(tenant_id: str, *, require_enabled: bool = True) -> dict[str, Any]:
  normalized_id = tenant_id.strip().lower()
  tenant = next((item for item in list_tenants() if item["id"] == normalized_id), None)
  if tenant is None:
    raise HTTPException(status_code=404, detail="テナントが見つかりません。")
  if require_enabled and not tenant["enabled"]:
    raise HTTPException(status_code=403, detail="このテナントは無効です。")
  return tenant


def create_tenant_entry(*, tenant_id: str, name: str, description: str, enabled: bool) -> dict[str, Any]:
  normalized_id = tenant_id.strip().lower()
  if not normalized_id or len(normalized_id) > 64 or any(
    not (character.isascii() and (character.islower() or character.isdigit() or character == "-"))
    for character in normalized_id
  ) or not normalized_id[0].isalnum():
    raise HTTPException(status_code=400, detail="テナントIDは英小文字・数字・ハイフンで指定してください。")
  if any(item["id"] == normalized_id for item in list_tenants()):
    raise HTTPException(status_code=409, detail="同じテナントIDが既に存在します。")
  now = datetime.now(timezone.utc).isoformat()
  entry = {
    "id": normalized_id,
    "name": name.strip(),
    "description": description.strip(),
    "enabled": bool(enabled),
    "created_at": now,
    "updated_at": now,
  }
  if not entry["name"]:
    raise HTTPException(status_code=400, detail="テナント名が必要です。")
  rows = _load_tenant_rows()
  rows.append(entry)
  _save_tenant_rows(rows)
  return _normalize_tenant(entry)


def update_tenant_entry(tenant_id: str, payload: dict[str, Any]) -> dict[str, Any]:
  normalized_id = tenant_id.strip().lower()
  rows = _load_tenant_rows()
  for index, row in enumerate(rows):
    if not isinstance(row, dict) or str(row.get("id") or "").strip().lower() != normalized_id:
      continue
    updated = {
      **row,
      "name": str(payload.get("name") or "").strip(),
      "description": str(payload.get("description") or "").strip(),
      "enabled": payload.get("enabled", True) is not False,
      "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    if not updated["name"]:
      raise HTTPException(status_code=400, detail="テナント名が必要です。")
    rows[index] = updated
    _save_tenant_rows(rows)
    return _normalize_tenant(updated)
  raise HTTPException(status_code=404, detail="テナントが見つかりません。")


def _normalize_role(role: Any) -> Role:
  normalized = str(role or "user").strip().lower()
  return normalized if normalized in VALID_ROLES else "user"  # type: ignore[return-value]


def _normalize_system_role(role: Any) -> SystemRole:
  normalized = str(role or "").strip().lower()
  return normalized if normalized in VALID_SYSTEM_ROLES else "none"  # type: ignore[return-value]


def _token_version_of(row: dict[str, Any]) -> int:
  """発行済みトークンの世代。増やすと、それ以前のトークンは全て失効する。"""
  try:
    return max(0, int(row.get("token_version") or 0))
  except (TypeError, ValueError):
    return 0


def _normalize_user(row: dict[str, Any]) -> dict[str, Any]:
  email = str(row.get("email", "")).strip().lower()
  system_role = _normalize_system_role(row.get("role"))
  raw_memberships = row.get("tenant_memberships")
  if not isinstance(raw_memberships, list):
    # 所属が未設定の古い行は、当時のロールを既定テナントの所属として読み替える。
    # 旧ロールuserはシステムロールではnoneになるため、正規化前の値で判定する
    # （migrate_system_rolesと同じ読み替え）。
    stored_role = str(row.get("role") or "").strip().lower()
    raw_memberships = (
      [] if stored_role in {"", "none"}
      else [{"tenant_id": DEFAULT_TENANT_ID, "role": _normalize_role(stored_role)}]
    )
  memberships_by_tenant: dict[str, dict[str, str]] = {}
  for membership in raw_memberships:
    if not isinstance(membership, dict):
      continue
    tenant_id = str(membership.get("tenant_id") or "").strip().lower()
    if tenant_id:
      memberships_by_tenant[tenant_id] = {
        "tenant_id": tenant_id,
        "role": _normalize_role(membership.get("role")),
        # 所属組織はテナントごとに異なる。旧い行のトップレベルorg_unit_idは
        # 起動時の移行でこちらへ寄せる。
        "org_unit_id": str(membership.get("org_unit_id") or "").strip(),
      }
  return {
    "email": email,
    "google_subject": str(row.get("google_subject") or "").strip() or None,
    "name": str(row.get("name") or "").strip() or email,
    "department": str(row.get("department") or "").strip() or None,
    "department_id": str(row.get("department_id") or "").strip() or None,
    "org_unit_id": str(row.get("org_unit_id") or "").strip() or None,
    "role": system_role,
    "tenant_memberships": list(memberships_by_tenant.values()),
    "enabled": row.get("enabled", True) is not False,
    "token_version": _token_version_of(row),
    "created_at": str(row.get("created_at") or "").strip() or None,
    "updated_at": str(row.get("updated_at") or "").strip() or None,
  }


def list_user_master_entries() -> list[dict[str, Any]]:
  entries: list[dict[str, Any]] = []
  for row in _load_rows():
    if not isinstance(row, dict):
      continue
    normalized = _normalize_user(row)
    if normalized["email"]:
      entries.append(normalized)
  return entries


def _find_user_by_email(email: str) -> dict[str, Any] | None:
  normalized_email = email.strip().lower()
  for row in list_user_master_entries():
    if row["email"] == normalized_email and row["enabled"]:
      return row
  return None


def _find_user_by_subject(subject: str) -> dict[str, Any] | None:
  normalized_subject = str(subject or "").strip()
  if not normalized_subject:
    return None
  for row in list_user_master_entries():
    if row.get("google_subject") == normalized_subject and row["enabled"]:
      return row
  return None


def _assert_unique(email: str, google_subject: str | None, *, ignore_email: str | None = None) -> None:
  normalized_email = email.strip().lower()
  normalized_ignore = (ignore_email or "").strip().lower()
  normalized_subject = str(google_subject or "").strip()
  for row in list_user_master_entries():
    if row["email"] == normalized_ignore:
      continue
    if row["email"] == normalized_email:
      raise HTTPException(status_code=409, detail="同じメールアドレスのユーザーが既に存在します。")
    if normalized_subject and row.get("google_subject") == normalized_subject:
      raise HTTPException(status_code=409, detail="同じ Google Subject のユーザーが既に存在します。")


def create_user_master_entry(
  *,
  email: str,
  name: str,
  department: str | None,
  department_id: str | None,
  org_unit_id: str | None,
  role: SystemRole,
  enabled: bool,
  google_subject: str | None = None,
  tenant_memberships: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
  normalized_email = email.strip().lower()
  if not normalized_email:
    raise HTTPException(status_code=400, detail="メールアドレスが必要です。")
  if role not in VALID_SYSTEM_ROLES:
    raise HTTPException(status_code=400, detail="ロールが不正です。")
  _assert_unique(normalized_email, google_subject)
  now = datetime.now(timezone.utc).isoformat()
  entry = {
    "email": normalized_email,
    "google_subject": str(google_subject or "").strip() or None,
    "name": name.strip() or normalized_email,
    "department": str(department or "").strip() or None,
    "department_id": str(department_id or "").strip() or None,
    "org_unit_id": str(org_unit_id or "").strip() or None,
    "role": role,
    "tenant_memberships": (
      tenant_memberships
      if tenant_memberships is not None
      else ([] if role == "none" else [{"tenant_id": DEFAULT_TENANT_ID, "role": role}])
    ),
    "enabled": bool(enabled),
    "token_version": 0,
    "created_at": now,
    "updated_at": now,
  }
  rows = _load_rows()
  rows.append(entry)
  _save_rows(rows)
  return _normalize_user(entry)


def update_user_master_entry(email: str, payload: dict[str, Any]) -> dict[str, Any]:
  normalized_email = email.strip().lower()
  rows = _load_rows()
  now = datetime.now(timezone.utc).isoformat()
  for index, row in enumerate(rows):
    if not isinstance(row, dict) or str(row.get("email", "")).strip().lower() != normalized_email:
      continue
    next_email = str(payload.get("email") or normalized_email).strip().lower()
    # 省略された項目は現在の値を保つ。既定値で埋めると、無効化した利用者が
    # 有効へ戻ったり、Googleアカウントとの結びつきが外れたりする。
    next_subject = str(payload.get("google_subject", row.get("google_subject")) or "").strip() or None
    next_role = _normalize_system_role(payload.get("role", row.get("role")))
    _assert_unique(next_email, next_subject, ignore_email=normalized_email)
    next_enabled = payload.get("enabled", row.get("enabled", True)) is not False
    # 無効化・ロール変更・メール変更は、発行済みトークンを失効させてから反映する。
    # ロールは検証時にマスタから引き直されるが、失効させておけば再ログインを強制できる。
    revoke = (
      (row.get("enabled", True) is not False and not next_enabled)
      or next_role != _normalize_system_role(row.get("role"))
      or next_email != normalized_email
    )
    updated = {
      **row,
      "token_version": _token_version_of(row) + (1 if revoke else 0),
      "email": next_email,
      "google_subject": next_subject,
      "name": str(payload.get("name") or "").strip() or next_email,
      "department": str(payload.get("department") or "").strip() or None,
      "department_id": str(payload.get("department_id") or "").strip() or None,
      "org_unit_id": str(payload.get("org_unit_id") or "").strip() or None,
      "role": next_role,
      "tenant_memberships": payload.get("tenant_memberships", row.get("tenant_memberships")),
      "enabled": next_enabled,
      "updated_at": now,
    }
    rows[index] = updated
    _save_rows(rows)
    return _normalize_user(updated)
  raise HTTPException(status_code=404, detail="ユーザーが見つかりません。")


def revoke_user_tokens(email: str) -> None:
  """発行済みトークンを全て失効させる。ログアウトや管理者による締め出しで使う。

  端末単位ではなく利用者単位なので、1つの端末でログアウトすると他の端末も
  ログアウトされる。
  """
  normalized_email = email.strip().lower()
  if not normalized_email:
    return
  rows = _load_rows()
  for index, row in enumerate(rows):
    if not isinstance(row, dict) or str(row.get("email", "")).strip().lower() != normalized_email:
      continue
    rows[index] = {
      **row,
      "token_version": _token_version_of(row) + 1,
      "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    _save_rows(rows)
    return


def delete_user_master_entry(email: str) -> None:
  normalized_email = email.strip().lower()
  rows = _load_rows()
  next_rows = [row for row in rows if not (isinstance(row, dict) and str(row.get("email", "")).strip().lower() == normalized_email)]
  if len(next_rows) == len(rows):
    raise HTTPException(status_code=404, detail="ユーザーが見つかりません。")
  _save_rows(next_rows)


def role_rank(role: str) -> int:
  if role == "admin":
    return 4
  if role == "user":
    return 2
  if role == "viewer":
    return 1
  return 0


def ensure_role(user: dict[str, Any], required_role: SystemRole) -> None:
  if role_rank(str(user.get("role", "viewer"))) < role_rank(required_role):
    raise HTTPException(status_code=403, detail="この操作を実行する権限がありません。")


def tenant_role(user: dict[str, Any], tenant_id: str) -> Role | None:
  normalized_id = tenant_id.strip().lower()
  for membership in user.get("tenant_memberships", []):
    if isinstance(membership, dict) and membership.get("tenant_id") == normalized_id:
      return _normalize_role(membership.get("role"))
  return None


def ensure_tenant_role(user: dict[str, Any], tenant_id: str, required_role: Role) -> Role:
  get_tenant(tenant_id)
  # System administrators retain break-glass access to every tenant.
  if user.get("role") == "admin":
    return "admin"
  role = tenant_role(user, tenant_id)
  # システムviewerは全テナントを閲覧できる。書き込みはviewer相当で止まるため、
  # 所属しているテナントについてはそのテナントのロールを優先する。
  if role is None and user.get("role") == "viewer":
    role = "viewer"
  if role is None:
    raise HTTPException(status_code=403, detail="このテナントへのアクセス権限がありません。")
  if role_rank(role) < role_rank(required_role):
    raise HTTPException(status_code=403, detail="このテナントで操作を実行する権限がありません。")
  return role


def verify_google_credential(credential: str) -> dict[str, str]:
  client_id = google_oauth_client_id()
  if not client_id:
    raise HTTPException(status_code=503, detail="Google OAuth が未設定です。")
  try:
    from google.auth import exceptions as google_auth_exceptions
    from google.auth.transport import requests
    from google.oauth2 import id_token
  except ImportError as exc:
    raise HTTPException(status_code=503, detail="google-auth がインストールされていません。") from exc
  try:
    info = id_token.verify_oauth2_token(
      credential,
      requests.Request(),
      client_id,
      clock_skew_in_seconds=GOOGLE_TOKEN_CLOCK_SKEW_SECONDS,
    )
  except Exception as exc:
    logger.warning(
      "Google ID token verification failed (%s): %s",
      type(exc).__name__,
      exc,
    )
    if isinstance(exc, google_auth_exceptions.TransportError):
      raise HTTPException(
        status_code=503,
        detail="Google認証サーバーへ接続できませんでした。少し待ってから再試行してください。",
      ) from exc
    message = str(exc).lower()
    if "audience" in message:
      raise HTTPException(
        status_code=401,
        detail="Google OAuthクライアントIDが一致しません。画面を再読み込みしてからログインしてください。",
      ) from exc
    if "expired" in message:
      raise HTTPException(
        status_code=401,
        detail="Googleのログイン情報が期限切れです。画面を再読み込みしてから再度ログインしてください。",
      ) from exc
    if "used too early" in message or "issued at" in message:
      raise HTTPException(
        status_code=401,
        detail="端末またはサーバーの時刻差によりGoogle認証を確認できませんでした。",
      ) from exc
    raise HTTPException(
      status_code=401,
      detail="Google認証情報を確認できませんでした。画面を再読み込みしてから再試行してください。",
    ) from exc
  email = str(info.get("email", "")).strip().lower()
  if not email:
    raise HTTPException(status_code=401, detail="Google 認証からメールアドレスを取得できませんでした。")
  # verify_oauth2_token は email_verified を見ない。未確認のメールで照合すると、
  # 他人のアドレスを名乗るアカウントがその人の権限で入れてしまう。
  if info.get("email_verified") is not True:
    raise HTTPException(status_code=401, detail="Google アカウントのメールアドレスが確認されていません。")
  return {
    "google_subject": str(info.get("sub") or "").strip(),
    "email": email,
    "name": str(info.get("name") or email).strip(),
    "picture": str(info.get("picture") or "").strip(),
  }


def authenticate_google_credential(credential: str) -> dict[str, Any]:
  google_user = verify_google_credential(credential)
  user = _find_user_by_subject(google_user["google_subject"])
  if not user:
    user = _find_user_by_email(google_user["email"])
    # 一度ログインしてGoogleアカウントに結びついた利用者は、別のアカウントから
    # 同じメールアドレスを名乗られても通さない。
    if user and user.get("google_subject") and user["google_subject"] != google_user["google_subject"]:
      logger.warning("Google subject mismatch for a registered user; login rejected.")
      raise HTTPException(status_code=403, detail="登録済みのGoogleアカウントと一致しません。")
  if not user:
    master_is_empty = len(list_user_master_entries()) == 0
    allowed_bootstrap_admins = bootstrap_admin_emails()
    if master_is_empty and not allowed_bootstrap_admins:
      # 許可リストが無いまま自動作成すると、最初のログイン者が全体管理者になる。
      logger.warning(
        "ユーザーマスタが空ですが AYATORI_BOOTSTRAP_ADMIN_EMAILS が未設定のため、"
        "初回adminを自動作成しませんでした。"
      )
    if master_is_empty and google_user["email"] in allowed_bootstrap_admins:
      user = create_user_master_entry(
        email=google_user["email"],
        google_subject=google_user["google_subject"],
        name=google_user["name"],
        department=None,
        department_id=None,
        org_unit_id=None,
        role="admin",
        enabled=True,
      )
    else:
      raise HTTPException(status_code=403, detail="ユーザーマスタに登録されたアカウントのみ利用できます。")
  if not user.get("google_subject") and google_user.get("google_subject"):
    user = update_user_master_entry(user["email"], {**user, "google_subject": google_user["google_subject"]})
  return {
    **user,
    "oauth_name": google_user.get("name") or user.get("name"),
    "oauth_picture": google_user.get("picture") or None,
  }


_DEMO_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def authenticate_demo_email(email: str) -> dict[str, Any]:
  """お試しログイン。メールアドレスだけで入り、未登録なら利用者を作る。

  最初の1人は全体管理者にして全画面を試せるようにし、以降は一般利用者にする。
  """
  if not demo_login_enabled():
    raise HTTPException(status_code=404, detail="お試しログインは有効ではありません。")
  normalized = email.strip().lower()
  if len(normalized) > 254 or not _DEMO_EMAIL_PATTERN.match(normalized):
    raise HTTPException(status_code=400, detail="メールアドレスの形式が正しくありません。")
  user = _find_user_by_email(normalized)
  if user:
    return user
  if any(row["email"] == normalized for row in list_user_master_entries()):
    raise HTTPException(status_code=403, detail="このアカウントは無効になっています。")
  is_first = len(list_user_master_entries()) == 0
  return create_user_master_entry(
    email=normalized,
    name=normalized.split("@", 1)[0],
    department=None,
    department_id=None,
    org_unit_id=None,
    role="admin" if is_first else "none",
    enabled=True,
    tenant_memberships=[{
      "tenant_id": DEFAULT_TENANT_ID,
      "role": "admin" if is_first else "user",
      "org_unit_id": "",
    }],
  )


def issue_app_token(user: dict[str, Any]) -> str:
  header = {"alg": "HS256", "typ": "JWT"}
  payload = {
    "sub": str(user.get("email", "")).strip().lower(),
    "email": str(user.get("email", "")).strip().lower(),
    "google_subject": str(user.get("google_subject") or "").strip(),
    "name": str(user.get("name") or "").strip(),
    "oauth_name": str(user.get("oauth_name") or "").strip(),
    "oauth_picture": str(user.get("oauth_picture") or "").strip(),
    "role": str(user.get("role", "viewer")).strip().lower(),
    "token_version": _token_version_of(user),
    "iat": int(time.time()),
    "exp": int(time.time()) + auth_token_ttl_seconds(),
  }
  header_segment = _b64url_encode(json.dumps(header, separators=(",", ":")).encode("utf-8"))
  payload_segment = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
  signing_input = f"{header_segment}.{payload_segment}".encode("ascii")
  signature = hmac.new(_auth_secret().encode("utf-8"), signing_input, hashlib.sha256).digest()
  return f"{header_segment}.{payload_segment}.{_b64url_encode(signature)}"


def verify_app_token(token: str) -> dict[str, Any]:
  # 壊れたトークンで500を返すと、未認証のクライアントがエラーを誘発できてしまう。
  # 形式の異常はすべて401へ寄せる。
  if len(token) > MAX_AUTH_TOKEN_LENGTH:
    raise HTTPException(status_code=401, detail="認証トークン形式が不正です。")
  try:
    header_segment, payload_segment, signature_segment = token.split(".")
    signing_input = f"{header_segment}.{payload_segment}".encode("ascii")
    actual_signature = _b64url_decode(signature_segment)
  except (ValueError, binascii.Error, UnicodeEncodeError) as exc:
    raise HTTPException(status_code=401, detail="認証トークン形式が不正です。") from exc
  expected_signature = hmac.new(_auth_secret().encode("utf-8"), signing_input, hashlib.sha256).digest()
  if not hmac.compare_digest(expected_signature, actual_signature):
    raise HTTPException(status_code=401, detail="認証トークンの署名検証に失敗しました。")
  try:
    payload = json.loads(_b64url_decode(payload_segment))
  except Exception as exc:
    raise HTTPException(status_code=401, detail="認証トークンの内容を読み取れません。") from exc
  if int(payload.get("exp", 0) or 0) < int(time.time()):
    raise HTTPException(status_code=401, detail="認証トークンの有効期限が切れています。")
  subject = str(payload.get("google_subject") or "").strip()
  email = str(payload.get("email") or payload.get("sub") or "").strip().lower()
  user = (_find_user_by_subject(subject) if subject else None) or _find_user_by_email(email)
  if not user:
    raise HTTPException(status_code=403, detail="ユーザーマスタに権限がありません。")
  # ログアウト・無効化・ロール変更で世代が進むと、それ以前のトークンは受け付けない。
  if _token_version_of(payload) != user["token_version"]:
    raise HTTPException(status_code=401, detail="認証トークンは失効しています。再度ログインしてください。")
  return {
    **user,
    "oauth_name": str(payload.get("oauth_name") or "").strip() or None,
    "oauth_picture": str(payload.get("oauth_picture") or "").strip() or None,
  }
