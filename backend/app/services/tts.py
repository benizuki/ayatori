"""AI質問の読み上げ。方式はシステム設定（なければ AYATORI_TTS_ENGINE）で選ぶ。

- cloud-tts（既定）: Google Cloud Text-to-Speech を Google Cloud の認証（ADC / WIF）で呼ぶ（②。cloud_tts.py）。
- gemini-tts: Gemini API（Interactions API）を Gemini API キーで呼ぶ（①）。

どちらもストリーミングは 24kHz・16bit・モノラルのヘッダーなし PCM を逐次返し、
一括合成は RIFF ヘッダー付きの WAV を返す。画面側はどちらの方式かを意識しなくてよい。
"""

from __future__ import annotations

import base64
import logging
import os
from collections.abc import Iterator
from functools import lru_cache
from typing import Any

from .gemini import GeminiError, gemini_api_key_client

DEFAULT_TTS_MODEL = "gemini-3.8-flash-tts"
DEFAULT_TTS_VOICE = "Sulafat"
# Gemini TTS への話し方の指示。長い指示は声の調子が引っ張られ、音声が返らないこともあるため、
# 既定では送らない。調整したいときだけ GEMINI_TTS_STYLE に短い言葉で指定する（例: calm, friendly）。
DEFAULT_TTS_STYLE = ""
# 生成型の読み上げは、同じ声の指定でも呼び出しごとに声の高さや質感が揺れる。
# 毎回同じシードで生成して揺れを抑える。GEMINI_TTS_SEED を空にすると指定しない。
DEFAULT_TTS_SEED = 20_260_929
DEFAULT_TTS_LANGUAGE = "ja-JP"
# Cloud Text-to-Speech へ渡す話し方の指示。Cloud 側は長めの指示でも安定して従う。
DEFAULT_CLOUD_TTS_PROMPT = (
    "製造業の現状分析を行う経験豊富な業務コンサルタントとして、"
    "落ち着いた親しみやすい日本語で話してください。"
    "すべての発話で声の高さ、感情量、話す速さを一定に保ってください。"
    "質問は明瞭に、句読点では自然な間を取り、急がず読み上げてください。"
    "入力された文章を省略、言い換え、追加せず、そのまま読み上げてください。"
)
MAX_TTS_FIELD_BYTES = 4_000
STREAMING_TTS_SAMPLE_RATE = 24_000

# 利用者が選べる声。説明は公式の特徴（Bright、Upbeat など）の訳。hinami と同じ候補にそろえる。
VOICE_CATALOG: tuple[tuple[str, str], ...] = (
    ("Zephyr", "明るい"),
    ("Puck", "元気"),
    ("Charon", "説明的"),
    ("Kore", "しっかり"),
    ("Fenrir", "躍動的"),
    ("Leda", "若々しい"),
    ("Orus", "しっかり"),
    ("Aoede", "さわやか"),
    ("Callirrhoe", "おおらか"),
    ("Autonoe", "明るい"),
    ("Enceladus", "息づかいのある"),
    ("Iapetus", "くっきり"),
    ("Umbriel", "おおらか"),
    ("Algieba", "なめらか"),
    ("Despina", "なめらか"),
    ("Erinome", "くっきり"),
    ("Algenib", "かすれた"),
    ("Rasalgethi", "説明的"),
    ("Laomedeia", "元気"),
    ("Achernar", "やわらか"),
    ("Alnilam", "しっかり"),
    ("Schedar", "平静"),
    ("Gacrux", "落ち着き"),
    ("Pulcherrima", "前向き"),
    ("Achird", "親しみやすい"),
    ("Zubenelgenubi", "くだけた"),
    ("Vindemiatrix", "やさしい"),
    ("Sadachbia", "生き生き"),
    ("Sadaltager", "知的"),
    ("Sulafat", "温かい"),
)
VOICE_NAMES = frozenset(name for name, _ in VOICE_CATALOG)
# トーンは (Gemini TTS への短い英語の指示, 画面の表示, Cloud TTS の指示へ足す一文)。
# Gemini TTS は長い指示で声の調子がぶれるため短い英語にし、Cloud TTS は既定の指示に一文を足す。
TONE_STYLES: dict[str, tuple[str, str, str]] = {
    "default": ("", "指定なし", ""),
    "calm": ("calm", "穏やか", "穏やかなトーンで話してください。"),
    "friendly": ("friendly", "親しみやすい", "親しみやすいトーンで話してください。"),
    "cheerful": ("cheerful", "明るい", "明るいトーンで話してください。"),
}
# ペースは Gemini TTS には短い英語の指示、Cloud TTS には話す速さの倍率（cloud_tts.py）で渡す。
PACE_STYLES: dict[str, tuple[str, str]] = {
    "normal": ("", "ふつう"),
    "slow": ("slow", "ゆっくり"),
    "fast": ("fast", "速め"),
}

