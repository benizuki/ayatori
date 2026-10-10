#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COS_ENV_FILE="${COS_ENV_FILE:-${SCRIPT_DIR}/cos.env}"

if [[ -f "${COS_ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${COS_ENV_FILE}"
fi

PROJECT_ID="${PROJECT_ID:?PROJECT_ID を ${COS_ENV_FILE} またはシェルで設定してください}"
REGION="${REGION:?REGION を ${COS_ENV_FILE} またはシェルで設定してください}"
ZONE="${ZONE:?ZONE を ${COS_ENV_FILE} またはシェルで設定してください}"

SERVICE_NAME="${SERVICE_NAME:-ayatori}"
AR_REPO="${AR_REPO:-ayatori}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

VM_NAME="${VM_NAME:-${SERVICE_NAME}-vm}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-standard-2}"
BOOT_DISK_SIZE="${BOOT_DISK_SIZE:-30GB}"
BOOT_DISK_TYPE="${BOOT_DISK_TYPE:-pd-balanced}"
NETWORK="${NETWORK:-default}"
SUBNET="${SUBNET:-default}"
NETWORK_TAGS="${NETWORK_TAGS:-${SERVICE_NAME},lb-health-check}"
ASSIGN_EXTERNAL_IP="${ASSIGN_EXTERNAL_IP:-true}"

DATA_DISK_NAME="${DATA_DISK_NAME:-${SERVICE_NAME}-data}"
DATA_DISK_SIZE="${DATA_DISK_SIZE:-50GB}"
DATA_DISK_TYPE="${DATA_DISK_TYPE:-pd-balanced}"

SA_ID="${SA_ID:-${SERVICE_NAME}-sa}"
SERVICE_ACCOUNT="${SA_ID}@${PROJECT_ID}.iam.gserviceaccount.com"
APP_AUTH_SECRET_ID="${APP_AUTH_SECRET_ID:-${SERVICE_NAME}-app-auth-secret}"
CREATE_APP_AUTH_SECRET="${CREATE_APP_AUTH_SECRET:-true}"

GOOGLE_CLOUD_LOCATION="${GOOGLE_CLOUD_LOCATION:-global}"
VERTEX_GEMINI_MODEL="${VERTEX_GEMINI_MODEL:-gemini-3.5-flash}"
VERTEX_INTERVIEW_THINKING_LEVEL="${VERTEX_INTERVIEW_THINKING_LEVEL:-LOW}"
VERTEX_DOCUMENT_MODEL="${VERTEX_DOCUMENT_MODEL:-${VERTEX_GEMINI_MODEL}}"
VERTEX_DOCUMENT_THINKING_LEVEL="${VERTEX_DOCUMENT_THINKING_LEVEL:-HIGH}"
GEMINI_TTS_MODEL="${GEMINI_TTS_MODEL:-gemini-2.5-flash-tts}"
GEMINI_TTS_VOICE="${GEMINI_TTS_VOICE:-Sulafat}"
GEMINI_TTS_SPEAKING_RATE="${GEMINI_TTS_SPEAKING_RATE:-1.0}"
GOOGLE_OAUTH_CLIENT_ID="${GOOGLE_OAUTH_CLIENT_ID:-}"
AYATORI_CORS_ORIGINS="${AYATORI_CORS_ORIGINS:-}"
HOST_PORT="${HOST_PORT:-8080}"
CONTAINER_PORT="${CONTAINER_PORT:-8080}"

CLOUD_CONFIG_TEMPLATE="${SCRIPT_DIR}/cloud-config.yaml"
BOOTSTRAP_SCRIPT="${SCRIPT_DIR}/startup.sh"
RENDERED_CLOUD_CONFIG=""

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

exists() {
  gcloud "$@" >/dev/null 2>&1
}

is_true() {
  [[ "${1,,}" == "true" || "${1}" == "1" || "${1,,}" == "yes" ]]
}

for command_name in gcloud; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "${command_name} コマンドが見つかりません" >&2
    exit 1
  fi
done
if [[ ! -f "${CLOUD_CONFIG_TEMPLATE}" ]]; then
  echo "Cloud Configテンプレートが見つかりません: ${CLOUD_CONFIG_TEMPLATE}" >&2
  exit 1
fi
if [[ ! -f "${BOOTSTRAP_SCRIPT}" ]]; then
  echo "Cloud-Init用ブートストラップが見つかりません: ${BOOTSTRAP_SCRIPT}" >&2
  exit 1
fi
if [[ ! "${SA_ID}" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
  echo "SA_ID は英小文字から始まる 6～30 文字の英小文字・数字・ハイフンにしてください: ${SA_ID}" >&2
  exit 1
fi

RENDERED_CLOUD_CONFIG="$(mktemp "${TMPDIR:-/tmp}/ayatori-cloud-config.XXXXXX")"
trap '[[ -n "${RENDERED_CLOUD_CONFIG}" ]] && rm -f "${RENDERED_CLOUD_CONFIG}"' EXIT
awk -v bootstrap_script="${BOOTSTRAP_SCRIPT}" '
  /^[[:space:]]*__AYATORI_BOOTSTRAP_SCRIPT__[[:space:]]*$/ {
    while ((getline line < bootstrap_script) > 0) print "      " line
    close(bootstrap_script)
    next
  }
  { print }
' "${CLOUD_CONFIG_TEMPLATE}" > "${RENDERED_CLOUD_CONFIG}"
if grep -q '__AYATORI_BOOTSTRAP_SCRIPT__' "${RENDERED_CLOUD_CONFIG}"; then
  echo "Cloud Configの生成に失敗しました" >&2
  exit 1
fi

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${SERVICE_NAME}:${IMAGE_TAG}"
GCLOUD_PROJECT=(--project "${PROJECT_ID}")
GCLOUD_LOCATION=(--location "${REGION}")
GCLOUD_ZONE=(--zone "${ZONE}")

log "必要な Google Cloud API を有効化します"
gcloud services enable \
  compute.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  aiplatform.googleapis.com \
  calendar-json.googleapis.com \
  drive.googleapis.com \
  texttospeech.googleapis.com \
  iam.googleapis.com \
  "${GCLOUD_PROJECT[@]}"

log "Artifact Registry リポジトリ ${AR_REPO} を確認します"
if ! exists artifacts repositories describe "${AR_REPO}" "${GCLOUD_LOCATION[@]}" "${GCLOUD_PROJECT[@]}"; then
  gcloud artifacts repositories create "${AR_REPO}" \
    --repository-format=docker \
    --description="${SERVICE_NAME} container images" \
    "${GCLOUD_LOCATION[@]}" \
    "${GCLOUD_PROJECT[@]}"
fi

log "外部ビルド済みのコンテナイメージを確認します: ${IMAGE}"
if ! gcloud artifacts docker images describe "${IMAGE}" \
  "${GCLOUD_PROJECT[@]}" >/dev/null 2>&1; then
  echo "デプロイ対象のコンテナイメージが見つかりません: ${IMAGE}" >&2
  echo "先にCloud BuildなどでイメージをビルドしてArtifact Registryへpushしてください" >&2
  exit 1
fi

log "VM 用サービスアカウント ${SERVICE_ACCOUNT} を確認します"
if ! exists iam service-accounts describe "${SERVICE_ACCOUNT}" "${GCLOUD_PROJECT[@]}"; then
  gcloud iam service-accounts create "${SA_ID}" \
    --display-name="${SERVICE_NAME} COS runtime" \
    "${GCLOUD_PROJECT[@]}"
fi

for role in roles/aiplatform.user roles/serviceusage.serviceUsageConsumer; do
  log "${SERVICE_ACCOUNT} に ${role} を付与します"
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role="${role}" \
    --condition=None \
    --quiet >/dev/null
done

log "Artifact Registry の読み取り権限を付与します"
gcloud artifacts repositories add-iam-policy-binding "${AR_REPO}" \
  "${GCLOUD_LOCATION[@]}" \
  "${GCLOUD_PROJECT[@]}" \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/artifactregistry.reader" \
  --condition=None \
  --quiet >/dev/null

log "アプリ認証 Secret ${APP_AUTH_SECRET_ID} を確認します"
if ! exists secrets describe "${APP_AUTH_SECRET_ID}" "${GCLOUD_PROJECT[@]}"; then
  if ! is_true "${CREATE_APP_AUTH_SECRET}"; then
    echo "Secret ${APP_AUTH_SECRET_ID} がありません。作成するか CREATE_APP_AUTH_SECRET=true を指定してください" >&2
    exit 1
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    echo "Secret の生成に必要な openssl が見つかりません" >&2
    exit 1
  fi
  log "ランダムなアプリ認証 Secret を作成します"
  openssl rand -base64 48 \
    | tr -d '\n' \
    | gcloud secrets create "${APP_AUTH_SECRET_ID}" \
      --replication-policy=automatic \
      --data-file=- \
      "${GCLOUD_PROJECT[@]}"
fi
gcloud secrets add-iam-policy-binding "${APP_AUTH_SECRET_ID}" \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/secretmanager.secretAccessor" \
  --condition=None \
  --quiet \
  "${GCLOUD_PROJECT[@]}" >/dev/null

log "永続ディスク ${DATA_DISK_NAME} を確認します"
if ! exists compute disks describe "${DATA_DISK_NAME}" "${GCLOUD_ZONE[@]}" "${GCLOUD_PROJECT[@]}"; then
  gcloud compute disks create "${DATA_DISK_NAME}" \
    --size="${DATA_DISK_SIZE}" \
    --type="${DATA_DISK_TYPE}" \
    "${GCLOUD_ZONE[@]}" \
    "${GCLOUD_PROJECT[@]}"
fi

metadata_values=(
  "app-service-name=${SERVICE_NAME}"
  "app-image=${IMAGE}"
  "app-data-disk-name=${DATA_DISK_NAME}"
  "app-auth-secret-id=${APP_AUTH_SECRET_ID}"
  "app-cloud-location=${GOOGLE_CLOUD_LOCATION}"
  "app-gemini-model=${VERTEX_GEMINI_MODEL}"
  "app-interview-thinking-level=${VERTEX_INTERVIEW_THINKING_LEVEL}"
  "app-document-model=${VERTEX_DOCUMENT_MODEL}"
  "app-document-thinking-level=${VERTEX_DOCUMENT_THINKING_LEVEL}"
  "app-tts-model=${GEMINI_TTS_MODEL}"
  "app-tts-voice=${GEMINI_TTS_VOICE}"
  "app-tts-speaking-rate=${GEMINI_TTS_SPEAKING_RATE}"
  "app-google-oauth-client-id=${GOOGLE_OAUTH_CLIENT_ID}"
  "app-cors-origins=${AYATORI_CORS_ORIGINS}"
  "app-host-port=${HOST_PORT}"
  "app-container-port=${CONTAINER_PORT}"
  # 旧startup-script方式から更新するVMで二重起動しないよう空値で上書きします。
  "startup-script="
)
for metadata_value in "${metadata_values[@]}"; do
  if [[ "${metadata_value}" == *"|"* || "${metadata_value}" == *$'\n'* || "${metadata_value}" == *$'\r'* ]]; then
    echo "メタデータ値に使用できない文字（| または改行）が含まれています: ${metadata_value%%=*}" >&2
    exit 1
  fi
done
# gcloud の辞書フラグは通常カンマ区切りです。CORS 設定にカンマを含められるよう、
# 値には通常現れない "|" を区切り文字として明示します。
metadata_arg="^|^$(IFS='|'; printf '%s' "${metadata_values[*]}")"

log "Container-Optimized OS VM ${VM_NAME} を作成または更新します"
if ! exists compute instances describe "${VM_NAME}" "${GCLOUD_ZONE[@]}" "${GCLOUD_PROJECT[@]}"; then
  address_args=()
  if ! is_true "${ASSIGN_EXTERNAL_IP}"; then
    address_args+=(--no-address)
  fi
  gcloud compute instances create "${VM_NAME}" \
    --machine-type="${MACHINE_TYPE}" \
    --boot-disk-size="${BOOT_DISK_SIZE}" \
    --boot-disk-type="${BOOT_DISK_TYPE}" \
    --image-family=cos-stable \
    --image-project=cos-cloud \
    --network="${NETWORK}" \
    --subnet="${SUBNET}" \
    "${address_args[@]}" \
    --tags="${NETWORK_TAGS}" \
    --service-account="${SERVICE_ACCOUNT}" \
    --scopes=cloud-platform \
    --shielded-secure-boot \
    --shielded-vtpm \
    --shielded-integrity-monitoring \
    --disk="name=${DATA_DISK_NAME},device-name=${DATA_DISK_NAME},mode=rw,boot=no,auto-delete=no" \
    --metadata="${metadata_arg}" \
    --metadata-from-file="user-data=${RENDERED_CLOUD_CONFIG}" \
    "${GCLOUD_ZONE[@]}" \
    "${GCLOUD_PROJECT[@]}"
else
  gcloud compute instances add-tags "${VM_NAME}" \
    --tags="${NETWORK_TAGS}" \
    "${GCLOUD_ZONE[@]}" \
    "${GCLOUD_PROJECT[@]}" >/dev/null

  if ! gcloud compute instances describe "${VM_NAME}" \
    "${GCLOUD_ZONE[@]}" "${GCLOUD_PROJECT[@]}" \
    --flatten='disks[]' \
    --format='value(disks.deviceName)' \
    | grep -Fx "${DATA_DISK_NAME}" >/dev/null 2>&1; then
    gcloud compute instances attach-disk "${VM_NAME}" \
      --disk="${DATA_DISK_NAME}" \
      --device-name="${DATA_DISK_NAME}" \
      "${GCLOUD_ZONE[@]}" \
      "${GCLOUD_PROJECT[@]}"
  fi

  current_sa="$(
    gcloud compute instances describe "${VM_NAME}" \
      "${GCLOUD_ZONE[@]}" "${GCLOUD_PROJECT[@]}" \
      --format='value(serviceAccounts[0].email)'
  )"
  if [[ "${current_sa}" != "${SERVICE_ACCOUNT}" ]]; then
    log "VM のサービスアカウントを更新します"
    gcloud compute instances stop "${VM_NAME}" --quiet \
      "${GCLOUD_ZONE[@]}" "${GCLOUD_PROJECT[@]}"
    gcloud compute instances set-service-account "${VM_NAME}" \
      --service-account="${SERVICE_ACCOUNT}" \
      --scopes=cloud-platform \
      "${GCLOUD_ZONE[@]}" \
      "${GCLOUD_PROJECT[@]}"
  fi

  gcloud compute instances add-metadata "${VM_NAME}" \
    --metadata="${metadata_arg}" \
    --metadata-from-file="user-data=${RENDERED_CLOUD_CONFIG}" \
    "${GCLOUD_ZONE[@]}" \
    "${GCLOUD_PROJECT[@]}"

  vm_status="$(
    gcloud compute instances describe "${VM_NAME}" \
      "${GCLOUD_ZONE[@]}" "${GCLOUD_PROJECT[@]}" \
      --format='value(status)'
  )"
  if [[ "${vm_status}" == "RUNNING" ]]; then
    gcloud compute instances reset "${VM_NAME}" --quiet \
      "${GCLOUD_ZONE[@]}" "${GCLOUD_PROJECT[@]}"
  else
    gcloud compute instances start "${VM_NAME}" --quiet \
      "${GCLOUD_ZONE[@]}" "${GCLOUD_PROJECT[@]}"
  fi
fi

external_ip="$(
  gcloud compute instances describe "${VM_NAME}" \
    "${GCLOUD_ZONE[@]}" "${GCLOUD_PROJECT[@]}" \
    --format='value(networkInterfaces[0].accessConfigs[0].natIP)'
)"

cat <<EOF

COS へのデプロイを開始しました。

VM:        ${VM_NAME}
Zone:      ${ZONE}
Image:     ${IMAGE}
Data disk: ${DATA_DISK_NAME}
Service account: ${SERVICE_ACCOUNT}
External IP: ${external_ip:-なし}

起動ログ:
  gcloud compute instances get-serial-port-output ${VM_NAME} --zone=${ZONE} --project=${PROJECT_ID}

コンテナ確認:
  gcloud compute ssh ${VM_NAME} --zone=${ZONE} --project=${PROJECT_ID} --command='docker ps && docker logs --tail=100 ${SERVICE_NAME}'
EOF
