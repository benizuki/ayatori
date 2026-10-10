#!/usr/bin/env python3
"""サンプルのAs-Isフローを、起動中のAyatoriに投入する。

    python3 scripts/load-sample-process.py [--url http://127.0.0.1:8000] [--email you@example.com] [--business ap-invoice]

アプリ状態を保存していないテナントには、初回表示で同じサンプルが自動で入る。
このスクリプトは、すでに使っているテナントへ入れ直したいとき用。
お試しログイン（AYATORI_DEMO_LOGIN=1）が有効な環境向け。指定のメールでログインし、
サンプルがある業務のAs-Isを上書きする（中身は backend/app/resources/sample_processes.py）。
座標は画面を開いたときに自動で整列される。
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.app.resources.sample_processes import sample_process_models  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--email", default="sample@example.com")
    parser.add_argument("--tenant", default="default")
    parser.add_argument("--business", action="append", help="入れる業務のID。省略するとサンプルがある業務すべて")
    args = parser.parse_args()

    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

    def call(method: str, path: str, body: dict | None = None) -> dict:
        request = urllib.request.Request(
            args.url + path,
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json", "X-Tenant-ID": args.tenant},
        )
        try:
            with opener.open(request, timeout=30) as response:
                return json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as error:
            sys.exit(f"{method} {path} が失敗しました: {error.code} {error.read().decode(errors='replace')[:200]}")

    call("POST", "/api/auth/demo", {"email": args.email})
    payload = call("GET", "/api/app-state")["payload"]
    masters = [
        business for business in payload.get("businessMasters") or []
        if not args.business or business.get("id") in args.business
    ]
    samples = sample_process_models(masters)
    if not samples:
        sys.exit("サンプルがある業務がこのテナントの業務マスターにありません。")
    models = payload.get("processModels") or {}
    models.update(samples)
    payload["processModels"] = models
    call("PUT", "/api/app-state", {"payload": payload})
    for model in samples.values():
        print(f"投入しました：{model['title']}（{len(model['steps'])}工程・{len(model['lanes'])}レーン）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