logger = logging.getLogger(__name__)


class SpeechSynthesisError(RuntimeError):
    pass


class SpeechRateLimitError(SpeechSynthesisError):
    """読み上げの利用上限に達した。時間をおけば再び使える。"""


def speech_engine() -> str:
    """読み上げの方式（gemini-tts / cloud-tts）。"""
    from ..core.ai_models import effective_ai_models

    return effective_ai_models()["speech_engine"]


def speech_model() -> str:
    """読み上げのモデル。方式ごとの既定（GEMINI_TTS_MODEL / CLOUD_TTS_MODEL）を画面の値で上書きできる。"""
    from ..core.ai_models import effective_ai_models

    return effective_ai_models()["speech_model"]


def default_voice() -> str:
    return os.getenv("GEMINI_TTS_VOICE", DEFAULT_TTS_VOICE).strip() or DEFAULT_TTS_VOICE


def speech_style(tone: str, pace: str) -> str | None:
    """利用者のトーン・ペースを Gemini TTS への話し方の指示にする。どちらも既定なら None（システムの既定に従う）。"""
    words = [part for part in (TONE_STYLES.get(tone, ("", "", ""))[0], PACE_STYLES.get(pace, ("", ""))[0]) if part]
    return ", ".join(words) if words else None


def synthesize_interview_speech(
    text: str, voice: str | None = None, tone: str = "default", pace: str = "normal"
) -> bytes:
    """文章全体を WAV で返す。同じ文章と設定はキャッシュから返す。

    voice を省くと GEMINI_TTS_VOICE、トーン・ペースが既定ならシステムの既定の話し方を使う。
    """
    normalized_text = _normalized_text(text)
    voice = voice or default_voice()
    if speech_engine() == "cloud-tts":
        from .cloud_tts import synthesize_cloud_speech

        return synthesize_cloud_speech(normalized_text, voice, _cloud_prompt(tone), pace)
    return _synthesize_cached(normalized_text, speech_model(), voice, _gemini_style(tone, pace), _speech_seed())


def begin_interview_speech_stream(
    text: str, voice: str | None = None, tone: str = "default", pace: str = "normal"
) -> Iterator[bytes]:
    """読み上げを開始し、最初の音声が届いてから PCM の塊を順に返すイテレーターを返す。

    最初の塊を待ってから返すので、呼び出し側は失敗を HTTP のエラーとして返せる。
    """
    normalized_text = _normalized_text(text)
    voice = voice or default_voice()
    if speech_engine() == "cloud-tts":
        from .cloud_tts import begin_cloud_speech_stream

        return begin_cloud_speech_stream(normalized_text, voice, _cloud_prompt(tone), pace)
    try:
        stream = _client().interactions.create(
            **_interaction_request(normalized_text, speech_model(), voice, _gemini_style(tone, pace), _speech_seed()),
            response_format={"type": "audio", "mime_type": "audio/l16", "sample_rate": STREAMING_TTS_SAMPLE_RATE},
            stream=True,
        )
        events = iter(stream)
        first_chunk = _next_audio_chunk(events)
    except SpeechSynthesisError:
        raise
    except Exception as exc:
        _raise_if_rate_limited(exc)
        raise SpeechSynthesisError(f"Gemini TTS ストリーミングの開始に失敗しました: {exc}") from exc

    def chunks() -> Iterator[bytes]:
        try:
            yield first_chunk
            for event in events:
                chunk = _audio_delta(event)
                if chunk:
                    yield chunk
        except SpeechSynthesisError:
            raise
        except Exception as exc:
            raise SpeechSynthesisError(f"Gemini TTS ストリーミングの受信に失敗しました: {exc}") from exc
        finally:
            close = getattr(stream, "close", None)
            if callable(close):
                close()

    return chunks()


def _normalized_text(text: str) -> str:
    normalized_text = " ".join(text.split()).strip()
    if not normalized_text:
        raise SpeechSynthesisError("読み上げる文章が空です。")
    if len(normalized_text.encode("utf-8")) > MAX_TTS_FIELD_BYTES:
        raise SpeechSynthesisError("読み上げる文章が4,000バイトを超えています。")
    return normalized_text


def _cloud_prompt(tone: str = "default") -> str:
    prompt = os.getenv("GEMINI_TTS_PROMPT", DEFAULT_CLOUD_TTS_PROMPT).strip()
    tone_sentence = TONE_STYLES.get(tone, ("", "", ""))[2]
    if tone_sentence:
        prompt = f"{prompt}{tone_sentence}"
    if len(prompt.encode("utf-8")) > MAX_TTS_FIELD_BYTES:
        raise SpeechSynthesisError("GEMINI_TTS_PROMPT が4,000バイトを超えています。")
    return prompt


