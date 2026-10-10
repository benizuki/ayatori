#!/usr/bin/env bash
set -euo pipefail

METADATA_URL="http://metadata.google.internal/computeMetadata/v1"
METADATA_HEADER="Metadata-Flavor: Google"

log() {
  printf '[ayatori-cloud-init] [%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

metadata() {
  curl -fsS -H "${METADATA_HEADER}" \
    "${METADATA_URL}/instance/attributes/$1" 2>/dev/null || true
}

project_id="$(curl -fsS -H "${METADATA_HEADER}" "${METADATA_URL}/project/project-id")"
service_name="$(metadata app-service-name)"
image="$(metadata app-image)"
data_disk_name="$(metadata app-data-disk-name)"
secret_id="$(metadata app-auth-secret-id)"
cloud_location="$(metadata app-cloud-location)"
gemini_model="$(metadata app-gemini-model)"
interview_thinking_level="$(metadata app-interview-thinking-level)"
document_model="$(metadata app-document-model)"
document_thinking_level="$(metadata app-document-thinking-level)"
tts_model="$(metadata app-tts-model)"
tts_voice="$(metadata app-tts-voice)"
tts_speaking_rate="$(metadata app-tts-speaking-rate)"
oauth_client_id="$(metadata app-google-oauth-client-id)"
cors_origins="$(metadata app-cors-origins)"
allowed_hosts="$(metadata app-allowed-hosts)"
host_port="$(metadata app-host-port)"
container_port="$(metadata app-container-port)"

service_name="${service_name:-ayatori}"
data_disk_name="${data_disk_name:-${service_name}-data}"
secret_id="${secret_id:-${service_name}-app-auth-secret}"
cloud_location="${cloud_location:-global}"
gemini_model="${gemini_model:-gemini-3.5-flash}"
interview_thinking_level="${interview_thinking_level:-LOW}"
document_model="${document_model:-${gemini_model}}"
document_thinking_level="${document_thinking_level:-HIGH}"
tts_model="${tts_model:-gemini-2.5-flash-tts}"
tts_voice="${tts_voice:-Sulafat}"
tts_speaking_rate="${tts_speaking_rate:-1.0}"
host_port="${host_port:-8080}"
container_port="${container_port:-8080}"

if [[ -z "${image}" ]]; then
  log "app-image メタデータが未設定です"
  exit 1
fi

data_device="/dev/disk/by-id/google-${data_disk_name}"
data_mount_dir="/mnt/disks/${service_name}-data"
runtime_dir="/mnt/stateful_partition/${service_name}-runtime"
env_file="${runtime_dir}/app.env"
docker_config_dir=""

cleanup() {
  if [[ -n "${docker_config_dir}" && -d "${docker_config_dir}" ]]; then
    rm -rf -- "${docker_config_dir}"
  fi
}
trap cleanup EXIT

log "永続ディスク ${data_disk_name} を準備します"
if [[ ! -b "${data_device}" ]]; then
  log "永続ディスクが見つかりません: ${data_device}"
  exit 1
fi

mkdir -p "${data_mount_dir}" "${runtime_dir}"
docker_config_dir="$(mktemp -d "${runtime_dir}/docker-config.XXXXXX")"
chmod 700 "${docker_config_dir}"
export DOCKER_CONFIG="${docker_config_dir}"

if ! blkid "${data_device}" >/dev/null 2>&1; then
  mkfs.ext4 -F -m 0 \
    -E lazy_itable_init=0,lazy_journal_init=0,discard \
    "${data_device}"
fi
if ! mountpoint -q "${data_mount_dir}"; then
  mount -o discard,defaults "${data_device}" "${data_mount_dir}"
fi

# Dockerfile 内の ayatori ユーザー (uid/gid 10001) に永続領域を渡します。
# 再起動のたびに全ファイルを走査しないよう、マウントポイントだけを変更します。
chown 10001:10001 "${data_mount_dir}"

log "Docker と Artifact Registry 認証を準備します"
systemctl start docker

access_token="$(
  curl -fsS -H "${METADATA_HEADER}" \
    "${METADATA_URL}/instance/service-accounts/default/token" \
    | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
)"
if [[ -z "${access_token}" ]]; then
  log "VM サービスアカウントのアクセストークンを取得できません"
  exit 1
fi

registry_host="${image%%/*}"
printf '%s' "${access_token}" \
  | docker login -u oauth2accesstoken --password-stdin "https://${registry_host}"

log "Secret Manager から ${secret_id} を取得します"
secret_payload="$(
  curl -fsS \
    -H "Authorization: Bearer ${access_token}" \
    "https://secretmanager.googleapis.com/v1/projects/${project_id}/secrets/${secret_id}/versions/latest:access" \
    | sed -n 's/.*"data"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
)"
if [[ -z "${secret_payload}" ]]; then
  log "Secret ${secret_id} の値を取得できません"
  exit 1
fi
app_auth_secret="$(printf '%s' "${secret_payload}" | base64 -d)"
if [[ "${app_auth_secret}" == *$'\n'* || "${app_auth_secret}" == *$'\r'* ]]; then
  log "APP_AUTH_SECRET に改行は使用できません"
  exit 1
fi

cat > "${env_file}" <<EOF
GOOGLE_CLOUD_PROJECT=${project_id}
GOOGLE_CLOUD_QUOTA_PROJECT=${project_id}
GOOGLE_CLOUD_LOCATION=${cloud_location}
VERTEX_GEMINI_MODEL=${gemini_model}
VERTEX_INTERVIEW_THINKING_LEVEL=${interview_thinking_level}
VERTEX_DOCUMENT_MODEL=${document_model}
VERTEX_DOCUMENT_THINKING_LEVEL=${document_thinking_level}
GEMINI_TTS_MODEL=${tts_model}
GEMINI_TTS_VOICE=${tts_voice}
GEMINI_TTS_SPEAKING_RATE=${tts_speaking_rate}
AYATORI_DATA_DIR=/app/data
AYATORI_SQLITE_PATH=/app/data/ayatori.sqlite
AYATORI_MASTER_DATA_DIR=/app/data/master-data
AYATORI_SESSION_STORE=/app/data/interview-sessions.json
AYATORI_INTERVIEW_ATTACHMENT_DIR=/app/data/interview-attachments
AYATORI_AUTH_DIR=/app/data/auth
# リージョン外部HTTPSロードバランサは X-Forwarded-For に接続元と自身のIPを足す。
AYATORI_TRUSTED_PROXY_HOPS=2
APP_AUTH_SECRET=${app_auth_secret}
EOF

if [[ -n "${oauth_client_id}" ]]; then
  printf 'GOOGLE_OAUTH_CLIENT_ID=%s\n' "${oauth_client_id}" >> "${env_file}"
fi
if [[ -n "${cors_origins}" ]]; then
  printf 'AYATORI_CORS_ORIGINS=%s\n' "${cors_origins}" >> "${env_file}"
fi
if [[ -n "${allowed_hosts}" ]]; then
  printf 'AYATORI_ALLOWED_HOSTS=%s\n' "${allowed_hosts}" >> "${env_file}"
fi
chmod 600 "${env_file}"

log "コンテナイメージを取得します: ${image}"
docker pull "${image}"
docker rm -f "${service_name}" >/dev/null 2>&1 || true
docker run -d \
  --name "${service_name}" \
  --restart unless-stopped \
  --env-file "${env_file}" \
  -v "${data_mount_dir}:/app/data" \
  -p "${host_port}:${container_port}" \
  "${image}"

log "コンテナ ${service_name} を起動しました"
