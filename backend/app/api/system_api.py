"""稼働確認と初期データ。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from ..resources.initial_data import load_initial_data
from ..runtime import is_production
from ..schemas import HealthResponse
from ..services.gemini import gemini_configured, model_for, provider_for

router = APIRouter()


@router.get("/api/health", response_model=HealthResponse, response_model_exclude_none=True)
def health() -> HealthResponse:
    if is_production():
        return HealthResponse(llm_configured=gemini_configured("chat"))
    return HealthResponse(
        llm_configured=gemini_configured("chat"),
        provider=provider_for("chat"),
        model=model_for("chat"),
    )


@router.get("/api/initial-data", response_model=dict[str, Any])
def get_initial_data() -> dict[str, Any]:
    return load_initial_data()
