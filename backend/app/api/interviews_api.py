"""AI業務ヒアリング。セッション、会話、添付、音声、利用者ごとの表示中ヒアリング。"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response, StreamingResponse

from .. import runtime
from ..runtime import (
    MAX_AUDIO_BYTES,
    MIN_AUDIO_BYTES,
    SUPPORTED_AUDIO_MIME_TYPES,
    TIMESTAMP_ONLY_PATTERN,
    interview_histories,
    interview_sessions,
    interview_updated_at,
    session_lock,
)
from ..schemas import (
    AudioTranscriptionResponse,
    InterviewDecision,
    InterviewMessage,
    InterviewRequest,
    InterviewResponse,
    InterviewSessionRecord,
    InterviewSessionState,
    InterviewSessionSummaryRecord,
    InterviewSessionUpdate,
    SavedInterviewAttachment,
    SpeechSynthesisRequest,
    StartInterviewRequest,
    UserInterviewPreference,
    UserInterviewPreferenceUpdate,
)
from ..services.gemini import model_for, provider_for
from ..services.llm_interview import (
    INTERVIEW_PHASE_ORDER,
    LLMInterviewError,
    generate_audio_transcription,
    generate_initial_question,
    generate_interview_response,
)
from .user_preferences_api import speech_options_for
from ..services.tts import (
    STREAMING_TTS_SAMPLE_RATE,
    SpeechRateLimitError,
    SpeechSynthesisError,
    begin_interview_speech_stream,
    speech_engine,
    synthesize_interview_speech,
)
from ..storage.interview_attachment_store import (
    InterviewAttachmentStorageError,
    delete_interview_attachments,
    resolve_interview_attachment,
    save_interview_attachments,
)
from .common import (
    _interview_key,
    _request_tenant_id,
    _request_user_email,
    _request_user_email_or_empty,
)

router = APIRouter()
logger = logging.getLogger(__name__)


def _reflection_visible_to_request(state: InterviewSessionState, request: Request) -> bool:
    if state.analysis_mode != "daily_reflection" or not state.owner_email:
        return True
    return _request_user_email_or_empty(request) == state.owner_email.strip().lower()


def _reject_retired_reflection_mode(business_context: dict[str, Any] | None) -> None:
    """業務振り返り（daily_reflection）は廃止した。新規開始も、保存済みの続きも受け付けない。"""
    if (business_context or {}).get("analysis_mode") == "daily_reflection":
        raise HTTPException(status_code=410, detail="業務振り返りは提供を終了しました。")


def _ensure_reflection_owner(state: InterviewSessionState, request: Request) -> None:
    if not _reflection_visible_to_request(state, request):
        # 他者の振り返りが存在すること自体を開示しない。
        raise HTTPException(status_code=404, detail="保存された振り返りが見つかりません。")


@router.get("/api/interviews", response_model=list[InterviewSessionSummaryRecord])
def interview_session_summaries(request: Request) -> list[InterviewSessionSummaryRecord]:
    tenant_id = _request_tenant_id(request)
    with session_lock:
        summaries = [
            InterviewSessionSummaryRecord(
                session_id=state.session_id,
                department=state.department,
                participant=state.participant,
                phase=state.phase,
                completion_score=state.completion_score,
                message_count=len(interview_histories.get(storage_key, [])),
                created_at=state.created_at or interview_updated_at.get(storage_key, ""),
                updated_at=interview_updated_at.get(storage_key, ""),
                is_complete=_session_is_complete_for_summary(state),
                analysis_mode=state.analysis_mode,
                owner_email=state.owner_email,
                source_process_id=str((state.business_context or {}).get("source_process_id") or ""),
            )
            for storage_key, state in interview_sessions.items()
            if state.tenant_id == tenant_id and _reflection_visible_to_request(state, request)
        ]
    return sorted(summaries, key=lambda summary: summary.updated_at, reverse=True)


def _session_is_complete_for_summary(state: InterviewSessionState) -> bool:
    return bool(
        state.is_complete
        or state.phase == "完了"
        or state.completion_score >= 100
        or (
            state.process_end_confirmed
            and state.gap_review_status == "完了"
            and state.phase == "要約確認"
            and state.completion_score >= 90
        )
    )


@router.get("/api/interview/{session_id}", response_model=InterviewSessionRecord)
def interview_session(session_id: str, request: Request) -> InterviewSessionRecord:
    storage_key = _interview_key(_request_tenant_id(request), session_id)
    with session_lock:
        state = interview_sessions.get(storage_key)
        if state is None:
            raise HTTPException(status_code=404, detail="保存されたヒアリングが見つかりません。")
        _ensure_reflection_owner(state, request)
        return InterviewSessionRecord(
            session_state=state.model_copy(deep=True),
            messages=[message.model_copy(deep=True) for message in interview_histories.get(storage_key, [])],
            updated_at=interview_updated_at.get(storage_key, ""),
        )


@router.get("/api/interview/{session_id}/attachments/{attachment_id}")
def interview_attachment(
    session_id: str,
    attachment_id: str,
    request: Request,
) -> FileResponse:
    tenant_id = _request_tenant_id(request)
    storage_key = _interview_key(tenant_id, session_id)
    with session_lock:
        state = interview_sessions.get(storage_key)
        if state is None:
            raise HTTPException(status_code=404, detail="保存されたヒアリングが見つかりません。")
        _ensure_reflection_owner(state, request)
        metadata = next(
            (
                attachment
                for message in interview_histories.get(storage_key, [])
                for attachment in message.attachments
                if attachment.id == attachment_id
            ),
            None,
        )
    if metadata is None:
        raise HTTPException(status_code=404, detail="添付ファイルが履歴に見つかりません。")
    file_path = resolve_interview_attachment(
        runtime.INTERVIEW_ATTACHMENT_DIR,
        tenant_id,
        session_id,
        attachment_id,
    )
    if file_path is None:
        raise HTTPException(status_code=404, detail="添付ファイル本体が見つかりません。")
    return FileResponse(
        file_path,
        media_type=metadata.mime_type,
        filename=metadata.name,
        content_disposition_type="inline",
    )


@router.put("/api/interview/{session_id}/metadata", response_model=InterviewSessionRecord)
def update_interview_session_metadata(
    session_id: str,
    payload: InterviewSessionUpdate,
    request: Request,
) -> InterviewSessionRecord:
    storage_key = _interview_key(_request_tenant_id(request), session_id)
    with session_lock:
        state = interview_sessions.get(storage_key)
        if state is None:
            raise HTTPException(status_code=404, detail="保存されたヒアリングが見つかりません。")
        _ensure_reflection_owner(state, request)
        department = payload.department.strip()
        participant = payload.participant.strip()
        if not department or not participant:
            raise HTTPException(status_code=422, detail="部門と参加者を入力してください。")
        state.department = department
        state.participant = participant
        _touch_interview_session(storage_key)
        _persist_interview_sessions()
        return InterviewSessionRecord(
            session_state=state.model_copy(deep=True),
            messages=[message.model_copy(deep=True) for message in interview_histories.get(storage_key, [])],
            updated_at=interview_updated_at.get(storage_key, ""),
        )


@router.delete("/api/interview/{session_id}", status_code=204)
def delete_interview_session(session_id: str, request: Request) -> Response:
    tenant_id = _request_tenant_id(request)
    storage_key = _interview_key(tenant_id, session_id)
    with session_lock:
        state = interview_sessions.get(storage_key)
        if state is None:
            raise HTTPException(status_code=404, detail="保存されたヒアリングが見つかりません。")
        _ensure_reflection_owner(state, request)
        interview_sessions.pop(storage_key, None)
        interview_histories.pop(storage_key, None)
        interview_updated_at.pop(storage_key, None)
        _persist_interview_sessions()
    try:
        delete_interview_attachments(runtime.INTERVIEW_ATTACHMENT_DIR, tenant_id, session_id)
    except OSError as exc:
        logger.warning("Interview attachments could not be deleted: %s", exc)
    return Response(status_code=204)


@router.get("/api/user-preferences/interview", response_model=UserInterviewPreference)
def get_user_interview_preference(request: Request) -> UserInterviewPreference:
    preference = runtime.store.load_user_interview_preference(
        _request_user_email(request),
        _request_tenant_id(request),
    )
    return UserInterviewPreference(**preference)


@router.put("/api/user-preferences/interview", response_model=UserInterviewPreference)
def put_user_interview_preference(
    request: Request,
    preference: UserInterviewPreferenceUpdate,
) -> UserInterviewPreference:
    active_interview_id = (preference.active_interview_id or "").strip() or None
    updated_at = datetime.now(timezone.utc).isoformat()
    runtime.store.save_user_interview_preference(
        _request_user_email(request),
        active_interview_id,
        updated_at,
        _request_tenant_id(request),
    )
    return UserInterviewPreference(
        active_interview_id=active_interview_id,
        updated_at=updated_at,
    )


@router.post("/api/interview/respond", response_model=InterviewResponse)
async def interview_respond(payload: InterviewRequest, request: Request) -> InterviewResponse:
    tenant_id = _request_tenant_id(request)
    storage_key = _interview_key(tenant_id, payload.session_id)
    _reject_retired_reflection_mode(payload.business_context)
    with session_lock:
        existing_state = interview_sessions.get(storage_key)
        if existing_state is not None:
            _ensure_reflection_owner(existing_state, request)
            _reject_retired_reflection_mode({"analysis_mode": existing_state.analysis_mode})
    latest_user_text = next(
        (message.text for message in reversed(payload.messages) if message.role == "user"),
        "",
    )
    try:
        saved_attachments = await run_in_threadpool(
            save_interview_attachments,
            runtime.INTERVIEW_ATTACHMENT_DIR,
            tenant_id,
            payload.session_id,
            payload.attachments,
        )
    except InterviewAttachmentStorageError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    with session_lock:
        state = interview_sessions.get(storage_key)
        if state is None:
            analysis_mode = str((payload.business_context or {}).get("analysis_mode") or "discovery")
            stored_business_context = dict(payload.business_context or {})
            state = InterviewSessionState(
                session_id=payload.session_id,
                tenant_id=tenant_id,
                department=payload.department,
                participant=payload.participant,
                analysis_mode=analysis_mode,
                owner_email=_request_user_email_or_empty(request),
                created_at=datetime.now(timezone.utc).isoformat(),
                business_context=stored_business_context or None,
            )
            interview_sessions[storage_key] = state
        else:
            _ensure_reflection_owner(state, request)
        existing_history = interview_histories.get(storage_key, [])
        if payload.replace_pending_user_message:
            last_user_index = next(
                (index for index in range(len(existing_history) - 1, -1, -1) if existing_history[index].role == "user"),
                None,
            )
            if last_user_index is not None:
                existing_history = existing_history[:last_user_index]
        history = _merge_interview_messages(
            existing_history,
            [
                message.model_copy(update={"attachments": []})
                for message in payload.messages
            ],
        )
        _attach_files_to_latest_user_message(history, latest_user_text, saved_attachments)
        interview_histories[storage_key] = history
        _touch_interview_session(storage_key)
        _persist_interview_sessions()
        state_for_llm = state.model_copy(deep=True)
        request_for_llm = payload.model_copy(update={"messages": history})
    try:
        decision = await run_in_threadpool(generate_interview_response, request_for_llm, state_for_llm)
    except LLMInterviewError as exc:
        logger.exception("Interview response Gemini request failed: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    with session_lock:
        state = interview_sessions[storage_key]
        analysis_mode = (payload.business_context or {}).get("analysis_mode")
        _enforce_interview_transition(state, decision, analysis_mode)
        _update_session_state(
            state,
            decision,
            latest_user_text,
            [attachment.name for attachment in payload.attachments],
        )
        interview_histories[storage_key] = _merge_interview_messages(
            interview_histories.get(storage_key, []),
            [InterviewMessage(role="assistant", text=decision.reply)],
        )
        _touch_interview_session(storage_key)
        _persist_interview_sessions()
        state_snapshot = state.model_copy(deep=True)
    return _build_response(decision, state_snapshot)


@router.post("/api/interview/start", response_model=InterviewResponse)
async def interview_start(payload: StartInterviewRequest, request: Request) -> InterviewResponse:
    tenant_id = _request_tenant_id(request)
    storage_key = _interview_key(tenant_id, payload.session_id)
    _reject_retired_reflection_mode(payload.business_context)
    analysis_mode = str((payload.business_context or {}).get("analysis_mode") or "discovery")
    stored_business_context = dict(payload.business_context or {})
    state = InterviewSessionState(
        session_id=payload.session_id,
        tenant_id=tenant_id,
        department=payload.department,
        participant=payload.participant,
        analysis_mode=analysis_mode,
        owner_email=_request_user_email_or_empty(request),
        created_at=datetime.now(timezone.utc).isoformat(),
        business_context=stored_business_context or None,
        missing_items=[
            "業務の目的・成果",
            "開始条件と終了条件",
            "実際の基本フロー",
            "工程ごとの実行担当",
            "承認者・引き継ぎ先・次工程の担当",
            "システム・データ・証跡",
            "件数・時間・待ち時間",
            "判断・例外・差異・課題",
        ],
    )
    with session_lock:
        existing_state = interview_sessions.get(storage_key)
        if existing_state is not None:
            _ensure_reflection_owner(existing_state, request)
        interview_sessions[storage_key] = state
        interview_histories[storage_key] = []
        _touch_interview_session(storage_key)
        _persist_interview_sessions()
    try:
        decision = await run_in_threadpool(generate_initial_question, payload, state.model_copy(deep=True))
    except LLMInterviewError as exc:
        logger.exception("Interview start Gemini request failed: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    with session_lock:
        state = interview_sessions[storage_key]
        _update_session_state(state, decision, "")
        interview_histories[storage_key] = [
            InterviewMessage(role="assistant", text=decision.reply)
        ]
        _touch_interview_session(storage_key)
        _persist_interview_sessions()
        state_snapshot = state.model_copy(deep=True)
    return _build_response(decision, state_snapshot)


@router.post("/api/interview/transcribe", response_model=AudioTranscriptionResponse)
async def interview_transcribe(request: Request) -> AudioTranscriptionResponse:
    mime_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if mime_type not in SUPPORTED_AUDIO_MIME_TYPES:
        raise HTTPException(status_code=415, detail="対応していない音声形式です。")
    audio_bytes = await request.body()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="音声データが空です。")
    if len(audio_bytes) < MIN_AUDIO_BYTES:
        raise HTTPException(status_code=400, detail="録音が短すぎます。1秒以上話してから停止してください。")
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="音声データは8MB以下にしてください。")
    try:
        decision = await run_in_threadpool(generate_audio_transcription, audio_bytes, mime_type)
    except LLMInterviewError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    transcript = decision.transcript.strip()
    if TIMESTAMP_ONLY_PATTERN.fullmatch(transcript):
        transcript = ""
    if not transcript:
        raise HTTPException(status_code=422, detail="音声を聞き取れませんでした。マイクに近づいてもう一度お試しください。")
    return AudioTranscriptionResponse.model_validate(
        {
            **decision.model_dump(),
            "transcript": transcript,
            "provider": provider_for("transcription"),
            "model": model_for("transcription"),
        }
    )


@router.post("/api/interview/speech", response_class=Response)
async def interview_speech(payload: SpeechSynthesisRequest, request: Request) -> Response:
    voice, tone, pace = speech_options_for(payload.preferences, request)
    try:
        audio_content = await run_in_threadpool(synthesize_interview_speech, payload.text, voice, tone, pace)
    except SpeechRateLimitError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except SpeechSynthesisError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    # どちらの方式でも RIFF ヘッダー付きの WAV が返る。
    return Response(
        content=audio_content,
        media_type="audio/wav",
        headers={"X-Speech-Provider": speech_engine()},
    )


@router.post("/api/interview/speech/stream", response_class=StreamingResponse)
async def interview_speech_stream(payload: SpeechSynthesisRequest, request: Request) -> StreamingResponse:
    voice, tone, pace = speech_options_for(payload.preferences, request)
    try:
        audio_chunks = await run_in_threadpool(begin_interview_speech_stream, payload.text, voice, tone, pace)
    except SpeechRateLimitError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except SpeechSynthesisError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return StreamingResponse(
        audio_chunks,
        media_type=f"audio/pcm;rate={STREAMING_TTS_SAMPLE_RATE};channels=1",
        headers={
            "Cache-Control": "no-store",
            "X-Speech-Provider": f"{speech_engine()}-streaming",
            "X-Audio-Sample-Rate": str(STREAMING_TTS_SAMPLE_RATE),
            "X-Audio-Format": "pcm-s16le",
        },
    )


def _update_session_state(
    state: InterviewSessionState,
    decision: InterviewDecision,
    latest_user_text: str,
    attachment_names: list[str] | None = None,
) -> None:
    state.current_stage = decision.next_stage
    state.current_step = decision.current_step
    state.confirmed_facts = _merge_unique(state.confirmed_facts, decision.confirmed_facts)
    state.missing_items = _pending_items_after_decision(state, decision)
    state.contradictions = _merge_unique(state.contradictions, decision.contradictions)
    state.asked_questions = _merge_unique(state.asked_questions, [decision.reply])[-100:]
    if latest_user_text:
        state.evidence = _merge_unique(state.evidence, [latest_user_text])[-200:]
    if attachment_names:
        state.evidence = _merge_unique(
            state.evidence,
            [f"添付資料: {name}" for name in attachment_names],
        )[-200:]
    extracted_titles = [fragment.title for fragment in decision.extracted_fragments]
    if decision.fragment and decision.fragment_action in {"create", "update"}:
        extracted_titles.append(decision.fragment.title)
    state.process_steps = _merge_unique(state.process_steps, extracted_titles)
    state.process_end_confirmed = state.process_end_confirmed or decision.process_end_confirmed
    # gap_review_statusとphaseは_enforce_interview_transitionで整合済みのdecisionへ追従する。
    # 終了条件の判明だけでは補足確認へ進めず、里程標フェーズを維持する。
    if state.process_end_confirmed:
        if decision.gap_review_status == "完了" and not state.missing_items:
            state.gap_review_status = "完了"
        elif decision.gap_review_status == "確認中" or state.gap_review_status != "未開始":
            state.gap_review_status = "確認中"
    if state.process_end_confirmed and state.gap_review_status == "完了":
        state.phase = "完了" if decision.phase == "完了" and decision.is_complete else "要約確認"
    else:
        state.phase = decision.phase
    state.completion_score = max(state.completion_score, decision.completion_score)
    state.is_complete = bool(
        decision.is_complete
        and decision.phase == "完了"
        and state.process_end_confirmed
        and state.gap_review_status == "完了"
        and not state.missing_items
    )


def _enforce_interview_transition(
    state: InterviewSessionState,
    decision: InterviewDecision,
    analysis_mode: str | None = None,
) -> None:
    decision.completion_score = max(state.completion_score, decision.completion_score)
    if INTERVIEW_PHASE_ORDER[decision.phase] < INTERVIEW_PHASE_ORDER[state.phase]:
        decision.phase = state.phase
    process_end_confirmed = state.process_end_confirmed or decision.process_end_confirmed
    pending_items = _pending_items_after_decision(state, decision)
    if not process_end_confirmed:
        if decision.phase == "完了":
            decision.phase = state.phase
            decision.is_complete = False
        return

    decision.process_end_confirmed = True
    # 終了条件の判明はカバレッジ完了を意味しない。作業ごとの深掘りと差異・課題の
    # 確認が済む前は、補足確認以降へ進めず現在の里程標フェーズを維持する。
    # 追加ヒアリング（refinement）は既存As-Isを前提とするため早期の補足確認を許可する。
    coverage_ready = (
        analysis_mode == "refinement"
        or INTERVIEW_PHASE_ORDER[state.phase] >= INTERVIEW_PHASE_ORDER["差異・課題"]
    )
    if not coverage_ready:
        if INTERVIEW_PHASE_ORDER[decision.phase] >= INTERVIEW_PHASE_ORDER["補足確認"]:
            decision.phase = state.phase
            decision.gap_review_status = "未開始"
            decision.is_complete = False
        return
    if INTERVIEW_PHASE_ORDER[decision.phase] < INTERVIEW_PHASE_ORDER["補足確認"]:
        decision.is_complete = False
        return
    if pending_items:
        first_gap_turn = INTERVIEW_PHASE_ORDER[state.phase] < INTERVIEW_PHASE_ORDER["補足確認"]
        decision.phase = "補足確認"
        decision.gap_review_status = "確認中"
        decision.is_complete = False
        if first_gap_turn and "補足" not in decision.reply[:80]:
            decision.reply = (
                f"一連の流れを確認できました。ここからいくつか補足で伺います。{decision.reply}"
            )
        return

    decision.gap_review_status = "完了"
    if decision.phase not in {"要約確認", "完了"}:
        decision.phase = "要約確認"
    if decision.phase == "完了" and not decision.is_complete:
        decision.phase = "要約確認"


def _pending_items_after_decision(
    state: InterviewSessionState,
    decision: InterviewDecision,
) -> list[str]:
    resolved = {_normalize_item(item) for item in decision.resolved_items if item.strip()}
    unresolved = [
        item for item in state.missing_items
        if _normalize_item(item) not in resolved
    ]
    return _merge_unique(unresolved, decision.missing_items)[:30]


def _normalize_item(item: str) -> str:
    return "".join(item.split()).strip("。・、:：")


def _persist_interview_sessions() -> None:
    try:
        records = {
            storage_key: InterviewSessionRecord(
                session_state=state,
                messages=interview_histories.get(storage_key, []),
                updated_at=interview_updated_at.get(storage_key, ""),
            )
            for storage_key, state in interview_sessions.items()
        }
        runtime.store.save_interview_sessions(records)
    except Exception as exc:
        logger.warning("Interview sessions could not be persisted: %s", exc)


def _touch_interview_session(session_id: str) -> None:
    interview_updated_at[session_id] = datetime.now(timezone.utc).isoformat()


def _merge_interview_messages(
    current: list[InterviewMessage],
    incoming: list[InterviewMessage],
) -> list[InterviewMessage]:
    if not incoming:
        return list(current[-200:])
    if not current:
        return list(incoming[-200:])

    current_keys = [(message.role, message.text) for message in current]
    incoming_keys = [(message.role, message.text) for message in incoming]
    max_overlap = min(len(current_keys), len(incoming_keys))
    overlap = 0
    for size in range(max_overlap, 0, -1):
        if current_keys[-size:] == incoming_keys[:size]:
            overlap = size
            break
    merged = [*current, *incoming[overlap:]]
    deduplicated: list[InterviewMessage] = []
    for message in merged:
        if deduplicated and deduplicated[-1].role == message.role and deduplicated[-1].text == message.text:
            continue
        deduplicated.append(message)
    return deduplicated[-200:]


def _attach_files_to_latest_user_message(
    history: list[InterviewMessage],
    latest_user_text: str,
    attachments: list[SavedInterviewAttachment],
) -> None:
    if not attachments:
        return
    message = next(
        (
            item
            for item in reversed(history)
            if item.role == "user" and (not latest_user_text or item.text == latest_user_text)
        ),
        None,
    )
    if message is None:
        return
    existing_ids = {attachment.id for attachment in message.attachments}
    message.attachments = [
        *message.attachments,
        *(
            attachment
            for attachment in attachments
            if attachment.id not in existing_ids
        ),
    ][:20]


def _merge_unique(current: list[str], additions: list[str]) -> list[str]:
    return list(dict.fromkeys([*current, *[item for item in additions if item.strip()]]))


def _build_response(
    decision: InterviewDecision,
    state: InterviewSessionState,
) -> InterviewResponse:
    return InterviewResponse.model_validate(
        {
            **decision.model_dump(),
            "session_state": state.model_dump(),
            "provider": provider_for("chat"),
            "model": model_for("chat"),
        }
    )
