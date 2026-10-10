"""ログイン（Google・お試し）とセッション。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from ..core.auth import (
    AUTH_COOKIE_NAME,
    auth_token_ttl_seconds,
    authenticate_demo_email,
    authenticate_google_credential,
    demo_login_enabled,
    google_oauth_client_id,
    issue_app_token,
    revoke_user_tokens,
    validate_auth_configuration,
    verify_app_token,
)
from ..runtime import LOGIN_LIMIT_SCOPE, LOGIN_RATE_PER_MINUTE, _login_limiter
from ..schemas import (
    AuthConfig,
    AuthDemoLoginRequest,
    AuthGoogleLoginRequest,
    AuthLoginResponse,
    AuthUser,
)
from .common import _auth_user_from_dict, _header_tenant_id
from .middleware import _client_ip, _request_is_https

router = APIRouter()


@router.get("/api/auth/config", response_model=AuthConfig)
def auth_config() -> AuthConfig:
    validate_auth_configuration()
    return AuthConfig(
        google_oauth_enabled=bool(google_oauth_client_id()),
        google_client_id=google_oauth_client_id(),
        demo_login_enabled=demo_login_enabled(),
    )


def _limit_login_attempts(request: Request) -> None:
    # 未認証で呼べるため、接続元ごとに連打を止める。
    retry_after = _login_limiter.try_acquire(
        LOGIN_LIMIT_SCOPE, _client_ip(request), LOGIN_RATE_PER_MINUTE
    )
    if retry_after:
        raise HTTPException(
            status_code=429,
            detail="ログイン試行が集中しています。少し待ってから試してください。",
            headers={"Retry-After": str(retry_after)},
        )


def _start_session(request: Request, response: Response, user: dict[str, Any]) -> AuthLoginResponse:
    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=issue_app_token(user),
        max_age=auth_token_ttl_seconds(),
        httponly=True,
        secure=_request_is_https(request),
        samesite="lax",
        path="/",
    )
    return AuthLoginResponse(user=_auth_user_from_dict(user, _header_tenant_id(request)))


@router.post("/api/auth/google", response_model=AuthLoginResponse, response_model_exclude_none=True)
def auth_google(payload: AuthGoogleLoginRequest, request: Request, response: Response) -> AuthLoginResponse:
    # 1回ごとにGoogleのトークン検証へ進むため、接続元ごとに連打を止める。
    _limit_login_attempts(request)
    return _start_session(request, response, authenticate_google_credential(payload.credential))


@router.post("/api/auth/demo", response_model=AuthLoginResponse, response_model_exclude_none=True)
def auth_demo(payload: AuthDemoLoginRequest, request: Request, response: Response) -> AuthLoginResponse:
    """メールアドレスだけで入るお試しログイン。Docker Composeでの体験用。"""
    if not demo_login_enabled():
        raise HTTPException(status_code=404, detail="お試しログインは有効ではありません。")
    _limit_login_attempts(request)
    return _start_session(request, response, authenticate_demo_email(payload.email))


@router.get("/api/auth/me", response_model=AuthUser)
def auth_me(request: Request) -> AuthUser:
    user = getattr(request.state, "user", None)
    if not user:
        authorization = request.headers.get("Authorization", "")
        scheme, _, bearer_token = authorization.partition(" ")
        token = bearer_token.strip() if scheme.lower() == "bearer" else request.cookies.get(AUTH_COOKIE_NAME, "")
        user = verify_app_token(token)
    return _auth_user_from_dict(user, _header_tenant_id(request))


@router.post("/api/auth/logout")
def auth_logout(request: Request, response: Response) -> dict[str, bool]:
    # Cookieを消すだけでは、窃取済みのトークンが有効期限まで使えてしまう。
    # 世代を進めて、その利用者の発行済みトークンをすべて失効させる。
    user = getattr(request.state, "user", None)
    if isinstance(user, dict) and user.get("email"):
        revoke_user_tokens(str(user["email"]))
    response.delete_cookie(key=AUTH_COOKIE_NAME, path="/")
    return {"ok": True}
