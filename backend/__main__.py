"""Serve the pre-built Ayatori frontend and FastAPI backend."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from dotenv import load_dotenv


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    # ローカル開発用の .env はここで読む。アプリ本体（main.py）は読み込まないので、
    # テストやコンテナは渡された環境変数だけで動く。既に設定済みの値は上書きしない。
    load_dotenv(root / ".env")
    local_uvicorn = root / ".venv" / "bin" / "uvicorn"
    uvicorn = str(local_uvicorn) if local_uvicorn.is_file() else shutil.which("uvicorn")
    if uvicorn is None:
        raise SystemExit("uvicornが見つかりません。バックエンド依存関係をインストールしてください。")

    host = os.getenv("AYATORI_API_HOST", "127.0.0.1")
    port = os.getenv("AYATORI_API_PORT", "8000")
    os.environ["AYATORI_API_HOST"] = host
    args = [uvicorn, "backend.app.main:app", "--host", host, "--port", port]
    if os.getenv("AYATORI_RELOAD", "").lower() in {"1", "true", "yes"}:
        args.append("--reload")

    os.chdir(root)
    os.execv(uvicorn, args)


if __name__ == "__main__":
    main()
