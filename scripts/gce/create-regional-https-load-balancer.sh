#!/usr/bin/env bash
set -euo pipefail

# リージョン外部HTTPSロードバランサを作成または更新します。
# gce.env の最新の環境変数をすべて適用します。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GCE_ENV_FILE="${GCE_ENV_FILE:-${SCRIPT_DIR}/cos.env}"
if [[ -f "${GCE_ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${GCE_ENV_FILE}"
fi

# ==================================================
# 変数の評価（gce.env から読み込まれた値、またはデフォルト）
# ==================================================
PROJECT_ID="${PROJECT_ID:?PROJECT_ID を ${GCE_ENV_FILE} またはシェルで設定してください。}"
REGION="${REGION:?REGION を ${GCE_ENV_FILE} またはシェルで設定してください。}"
ZONE="${ZONE:?ZONE を ${GCE_ENV_FILE} またはシェルで設定してください。}"

VM_NAME="${VM_NAME:-ot-security-review-vm}"
NETWORK="${NETWORK:-security-local-vpc}"
PROXY_ONLY_SUBNET_NAME="${PROXY_ONLY_SUBNET_NAME:-security-an1-proxy-1}"

LB_NAME="${LB_NAME:-ot-security-review-lb}"
DOMAIN="${DOMAIN:?DOMAIN を ${GCE_ENV_FILE} で設定してください。}"

IP_NAME="${IP_NAME:-${LB_NAME}-ip}"
INSTANCE_GROUP="${INSTANCE_GROUP:-${LB_NAME}-ig}"
HEALTH_CHECK="${HEALTH_CHECK:-${LB_NAME}-hc}"
BACKEND_SERVICE="${BACKEND_SERVICE:-${LB_NAME}-backend}"
URL_MAP="${URL_MAP:-${LB_NAME}-url-map}"
HTTPS_PROXY="${HTTPS_PROXY:-${LB_NAME}-https-proxy}"
HTTPS_FORWARDING_RULE="${HTTPS_FORWARDING_RULE:-${LB_NAME}-https-rule}"
SSL_CERTIFICATE="${SSL_CERTIFICATE:-${LB_NAME}-cert}"

# TLSの下限。既定のSSLポリシーはTLS1.0まで許すため、明示したポリシーを付ける。
SSL_POLICY="${SSL_POLICY:-${LB_NAME}-ssl-policy}"
SSL_POLICY_PROFILE="${SSL_POLICY_PROFILE:-MODERN}"
SSL_MIN_TLS_VERSION="${SSL_MIN_TLS_VERSION:-1.3}"

# Cloud Armor（リージョン付きBackend Serviceに適用するポリシー）
CLOUD_ARMOR_ENABLED="${CLOUD_ARMOR_ENABLED:-false}"
CLOUD_ARMOR_POLICY="${CLOUD_ARMOR_POLICY:-${LB_NAME}-armor-policy}"

# WAF（SQLi / XSS / RCE）とレート制限を検知のみに留めるかどうか。
# true の間は拒否せずログだけ残るため、誤検知を確認してから false にする。
CLOUD_ARMOR_WAF_PREVIEW="${CLOUD_ARMOR_WAF_PREVIEW:-true}"
CLOUD_ARMOR_RATE_LIMIT_PREVIEW="${CLOUD_ARMOR_RATE_LIMIT_PREVIEW:-true}"

# レート制限（同一送信元IPあたり）としきい値超過後のBAN設定
CLOUD_ARMOR_RATE_LIMIT_COUNT="${CLOUD_ARMOR_RATE_LIMIT_COUNT:-100}"
CLOUD_ARMOR_RATE_LIMIT_INTERVAL_SEC="${CLOUD_ARMOR_RATE_LIMIT_INTERVAL_SEC:-60}"
CLOUD_ARMOR_BAN_THRESHOLD_COUNT="${CLOUD_ARMOR_BAN_THRESHOLD_COUNT:-300}"
CLOUD_ARMOR_BAN_THRESHOLD_INTERVAL_SEC="${CLOUD_ARMOR_BAN_THRESHOLD_INTERVAL_SEC:-120}"
CLOUD_ARMOR_BAN_DURATION_SEC="${CLOUD_ARMOR_BAN_DURATION_SEC:-600}"

# Cloud Armor のリクエスト解析設定（Terraform の advanced_options_config 相当）
CLOUD_ARMOR_JSON_PARSING="${CLOUD_ARMOR_JSON_PARSING:-STANDARD}"
CLOUD_ARMOR_LOG_LEVEL="${CLOUD_ARMOR_LOG_LEVEL:-VERBOSE}"

# ヘルスチェック元のGoogle内部レンジ。これを許可しないと地域制限でバックエンドが落ちる。
HEALTH_CHECK_SOURCE_RANGES="${HEALTH_CHECK_SOURCE_RANGES:-35.191.0.0/16,130.211.0.0/22}"

# 接続元IPの許可リスト（カンマ区切り。CIDRまたは単一IP）。
# 設定するとここに載っていないIPからのアクセスをすべて拒否する。
# 空にすると許可リストのルールを削除し、IPによる制限は行わない。
CLOUD_ARMOR_ALLOWED_IP_RANGES="${CLOUD_ARMOR_ALLOWED_IP_RANGES:-}"
# 締め出しが怖い場合は true にすると、拒否せずログにだけ残す。
CLOUD_ARMOR_IP_ALLOWLIST_PREVIEW="${CLOUD_ARMOR_IP_ALLOWLIST_PREVIEW:-false}"

# Certificate Manager 用のDNS認証リソース名
DNS_AUTH_NAME="${LB_NAME}-dns-auth"

case "${SSL_POLICY_PROFILE}" in
  COMPATIBLE|MODERN|RESTRICTED)
    ;;
  *)
    # CUSTOM は暗号スイートの個別指定が要るため、このスクリプトでは扱わない。
    echo "SSL_POLICY_PROFILE は COMPATIBLE / MODERN / RESTRICTED を指定してください。" >&2
    exit 1
    ;;
