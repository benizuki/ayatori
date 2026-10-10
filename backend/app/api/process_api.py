"""As-Isドラフト、業務改善提案、タスク分類、アセット項目抽出。"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool

from ..schemas import (
    AssetDocumentExtractionRequest,
    AssetDocumentExtractionResponse,
    ProcessAiOpportunityRequest,
    ProcessAiOpportunityResponse,
    ProcessDraftRequest,
    ProcessDraftResponse,
    TaskClassificationRequest,
    TaskClassificationResponse,
)
from ..services.gemini import model_for, provider_for
from ..services.llm_interview import LLMInterviewError, extract_asset_document_fields, generate_process_draft
from ..services.llm_process_ai_opportunity import build_process_ai_opportunities
from ..services.llm_task_classification import classify_business_tasks

router = APIRouter()
logger = logging.getLogger(__name__)


@router.post("/api/process/ai-opportunities", response_model=ProcessAiOpportunityResponse)
async def process_ai_opportunities(
    payload: ProcessAiOpportunityRequest,
) -> ProcessAiOpportunityResponse:
    """As-Isの事実だけを渡してAI活用提案を作る。失敗時はルールベースの結果を画面側で使う。"""
    try:
        return await run_in_threadpool(build_process_ai_opportunities, payload)
    except LLMInterviewError as exc:
        logger.exception("Process AI opportunity generation failed: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/api/tasks/classify", response_model=TaskClassificationResponse)
async def classify_tasks(payload: TaskClassificationRequest) -> TaskClassificationResponse:
    """業務名と業務内容を手掛かりに、タスクを5分類へ振り分け、価値区分を判断する。結果は保存しない。"""
    try:
        return await run_in_threadpool(classify_business_tasks, payload)
    except LLMInterviewError as exc:
        logger.exception("Task classification failed: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/api/process/draft", response_model=ProcessDraftResponse)
async def process_draft(request: ProcessDraftRequest) -> ProcessDraftResponse:
    try:
        decision = await run_in_threadpool(generate_process_draft, request)
    except LLMInterviewError as exc:
        logger.exception("As-Is draft Gemini request failed: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if decision is None:
        raise HTTPException(status_code=503, detail="As-Isドラフトの生成結果を取得できませんでした。")
    return ProcessDraftResponse.model_validate(
        {
            **decision.model_dump(),
            "provider": provider_for("chat"),
            "model": model_for("chat"),
        }
    )


@router.post("/api/assets/extract-fields", response_model=AssetDocumentExtractionResponse)
async def asset_document_field_extraction(
    request: AssetDocumentExtractionRequest,
) -> AssetDocumentExtractionResponse:
    try:
        decision = await run_in_threadpool(extract_asset_document_fields, request)
    except LLMInterviewError as exc:
        logger.exception("Asset document extraction Gemini request failed: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return AssetDocumentExtractionResponse.model_validate(
        {
            **decision.model_dump(),
            "provider": provider_for("chat"),
            "model": model_for("chat"),
        }
    )