def _gemini_style(tone: str = "default", pace: str = "normal") -> str:
    preferred = speech_style(tone, pace)
    style = (os.getenv("GEMINI_TTS_STYLE", DEFAULT_TTS_STYLE) if preferred is None else preferred).strip()
    if len(style.encode("utf-8")) > MAX_TTS_FIELD_BYTES:
        raise SpeechSynthesisError("GEMINI_TTS_STYLE が4,000バイトを超えています。")
    return style


def _interaction_request(text: str, model: str, voice: str, style: str, seed: int | None) -> dict[str, Any]:
    content: dict[str, Any] = {"type": "text", "text": text}
    if style:
        content["annotations"] = [{"type": "speech_metadata", "style": style}]
    speaker: dict[str, str] = {"voice": voice}
    language = os.getenv("GEMINI_TTS_LANGUAGE", DEFAULT_TTS_LANGUAGE).strip()
    if language:
        speaker["language"] = language
    generation_config: dict[str, Any] = {"speech_config": [speaker]}
    if seed is not None:
        generation_config["seed"] = seed
    return {
        "model": model,
        "input": [{"type": "user_input", "content": [content]}],
        "generation_config": generation_config,
    }


def _speech_seed() -> int | None:
    raw = os.getenv("GEMINI_TTS_SEED")
    if raw is None:
        return DEFAULT_TTS_SEED
    if not raw.strip():
        return None
    try:
        return int(raw.strip())
    except ValueError:
        logger.warning("GEMINI_TTS_SEED is not an integer; using the default seed.")
        return DEFAULT_TTS_SEED


def _raise_for_error_event(event: Any) -> None:
    """ストリームで届いたエラーを、理由の分かる例外にする。黙って無音で終わらせない。"""
    if getattr(event, "event_type", "") != "error":
        return
    error = getattr(event, "error", None)
    code = str(getattr(error, "code", "") or (error.get("code") if isinstance(error, dict) else "") or "")
    message = str(getattr(error, "message", "") or (error.get("message") if isinstance(error, dict) else "") or "")
    if code == "rate_limit_exceeded":
        raise SpeechRateLimitError(f"Gemini TTS の利用上限に達しました。時間をおいてから再度お試しください。（{message}）")
    raise SpeechSynthesisError(f"Gemini TTS でエラーが発生しました: {code or '不明'} {message}".strip())


def _raise_if_rate_limited(exc: Exception) -> None:
    """SDK が HTTP 429 として返した上限超過を、ストリームのエラーと同じ例外にそろえる。"""
    if getattr(exc, "code", None) == 429:
        raise SpeechRateLimitError(
            f"Gemini TTS の利用上限に達しました。時間をおいてから再度お試しください。（{getattr(exc, 'message', '') or exc}）"
        ) from exc


def _audio_delta(event: Any) -> bytes:
    _raise_for_error_event(event)
    if getattr(event, "event_type", "") != "step.delta":
        return b""
    delta = getattr(event, "delta", None)
    if getattr(delta, "type", "") != "audio":
        return b""
    data = getattr(delta, "data", None)
    return base64.b64decode(data) if data else b""


def _next_audio_chunk(events: Iterator[Any]) -> bytes:
    for event in events:
        chunk = _audio_delta(event)
        if chunk:
            return chunk
    raise SpeechSynthesisError("Gemini TTS から音声データを取得できませんでした。")


@lru_cache(maxsize=128)
def _synthesize_cached(text: str, model: str, voice: str, style: str, seed: int | None) -> bytes:
    try:
        interaction = _client().interactions.create(
            **_interaction_request(text, model, voice, style, seed),
            response_format={"type": "audio"},
        )
        data = getattr(getattr(interaction, "output_audio", None), "data", None)
    except SpeechSynthesisError:
        raise
    except Exception as exc:
        _raise_if_rate_limited(exc)
        raise SpeechSynthesisError(f"Gemini TTS の呼び出しに失敗しました: {exc}") from exc
    if not data:
        raise SpeechSynthesisError("Gemini TTS から音声データを取得できませんでした。")
    return base64.b64decode(data)


def _client() -> Any:
    try:
        # Interactions API の読み上げは Gemini API でだけ使える。対話の接続が Vertex AI でもキーで呼ぶ。
        return gemini_api_key_client()
    except GeminiError as exc:
        raise SpeechSynthesisError(str(exc)) from exc