esac

case "${SSL_MIN_TLS_VERSION}" in
  1.0|1.1|1.2|1.3)
    ;;
  *)
    echo "SSL_MIN_TLS_VERSION は 1.0 / 1.1 / 1.2 / 1.3 を指定してください。" >&2
    exit 1
    ;;
esac

normalize_bool() {
  local name="$1"
  local value="$2"

  case "${value}" in
    true|TRUE|True|1|yes|YES|Yes|on|ON|On)
      printf 'true'
      ;;
    false|FALSE|False|0|no|NO|No|off|OFF|Off|"")
      printf 'false'
      ;;
    *)
      echo "${name} は true または false を指定してください。" >&2
      exit 1
      ;;
  esac
}

require_positive_int() {
  local name="$1"
  local value="$2"

  if [[ ! "${value}" =~ ^[1-9][0-9]*$ ]]; then
    echo "${name} は1以上の整数で指定してください。" >&2
    exit 1
  fi
}

CLOUD_ARMOR_ENABLED="$(normalize_bool CLOUD_ARMOR_ENABLED "${CLOUD_ARMOR_ENABLED}")"
CLOUD_ARMOR_WAF_PREVIEW="$(normalize_bool CLOUD_ARMOR_WAF_PREVIEW "${CLOUD_ARMOR_WAF_PREVIEW}")"
CLOUD_ARMOR_RATE_LIMIT_PREVIEW="$(normalize_bool CLOUD_ARMOR_RATE_LIMIT_PREVIEW "${CLOUD_ARMOR_RATE_LIMIT_PREVIEW}")"
CLOUD_ARMOR_IP_ALLOWLIST_PREVIEW="$(normalize_bool CLOUD_ARMOR_IP_ALLOWLIST_PREVIEW "${CLOUD_ARMOR_IP_ALLOWLIST_PREVIEW}")"

require_positive_int CLOUD_ARMOR_RATE_LIMIT_COUNT "${CLOUD_ARMOR_RATE_LIMIT_COUNT}"
require_positive_int CLOUD_ARMOR_RATE_LIMIT_INTERVAL_SEC "${CLOUD_ARMOR_RATE_LIMIT_INTERVAL_SEC}"
require_positive_int CLOUD_ARMOR_BAN_THRESHOLD_COUNT "${CLOUD_ARMOR_BAN_THRESHOLD_COUNT}"
require_positive_int CLOUD_ARMOR_BAN_THRESHOLD_INTERVAL_SEC "${CLOUD_ARMOR_BAN_THRESHOLD_INTERVAL_SEC}"
require_positive_int CLOUD_ARMOR_BAN_DURATION_SEC "${CLOUD_ARMOR_BAN_DURATION_SEC}"

