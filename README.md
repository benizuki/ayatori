# Ayatori

Ayatori（綾取り）は、AIとのヒアリングで業務の実態を整理し、現在の業務の流れ（As-Is）を作成・編集するWebアプリです。業務資料や担当者の説明から、作業、担当、情報の受け渡し、課題を見える形にします。

## 主な機能

- AIとの対話による業務ヒアリングと、根拠を持つ作業情報の整理
- PDF・画像の業務資料から業務候補とAs-Isドラフトを作成
- スイムレーンを使ったAs-Isプロセスの編集、保存版の管理、追加ヒアリング
- 業務マスター、業務マップ、組織、利用者、テナントの管理
- タスクの分類とAI活用・業務改善候補の検討
- 音声入力と質問の読み上げ
- Gemini APIまたはVertex AIの利用

## Quick Start

必要なものはDockerとDocker Composeです。

```bash
docker compose up -d --build
```

起動したら <http://127.0.0.1:8000/> を開きます。ログイン画面では任意のメールアドレスを入力できます。最初にログインしたユーザーが全体管理者になり、以降のユーザーは一般利用者になります。初期データには、業務マスターとAs-Isのサンプルが含まれます。

AIを使う場合は、全体管理者でログインして「システム設定」からGemini APIキーを登録するか、Vertex AIの接続を設定してください。Vertex AIをローカルのDocker Composeから使う場合は、事前に `gcloud auth application-default login` を実行し、リポジトリ直下の `.env` に `GOOGLE_CLOUD_PROJECT` を設定します。

終了するには次を実行します。

```bash
docker compose down
```

> このCompose構成は手元で試すためのものです。パスワードなしのお試しログインを使い、公開ポートを `127.0.0.1` に限定しています。他の端末やインターネットへ公開しないでください。

## データ

Docker Composeでは、業務データや設定をDockerボリューム `ayatori-data` に保存します。コンテナを作り直してもデータは残ります。

ローカル実行時は、既定で `backend/app/data/` に保存します。ヒアリングとAs-Isの正本はSQLite、業務マスターや認証情報などはファイルで管理します。実データと `.env` はGitの追跡対象外です。画面から作成するSQLiteバックアップには、業務マスター、添付ファイル、認証情報は含まれません。

## 設定

主な環境変数は次のとおりです。AIの接続方法とモデルは、全体管理者が「システム設定」からも変更できます。

| 変数 | 用途 |
| --- | --- |
| `GOOGLE_CLOUD_PROJECT` | Vertex AIとCloud Text-to-Speechを使うGoogle Cloudプロジェクト |
| `GOOGLE_CLOUD_LOCATION` | Vertex AIのリージョン |
| `GEMINI_API_KEY` | Gemini APIを使う場合のAPIキー。画面からの登録も可能 |
| `GOOGLE_OAUTH_CLIENT_ID` | 公開環境で使うGoogleログインのOAuthクライアントID |
| `APP_AUTH_SECRET` | ログイントークンの署名鍵。Googleログイン時は必須 |
| `AYATORI_BOOTSTRAP_ADMIN_EMAILS` | Googleログインで初回管理者にするメールアドレス |
| `AYATORI_DATA_DIR` | 実行時データの保存先 |

公開環境ではGoogle OAuthと署名鍵を設定してください。初回管理者のメールアドレスは `AYATORI_BOOTSTRAP_ADMIN_EMAILS` で指定します。

## 開発

必要なものはPython 3.12、[uv](https://docs.astral.sh/uv/)、Node.jsです。

```bash
uv sync
npm --prefix frontend ci
npm --prefix frontend run build
uv run python -m backend
```

<http://127.0.0.1:8000/> を開きます。AIの設定なしでも画面は起動します。フロントエンドをViteの開発サーバーで動かす場合は、別のターミナルで `npm --prefix frontend run dev` を実行します。

## テスト

```bash
uv run python -m unittest discover -s backend/tests -p 'test_*.py'
npm --prefix frontend run test:improvement
npm --prefix frontend run build
```

## 技術構成

- Vue 3 / TypeScript / Vuetify 3 / Vite
- FastAPI / Python
- SQLite / JSON
- Gemini API / Vertex AI / Cloud Text-to-Speech

## ライセンス

[Apache License 2.0](LICENSE)