case "${CLOUD_ARMOR_JSON_PARSING}" in
  DISABLED|STANDARD|STANDARD_WITH_GRAPHQL)
    ;;
  *)
    echo "CLOUD_ARMOR_JSON_PARSING は DISABLED / STANDARD / STANDARD_WITH_GRAPHQL を指定してください。" >&2
    exit 1
    ;;
esac

case "${CLOUD_ARMOR_LOG_LEVEL}" in
  NORMAL|VERBOSE)
    ;;
  *)
    echo "CLOUD_ARMOR_LOG_LEVEL は NORMAL または VERBOSE を指定してください。" >&2
    exit 1
    ;;
esac

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

exists() {
  gcloud "$@" >/dev/null 2>&1
}

configure_url_map_backend() {
  log "URLマップをバックエンドサービスへルーティングします（レスポンスヘッダはアプリ側で制御）"
  gcloud compute url-maps import "${URL_MAP}" \
    --quiet \
    "${GCLOUD_REGION[@]}" \
    "${GCLOUD_PROJECT[@]}" <<EOF
name: ${URL_MAP}
defaultService: regions/${REGION}/backendServices/${BACKEND_SERVICE}
EOF
}

upsert_security_policy_rule() {
  local priority="$1"
  shift

  if exists compute security-policies rules describe "${priority}" \
    --security-policy="${CLOUD_ARMOR_POLICY}" \
    "${GCLOUD_REGION[@]}" \
    "${GCLOUD_PROJECT[@]}"; then
    gcloud compute security-policies rules update "${priority}" \
      --security-policy="${CLOUD_ARMOR_POLICY}" \
      "$@" \
      "${GCLOUD_REGION[@]}" \
      "${GCLOUD_PROJECT[@]}"
  else
    gcloud compute security-policies rules create "${priority}" \
      --security-policy="${CLOUD_ARMOR_POLICY}" \
      "$@" \
      "${GCLOUD_REGION[@]}" \
      "${GCLOUD_PROJECT[@]}"
  fi
}

delete_security_policy_rule_if_exists() {
  local priority="$1"

  if exists compute security-policies rules describe "${priority}" \
    --security-policy="${CLOUD_ARMOR_POLICY}" \
    "${GCLOUD_REGION[@]}" \
    "${GCLOUD_PROJECT[@]}"; then
    gcloud compute security-policies rules delete "${priority}" \
      --security-policy="${CLOUD_ARMOR_POLICY}" \
      --quiet \
      "${GCLOUD_REGION[@]}" \
      "${GCLOUD_PROJECT[@]}"
  fi
}

preview_flag() {
  # gcloud のルール更新では --preview を外せないため、常に明示して指定する。
  if [[ "$1" == true ]]; then
    printf -- '--preview'
  else
    printf -- '--no-preview'
  fi
}

configure_cloud_armor_advanced_options() {
  log "Cloud Armor の解析設定を更新します（JSONパース ${CLOUD_ARMOR_JSON_PARSING} / ログ ${CLOUD_ARMOR_LOG_LEVEL}）"
  gcloud compute security-policies update "${CLOUD_ARMOR_POLICY}" \
    --json-parsing="${CLOUD_ARMOR_JSON_PARSING}" \
    --log-level="${CLOUD_ARMOR_LOG_LEVEL}" \
    "${GCLOUD_REGION[@]}" \
    "${GCLOUD_PROJECT[@]}"
}

health_check_expression() {
  # 35.191.0.0/16,130.211.0.0/22 → inIpRange(origin.ip, '...') || inIpRange(...)
  local expression=""
  local range
  local -a ranges=()

  IFS=',' read -r -a ranges <<<"${HEALTH_CHECK_SOURCE_RANGES}"
  for range in "${ranges[@]}"; do
    range="${range// /}"
    [[ -z "${range}" ]] && continue
    if [[ -n "${expression}" ]]; then
      expression+=" || "
    fi
    expression+="inIpRange(origin.ip, '${range}')"
  done

  if [[ -z "${expression}" ]]; then
    echo "HEALTH_CHECK_SOURCE_RANGES に少なくとも1つのCIDRを指定してください。" >&2
    exit 1
  fi

  printf '%s' "${expression}"
}

parse_ip_ranges() {
  # カンマ区切りの文字列を検証し、1行1レンジで出力する。単一IPには /32 を補う。
  local name="$1"
  local raw="$2"
  local entry
  local -a entries=()

  IFS=',' read -r -a entries <<<"${raw}"
  for entry in "${entries[@]}"; do
    entry="${entry// /}"
    [[ -z "${entry}" ]] && continue
    if [[ "${entry}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
      entry="${entry}/32"
    elif [[ ! "${entry}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]]; then
      echo "${name} には IPv4 の CIDR（例 203.0.113.0/24）または単一IPを指定してください: ${entry}" >&2
      exit 1
    fi
    printf '%s\n' "${entry}"
  done
}

ip_allowlist_expression() {
  # 許可リストに載っていない場合だけ真になる式を組み立てる。
  local expression=""
  local range

  while IFS= read -r range; do
    [[ -z "${range}" ]] && continue
    if [[ -n "${expression}" ]]; then
      expression+=" || "
    fi
    expression+="inIpRange(origin.ip, '${range}')"
  done < <(parse_ip_ranges CLOUD_ARMOR_ALLOWED_IP_RANGES "${CLOUD_ARMOR_ALLOWED_IP_RANGES}")

  if [[ -z "${expression}" ]]; then
    echo "CLOUD_ARMOR_ALLOWED_IP_RANGES の解析に失敗しました。" >&2
    exit 1
  fi

  printf '!(%s)' "${expression}"
}

configure_cloud_armor_ip_allowlist() {
  if [[ -z "${CLOUD_ARMOR_ALLOWED_IP_RANGES// /}" ]]; then
    # 未設定なら、以前に作った許可リストのルールを取り除いて制限を解除する。
    log "接続元IPの制限は無効です（許可リストのルールがあれば削除します）"
    delete_security_policy_rule_if_exists 800
    return
  fi

  log "接続元IPを ${CLOUD_ARMOR_ALLOWED_IP_RANGES} に制限します（preview=${CLOUD_ARMOR_IP_ALLOWLIST_PREVIEW}）"
  upsert_security_policy_rule 800 \
    --expression="$(ip_allowlist_expression)" \
    --action=deny-403 \
    "$(preview_flag "${CLOUD_ARMOR_IP_ALLOWLIST_PREVIEW}")" \
    --description="Deny requests from source IP addresses outside the allowlist."
}

configure_cloud_armor_rules() {
  # 100: 地域制限より先に、ロードバランサのヘルスチェック元を許可する
  log "Cloud Armor のヘルスチェック元許可を設定します"
  upsert_security_policy_rule 100 \
    --expression="$(health_check_expression)" \
    --action=allow \
    --no-preview \
    --description="Allow Google Cloud load balancer health checks before the Japan-only restriction."

  # 800: 接続元IPの許可リスト（設定時のみ。ヘルスチェックの後、地域制限の前）
  configure_cloud_armor_ip_allowlist

  # 900: 日本国外からのアクセスを拒否する（プレビューなしで適用）
  log "Cloud Armor の日本国外アクセス拒否を設定します"
  upsert_security_policy_rule 900 \
    --expression="origin.region_code != 'JP'" \
    --action=deny-403 \
    --no-preview \
    --description="Allow application traffic only from Japan."

  # 1000〜1040: 事前構成WAFルール（v422 stable、感度1）
  log "Cloud Armor のSQLインジェクション対策を設定します（preview=${CLOUD_ARMOR_WAF_PREVIEW}）"
  upsert_security_policy_rule 1000 \
    --expression="evaluatePreconfiguredWaf('sqli-v422-stable', {'sensitivity': 1})" \
    --action=deny-403 \
    "$(preview_flag "${CLOUD_ARMOR_WAF_PREVIEW}")" \
    --description="Block SQL injection attacks with the stable v422 WAF rules."

  log "Cloud Armor のXSS対策を設定します（preview=${CLOUD_ARMOR_WAF_PREVIEW}）"
  upsert_security_policy_rule 1010 \
    --expression="evaluatePreconfiguredWaf('xss-v422-stable', {'sensitivity': 1})" \
    --action=deny-403 \
    "$(preview_flag "${CLOUD_ARMOR_WAF_PREVIEW}")" \
    --description="Block cross-site scripting attacks with the stable v422 WAF rules."

  # 1020/1030 は誤検知が出やすいため、常にプレビュー（検知のみ）で運用する。
  log "Cloud Armor のプロトコル攻撃検知をプレビューで設定します"
  upsert_security_policy_rule 1020 \
    --expression="evaluatePreconfiguredWaf('protocolattack-v422-stable', {'sensitivity': 1})" \
    --action=deny-403 \
    --preview \
    --description="Preview protocol attack detection with the stable v422 WAF rules."

  log "Cloud Armor のセッションフィクセーション検知をプレビューで設定します"
  upsert_security_policy_rule 1030 \
    --expression="evaluatePreconfiguredWaf('sessionfixation-v422-stable', {'sensitivity': 1})" \
    --action=deny-403 \
    --preview \
    --description="Preview session fixation detection with the stable v422 WAF rules."

  log "Cloud Armor のリモートコード実行対策を設定します（preview=${CLOUD_ARMOR_WAF_PREVIEW}）"
  upsert_security_policy_rule 1040 \
    --expression="evaluatePreconfiguredWaf('rce-v422-stable', {'sensitivity': 1})" \
    --action=deny-403 \
    "$(preview_flag "${CLOUD_ARMOR_WAF_PREVIEW}")" \
    --description="Block remote code execution attacks with the stable v422 WAF rules."

  # 2000: 送信元IPごとのレート制限と、超過が続く場合の一時BAN
  log "Cloud Armor のレート制限を設定します（preview=${CLOUD_ARMOR_RATE_LIMIT_PREVIEW}）"
  upsert_security_policy_rule 2000 \
    --src-ip-ranges="*" \
    --action=rate-based-ban \
    --conform-action=allow \
    --exceed-action=deny-429 \
    --enforce-on-key=IP \
    --rate-limit-threshold-count="${CLOUD_ARMOR_RATE_LIMIT_COUNT}" \
    --rate-limit-threshold-interval-sec="${CLOUD_ARMOR_RATE_LIMIT_INTERVAL_SEC}" \
    --ban-threshold-count="${CLOUD_ARMOR_BAN_THRESHOLD_COUNT}" \
    --ban-threshold-interval-sec="${CLOUD_ARMOR_BAN_THRESHOLD_INTERVAL_SEC}" \
    --ban-duration-sec="${CLOUD_ARMOR_BAN_DURATION_SEC}" \
    "$(preview_flag "${CLOUD_ARMOR_RATE_LIMIT_PREVIEW}")" \
    --description="Rate limit and temporarily ban abusive source IP addresses."

  # 旧構成（200/210のWAFプレビュー、300のIP allowlist）が残っていれば削除する
  delete_security_policy_rule_if_exists 200
  delete_security_policy_rule_if_exists 210
  delete_security_policy_rule_if_exists 300

  # 保護ルールに一致しなかったリクエストは許可する
  log "Cloud Armor ポリシーのデフォルトアクションを allow に設定します"
  gcloud compute security-policies rules update 2147483647 \
    --security-policy="${CLOUD_ARMOR_POLICY}" \
    --action=allow \
    --description="Allow requests that did not match a protection rule." \
    "${GCLOUD_REGION[@]}" \
    "${GCLOUD_PROJECT[@]}"
}

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud コマンドが見つかりません。" >&2
  exit 1
fi

GCLOUD_PROJECT=(--project "${PROJECT_ID}")
GCLOUD_REGION=(--region "${REGION}")
GCLOUD_ZONE=(--zone "${ZONE}")

log "プロジェクト ${PROJECT_ID} / リージョン ${REGION} でロードバランサを構成します"
gcloud config set project "${PROJECT_ID}" >/dev/null

log "必要な API を有効化します"
gcloud services enable \
  certificatemanager.googleapis.com \
  compute.googleapis.com \
  "${GCLOUD_PROJECT[@]}"

# ==================================================
# 0. プロキシ専用サブネットの確認または自動作成
# ==================================================
log "プロキシ専用サブネット ${PROXY_ONLY_SUBNET_NAME} を確認します"
if ! exists compute networks subnets describe "${PROXY_ONLY_SUBNET_NAME}" "${GCLOUD_REGION[@]}" "${GCLOUD_PROJECT[@]}"; then
  log "プロキシ専用サブネットが見つからないため、新規作成します..."
  # ⚠️ 10.129.0.0/23 が既存のサブネットと重複する場合は、gce.envのIP設計に合わせて変更してください
  gcloud compute networks subnets create "${PROXY_ONLY_SUBNET_NAME}" \
    --purpose=REGIONAL_MANAGED_PROXY \
    --role=ACTIVE \
    --network="${NETWORK}" \
    --range="10.129.0.0/23" \
    "${GCLOUD_REGION[@]}" \
    "${GCLOUD_PROJECT[@]}"
else
  log "プロキシ専用サブネット ${PROXY_ONLY_SUBNET_NAME} は既に存在します。"
fi

# ==================================================
# 1. 外部IPアドレスの予約
# ==================================================
log "リージョン外部IPアドレス ${IP_NAME} を確保または確認します"
if ! exists compute addresses describe "${IP_NAME}" "${GCLOUD_REGION[@]}" "${GCLOUD_PROJECT[@]}"; then
  gcloud compute addresses create "${IP_NAME}" \
    --network-tier=STANDARD \
    "${GCLOUD_REGION[@]}" \
    "${GCLOUD_PROJECT[@]}"
fi

# ==================================================
# 2. アンマネージド インスタンス グループ (IG) の作成とVM登録
# ==================================================
log "インスタンスグループ ${INSTANCE_GROUP} を作成または確認します"
if ! exists compute instance-groups unmanaged describe "${INSTANCE_GROUP}" "${GCLOUD_ZONE[@]}" "${GCLOUD_PROJECT[@]}"; then
  gcloud compute instance-groups unmanaged create "${INSTANCE_GROUP}" \
    "${GCLOUD_ZONE[@]}" \
    "${GCLOUD_PROJECT[@]}"
fi

log "インスタンスグループに VM ${VM_NAME} を追加します（重複は無視されます）"
gcloud compute instance-groups unmanaged add-instances "${INSTANCE_GROUP}" \
  "${GCLOUD_ZONE[@]}" \
  --instances="${VM_NAME}" \
  "${GCLOUD_PROJECT[@]}" >/dev/null 2>&1 || true

# ==================================================
# 3. ヘルスチェックの作成
# ==================================================
log "リージョンヘルスチェック ${HEALTH_CHECK} を作成または確認します"
if ! exists compute health-checks describe "${HEALTH_CHECK}" "${GCLOUD_REGION[@]}" "${GCLOUD_PROJECT[@]}"; then
  gcloud compute health-checks create http "${HEALTH_CHECK}" \
    "${GCLOUD_REGION[@]}" \
    --port=8080 \
    "${GCLOUD_PROJECT[@]}"
fi

# ==================================================
# 4. バックエンドサービスの作成とIGの紐付け
# ==================================================
log "バックエンドサービス ${BACKEND_SERVICE} を作成または確認します"
if ! exists compute backend-services describe "${BACKEND_SERVICE}" "${GCLOUD_REGION[@]}" "${GCLOUD_PROJECT[@]}"; then
  gcloud compute backend-services create "${BACKEND_SERVICE}" \
    --load-balancing-scheme=EXTERNAL_MANAGED \
    --protocol=HTTP \
    --health-checks="${HEALTH_CHECK}" \
    --health-checks-region="${REGION}" \
    --enable-logging \
    --logging-sample-rate=1.0 \
    "${GCLOUD_REGION[@]}" \
    "${GCLOUD_PROJECT[@]}"
fi

log "バックエンドサービスにインスタンスグループを登録します"
if ! gcloud compute backend-services describe "${BACKEND_SERVICE}" "${GCLOUD_REGION[@]}" "${GCLOUD_PROJECT[@]}" --format='value(backends[].group)' | grep -q "${INSTANCE_GROUP}"; then
  gcloud compute backend-services add-backend "${BACKEND_SERVICE}" \
    --instance-group="${INSTANCE_GROUP}" \
    --instance-group-zone="${ZONE}" \
    "${GCLOUD_REGION[@]}" \
    "${GCLOUD_PROJECT[@]}"
fi

# ==================================================
# 5. Cloud Armor ポリシーの作成と適用
# ==================================================
if [[ "${CLOUD_ARMOR_ENABLED}" == true ]]; then
  log "Cloud Armor ポリシー ${CLOUD_ARMOR_POLICY} を確認または作成します"
  if ! exists compute security-policies describe "${CLOUD_ARMOR_POLICY}" "${GCLOUD_REGION[@]}" "${GCLOUD_PROJECT[@]}"; then
    gcloud compute security-policies create "${CLOUD_ARMOR_POLICY}" \
      --type=CLOUD_ARMOR \
      "${GCLOUD_REGION[@]}" \
      "${GCLOUD_PROJECT[@]}"
    log "Cloud Armor ポリシー ${CLOUD_ARMOR_POLICY} を作成しました（初期状態はデフォルト許可）"
  fi

  configure_cloud_armor_advanced_options
  configure_cloud_armor_rules

  log "Cloud Armor ポリシー ${CLOUD_ARMOR_POLICY} をバックエンドサービスに適用します"
  gcloud compute backend-services update "${BACKEND_SERVICE}" \
    --security-policy="${CLOUD_ARMOR_POLICY}" \
    --enable-logging \
    --logging-sample-rate=1.0 \
    "${GCLOUD_REGION[@]}" \
    "${GCLOUD_PROJECT[@]}"
else
  log "Cloud Armor は無効です。バックエンドサービスからポリシーの関連付けを解除します"
  gcloud compute backend-services update "${BACKEND_SERVICE}" \
    --security-policy "" \
    --enable-logging \
    --logging-sample-rate=1.0 \
    "${GCLOUD_REGION[@]}" \
    "${GCLOUD_PROJECT[@]}"
fi

# ==================================================
# 6. URL マップの作成
# ==================================================
log "URLマップ ${URL_MAP} を作成または確認します"
if ! exists compute url-maps describe "${URL_MAP}" "${GCLOUD_REGION[@]}" "${GCLOUD_PROJECT[@]}"; then
  gcloud compute url-maps create "${URL_MAP}" \
    --default-service="${BACKEND_SERVICE}" \
    "${GCLOUD_REGION[@]}" \
    "${GCLOUD_PROJECT[@]}"
fi
configure_url_map_backend

# ==================================================
# 7. Certificate Manager によるDNS認証とSSL証明書の作成
# ==================================================
log "Certificate Manager DNS認証 ${DNS_AUTH_NAME} を作成または確認します"
if ! exists certificate-manager dns-authorizations describe "${DNS_AUTH_NAME}" --location="${REGION}" "${GCLOUD_PROJECT[@]}"; then
  gcloud certificate-manager dns-authorizations create "${DNS_AUTH_NAME}" \
    --domain="${DOMAIN}" \
    --location="${REGION}" \
    "${GCLOUD_PROJECT[@]}"
fi

log "リージョンGoogle管理SSL証明書 ${SSL_CERTIFICATE} を作成または確認します"
if ! exists certificate-manager certificates describe "${SSL_CERTIFICATE}" --location="${REGION}" "${GCLOUD_PROJECT[@]}"; then
  gcloud certificate-manager certificates create "${SSL_CERTIFICATE}" \
    --domains="${DOMAIN}" \
    --dns-authorizations="${DNS_AUTH_NAME}" \
    --location="${REGION}" \
    "${GCLOUD_PROJECT[@]}"
fi

# ==================================================
# 8. SSLポリシーの作成（TLSの下限を明示する）
# ==================================================
# ポリシーを付けないとGoogleの既定（TLS1.0以上・COMPATIBLE）が適用され、
# TLS1.0/1.1のクライアントも接続できてしまう。
log "SSLポリシー ${SSL_POLICY} を作成または更新します（プロファイル ${SSL_POLICY_PROFILE} / 最小 TLS ${SSL_MIN_TLS_VERSION}）"
if ! exists compute ssl-policies describe "${SSL_POLICY}" "${GCLOUD_REGION[@]}" "${GCLOUD_PROJECT[@]}"; then
  gcloud compute ssl-policies create "${SSL_POLICY}" \
    --profile="${SSL_POLICY_PROFILE}" \
    --min-tls-version="${SSL_MIN_TLS_VERSION}" \
    "${GCLOUD_REGION[@]}" \
    "${GCLOUD_PROJECT[@]}"
else
  gcloud compute ssl-policies update "${SSL_POLICY}" \
    --profile="${SSL_POLICY_PROFILE}" \
    --min-tls-version="${SSL_MIN_TLS_VERSION}" \
    "${GCLOUD_REGION[@]}" \
    "${GCLOUD_PROJECT[@]}"
fi

# ==================================================
# 9. ターゲット HTTPS プロキシの作成 (修正点: 証明書名のみ指定)
# ==================================================
log "ターゲットHTTPSプロキシ ${HTTPS_PROXY} を作成または確認します"
if ! exists compute target-https-proxies describe "${HTTPS_PROXY}" "${GCLOUD_REGION[@]}" "${GCLOUD_PROJECT[@]}"; then
  gcloud compute target-https-proxies create "${HTTPS_PROXY}" \
    --url-map="${URL_MAP}" \
    --certificate-manager-certificates="${SSL_CERTIFICATE}" \
    --ssl-policy="${SSL_POLICY}" \
    --ssl-policy-region="${REGION}" \
    "${GCLOUD_REGION[@]}" \
    "${GCLOUD_PROJECT[@]}"
else
  gcloud compute target-https-proxies update "${HTTPS_PROXY}" \
    --certificate-manager-certificates="${SSL_CERTIFICATE}" \
    --ssl-policy="${SSL_POLICY}" \
    --ssl-policy-region="${REGION}" \
    "${GCLOUD_REGION[@]}" \
    "${GCLOUD_PROJECT[@]}"
fi

# ==================================================
# 10. 転送ルール (Forwarding Rule) の作成 (修正点: プロキシリージョン明示)
# ==================================================
log "転送ルール ${HTTPS_FORWARDING_RULE} を作成または確認します"
if ! exists compute forwarding-rules describe "${HTTPS_FORWARDING_RULE}" "${GCLOUD_REGION[@]}" "${GCLOUD_PROJECT[@]}"; then
  gcloud compute forwarding-rules create "${HTTPS_FORWARDING_RULE}" \
    --load-balancing-scheme=EXTERNAL_MANAGED \
    --network-tier=STANDARD \
    --network="${NETWORK}" \
    --subnetwork="${PROXY_ONLY_SUBNET_NAME}" \
    --region="${REGION}" \
    --address="${IP_NAME}" \
    --ports=443 \
    --target-https-proxy="${HTTPS_PROXY}" \
    --target-https-proxy-region="${REGION}" \
    "${GCLOUD_REGION[@]}" \
    "${GCLOUD_PROJECT[@]}"
fi

echo "--------------------------------------------------"
echo " 🟢 ロードバランサのすべてのリソースが正常にデプロイされました！"
echo "--------------------------------------------------"
echo " 以下のコマンドを実行して表示される CNAME レコードを"
echo " お使いのDNSサーバーに必ず登録してください。"
echo "--------------------------------------------------"
echo "gcloud certificate-manager dns-authorizations describe ${DNS_AUTH_NAME} --location=${REGION} --project=${PROJECT_ID}"
echo "--------------------------------------------------"
echo " セキュリティヘッダ設定はURLマップに保存されています。確認コマンド:"
echo "gcloud compute url-maps describe ${URL_MAP} --region=${REGION} --project=${PROJECT_ID} --format='yaml(pathMatchers)'"
echo "curl -I https://${DOMAIN}"
echo "--------------------------------------------------"
echo " TLSの下限（最小 TLS ${SSL_MIN_TLS_VERSION} / ${SSL_POLICY_PROFILE}）の確認コマンド:"
echo "gcloud compute ssl-policies describe ${SSL_POLICY} --region=${REGION} --project=${PROJECT_ID}"
if [[ "${CLOUD_ARMOR_ENABLED}" == true ]]; then
  echo "--------------------------------------------------"
  echo " Cloud Armor（WAF preview=${CLOUD_ARMOR_WAF_PREVIEW} / レート制限 preview=${CLOUD_ARMOR_RATE_LIMIT_PREVIEW}）の確認コマンド:"
  echo "gcloud compute security-policies describe ${CLOUD_ARMOR_POLICY} --region=${REGION} --project=${PROJECT_ID}"
  echo " 誤検知をログで確認したうえで CLOUD_ARMOR_WAF_PREVIEW=false にすると実際に拒否します。"
  if [[ -n "${CLOUD_ARMOR_ALLOWED_IP_RANGES// /}" ]]; then
    echo " 接続元IPの許可リスト: ${CLOUD_ARMOR_ALLOWED_IP_RANGES}（preview=${CLOUD_ARMOR_IP_ALLOWLIST_PREVIEW}）"
  fi
fi
