from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field


class SQLiteBackupRecord(BaseModel):
    """作成済みSQLiteバックアップの一覧表示用メタデータ。"""

    id: str = Field(pattern=r"^ayatori-\d{8}T\d{6}\d{6}Z-[a-f0-9]{8}$")
    filename: str
    created_at: str
    size_bytes: int = Field(ge=0)


class SQLiteTableStatistics(BaseModel):
    """SQLite内のユーザーテーブルごとの使用量。"""

    name: str
    row_count: int = Field(ge=0)
    table_bytes: int = Field(ge=0)
    index_bytes: int = Field(ge=0)
    total_bytes: int = Field(ge=0)


class SQLiteDatabaseStatistics(BaseModel):
    """バックアップ管理画面に表示する稼働SQLiteの統計。"""

    database_filename: str
    journal_mode: str
    last_modified_at: str
    database_bytes: int = Field(ge=0)
    wal_bytes: int = Field(ge=0)
    shm_bytes: int = Field(ge=0)
    active_files_bytes: int = Field(ge=0)
    allocated_bytes: int = Field(ge=0)
    logical_used_bytes: int = Field(ge=0)
    unused_bytes: int = Field(ge=0)
    usage_percent: float = Field(ge=0, le=100)
    total_records: int = Field(ge=0)
    table_count: int = Field(ge=0)
    backup_bytes: int = Field(ge=0)
    backup_count: int = Field(ge=0)
    tables: list[SQLiteTableStatistics] = Field(default_factory=list)


class SavedInterviewAttachment(BaseModel):
    id: str = Field(min_length=64, max_length=64, pattern=r"^[a-f0-9]{64}$")
    name: str = Field(min_length=1, max_length=255)
    mime_type: Literal["image/png", "image/jpeg", "image/webp", "application/pdf"]
    size: int = Field(ge=0, le=8 * 1024 * 1024)
    uploaded_at: str = ""


class InterviewMessage(BaseModel):
    role: Literal["user", "assistant"]
    text: str = Field(min_length=1, max_length=8000)
    attachments: list[SavedInterviewAttachment] = Field(default_factory=list, max_length=20)


class InterviewAttachment(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    mime_type: Literal["image/png", "image/jpeg", "image/webp", "application/pdf"]
    data: str = Field(min_length=1, max_length=12_000_000)


class InterviewDataItem(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    data_type: Literal["文字列", "数値", "日付", "金額", "真偽値", "選択肢", "識別子", "その他"] = "その他"
    source_document: str = Field(default="", max_length=255)
    confidence: int = Field(default=50, ge=0, le=100)


class WorkFragmentContext(BaseModel):
    title: str
    description: str
    actor: str = Field(description="この作業を実際に行う担当者・役割・部門、または自動実行するシステム")
    trigger: str
    tools: list[str] = Field(default_factory=list)
    output: str
    next_step: str
    next_actor: str = Field(
        default="未確認",
        description="次の作業を行う引き継ぎ先の担当者・役割・部門、または自動実行するシステム",
    )
    standard_time: str = Field(
        default="未確認",
        max_length=120,
        description="資料または回答に明示された標準時間。数値と単位を保持し、不明なら未確認",
    )
    processing_volume: str = Field(
        default="未確認",
        max_length=120,
        description="資料または回答に明示された処理件数・頻度。数値・期間・単位を保持し、不明なら未確認",
    )
    source_document: str = Field(default="", max_length=255)
    source_reference: str = Field(
        default="",
        max_length=255,
        description="添付資料内のページ・行・図形番号など、同名工程も識別できる根拠位置",
    )
    data_items: list[InterviewDataItem] = Field(
        default_factory=list,
        max_length=100,
        description="回答または添付帳票から確認できた入力欄・列見出しなどのデータ項目",
    )
    personalization: Literal["高", "中", "低"]
    confidence: int = Field(ge=0, le=100)


class ProcessDraftFragment(WorkFragmentContext):
    id: str
    source_quote: str = ""
    source_time: str = ""


class ProcessDraftRequest(BaseModel):
    session_id: str
    department: str
    participant: str
    fragments: list[ProcessDraftFragment]
    business_context: dict[str, Any] | None = None


class ProcessDraftInformation(BaseModel):
    """工程が入力・出力する情報（書類やデータのまとまり）。アセットは取得元・格納先の置き場所。"""

    name: str = Field(min_length=1, max_length=120)
    asset_keys: list[str] = Field(default_factory=list, max_length=8)
    items: list[str] = Field(default_factory=list, max_length=100)


class ProcessDraftNode(BaseModel):
    key: str
    label: str
    type: Literal["start", "task", "gateway", "end"]
    actor: str = Field(description="このノードを実際に実行する役割・部門、または自動実行するシステム")
    order: int
    system: str = ""
    duration: str = "未確認"
    monthly_volume: str = "未確認"
    description: str = ""
    confidence: int = 50
    source_fragment_ids: list[str] = Field(default_factory=list)
    needs_review: bool = False
    inputs: list[ProcessDraftInformation] = Field(default_factory=list, max_length=20)
    outputs: list[ProcessDraftInformation] = Field(default_factory=list, max_length=20)


class ProcessDraftFlow(BaseModel):
    from_key: str
    to_key: str
    label: str = ""


class ProcessDraftAsset(BaseModel):
    key: str
    name: str
    type: Literal[
        "業務システム", "SaaS", "Excel・台帳", "ファイル", "共有フォルダ",
        "メール", "チャット", "紙帳票", "データベース・API", "その他",
    ] = "その他"
    purpose: str = ""
    owner: str = "未確認"
    location: str = "未確認"
    data_description: str = ""
    confidence: int = Field(default=50, ge=0, le=100)
    source_fragment_ids: list[str] = Field(default_factory=list)
    needs_review: bool = True


class ProcessDraftAssetLink(BaseModel):
    asset_key: str
    node_key: str
    relation: Literal["入力", "参照", "更新", "出力"]
    data_description: str = Field(default="", max_length=4000)


class ProcessDraftDecision(BaseModel):
    title: str
    summary: str = ""
    start_condition: str = "未確認"
    end_condition: str = "未確認"
    lanes: list[str] = Field(
        default_factory=list,
        description="ノードを実行する役割・部門・自動処理主体を登場順に重複なく並べた担当レーン",
    )
    nodes: list[ProcessDraftNode]
    flows: list[ProcessDraftFlow]
    assets: list[ProcessDraftAsset] = Field(default_factory=list)
    asset_links: list[ProcessDraftAssetLink] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    review_items: list[str] = Field(default_factory=list)


class ProcessDraftResponse(ProcessDraftDecision):
    provider: str = "vertex-ai"
    model: str = ""


class AssetLedgerField(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    data_type: Literal["文字列", "数値", "日付", "金額", "真偽値", "選択肢", "識別子", "その他"] = "その他"
    confidence: int = Field(default=50, ge=0, le=100)


class AssetDocumentExtractionRequest(BaseModel):
    asset_name: str = Field(default="", max_length=200)
    existing_description: str = Field(default="", max_length=4000)
    attachment: InterviewAttachment


class AssetDocumentExtractionDecision(BaseModel):
    document_type: str = Field(default="", max_length=120)
    summary: str = Field(default="", max_length=1000)
    fields: list[AssetLedgerField] = Field(default_factory=list, max_length=100)
    warnings: list[str] = Field(default_factory=list, max_length=20)


class AssetDocumentExtractionResponse(AssetDocumentExtractionDecision):
    provider: str = "vertex-ai"
    model: str = ""


class AudioTranscriptionDecision(BaseModel):
    transcript: str = Field(max_length=8000)


class AudioTranscriptionResponse(AudioTranscriptionDecision):
    provider: str = "vertex-ai"
    model: str = ""


SpeechTone = Literal["default", "calm", "friendly", "cheerful"]
SpeechPace = Literal["normal", "slow", "fast"]


class SpeechPreferences(BaseModel):
    """利用者ごとの読み上げの好み。voice が空ならシステムの既定の声を使う。"""

    voice: str = Field(default="", max_length=40)
    tone: SpeechTone = "default"
    pace: SpeechPace = "normal"


class SpeechOption(BaseModel):
    id: str
    label: str


class SpeechPreferencesResponse(SpeechPreferences):
    """保存済みの好みと、画面で選べる候補。"""

    default_voice: str
    voices: list[SpeechOption]
    tones: list[SpeechOption]
    paces: list[SpeechOption]


class SpeechSynthesisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    # 保存前の試聴に使う。省くと、呼び出した利用者の保存済みの好みで読み上げる。
    preferences: SpeechPreferences | None = None


InterviewPhase = Literal[
    "スコープ・目的",
    "基本フロー",
    "役割・引き継ぎ",
    "システム・データ",
    "件数・時間",
    "判断・例外",
    "差異・課題",
    "補足確認",
    "要約確認",
    "完了",
]

GapReviewStatus = Literal["未開始", "確認中", "完了"]


class StartInterviewRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=200, pattern=r"^\S+$")
    department: str
    participant: str
    business_context: dict[str, Any] | None = None


class InterviewRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=200, pattern=r"^\S+$")
    department: str
    participant: str
    stage: int = Field(ge=0, le=5)
    messages: list[InterviewMessage] = Field(min_length=1, max_length=200)
    attachments: list[InterviewAttachment] = Field(default_factory=list, max_length=4)
    active_fragment: WorkFragmentContext | None = None
    business_context: dict[str, Any] | None = None
    replace_pending_user_message: bool = False


class InterviewDecision(BaseModel):
    reply: str = Field(min_length=1)
    next_stage: int = Field(ge=0, le=5)
    tags: list[str] = Field(default_factory=list, max_length=4)
    fragment_action: Literal["create", "update", "complete", "none"]
    fragment: WorkFragmentContext | None = None
    extracted_fragments: list[WorkFragmentContext] = Field(
        default_factory=list,
        max_length=50,
        description="添付された業務フロー図から一括で読み取った工程。図がない通常の会話では空配列。",
    )
    phase: InterviewPhase
    current_step: str = ""
    confirmed_facts: list[str] = Field(default_factory=list)
    missing_items: list[str] = Field(default_factory=list)
    resolved_items: list[str] = Field(default_factory=list)
    contradictions: list[str] = Field(default_factory=list)
    process_end_confirmed: bool = False
    gap_review_status: GapReviewStatus = "未開始"
    completion_score: int = Field(ge=0, le=100)
    is_complete: bool = False


class BusinessDocumentExtractionDecision(BaseModel):
    document_kind: Literal["業務フロー図", "業務リスト", "混在", "その他"] = "その他"
    layout_direction: Literal["横方向", "縦方向", "混在", "不明"] = "不明"
    writing_direction: Literal["横書き", "縦書き", "混在", "不明"] = "不明"
    # Dense multi-page documents can legitimately contain more than 100 task
    # boxes. Keep the observed count intact so the extraction completeness
    # warning can compare it with the structured fragments.
    detected_task_count: int = Field(default=0, ge=0)
    summary: str = Field(default="", max_length=2000)
    actors: list[str] = Field(default_factory=list, max_length=50)
    systems: list[str] = Field(default_factory=list, max_length=50)
    fragments: list[WorkFragmentContext] = Field(default_factory=list, max_length=50)
    warnings: list[str] = Field(default_factory=list, max_length=30)


BusinessFlowImportStatus = Literal[
    "queued", "preprocessing", "classifying", "extracting", "assembling",
    "ready_for_review", "committing", "completed", "failed", "cancelled",
]


class BusinessFlowImportCandidate(BaseModel):
    id: str
    title: str = Field(min_length=1, max_length=200)
    summary: str = Field(default="", max_length=2000)
    confidence: int = Field(default=50, ge=0, le=100)
    page_references: list[str] = Field(default_factory=list, max_length=200)
    fragments: list[ProcessDraftFragment] = Field(default_factory=list, max_length=500)
    warnings: list[str] = Field(default_factory=list, max_length=50)
    draft: ProcessDraftDecision | None = None
    selected: bool = True
    target_business_id: str = ""


class BusinessFlowImportJob(BaseModel):
    id: str
    department_id: str
    file_name: str
    file_size: int = Field(ge=0)
    status: BusinessFlowImportStatus
    stage: str = ""
    progress: int = Field(default=0, ge=0, le=100)
    total_pages: int = Field(default=0, ge=0)
    processed_pages: int = Field(default=0, ge=0)
    candidate_count: int = Field(default=0, ge=0)
    error: str = ""
    created_at: str
    updated_at: str
    candidates: list[BusinessFlowImportCandidate] = Field(default_factory=list)


class BusinessFlowImportCandidateUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    selected: bool | None = None
    target_business_id: str | None = Field(default=None, max_length=200)


class BusinessFlowImportCommitRequest(BaseModel):
    candidate_ids: list[str] = Field(min_length=1, max_length=50)


class InterviewSessionState(BaseModel):
    session_id: str
    tenant_id: str = "default"
    department: str
    participant: str
    analysis_mode: str = "discovery"
    owner_email: str = ""
    # 作成日時（UTCのISO形式）。作成日時を持たない古い記録は、更新日時で代用する。
    created_at: str = ""
    business_context: dict[str, Any] | None = None
    phase: InterviewPhase = "スコープ・目的"
    current_stage: int = Field(default=0, ge=0, le=5)
    current_step: str = ""
    confirmed_facts: list[str] = Field(default_factory=list)
    missing_items: list[str] = Field(default_factory=list)
    asked_questions: list[str] = Field(default_factory=list)
    contradictions: list[str] = Field(default_factory=list)
    process_steps: list[str] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)
    process_end_confirmed: bool = False
    gap_review_status: GapReviewStatus = "未開始"
    completion_score: int = Field(default=0, ge=0, le=100)
    is_complete: bool = False


class InterviewSessionRecord(BaseModel):
    session_state: InterviewSessionState
    messages: list[InterviewMessage] = Field(default_factory=list, max_length=200)
    updated_at: str = ""


class InterviewSessionUpdate(BaseModel):
    department: str = Field(min_length=1, max_length=120)
    participant: str = Field(min_length=1, max_length=120)


class InterviewSessionSummaryRecord(BaseModel):
    session_id: str
    department: str
    participant: str
    phase: InterviewPhase
    completion_score: int = Field(ge=0, le=100)
    message_count: int = Field(ge=0)
    created_at: str = ""
    updated_at: str = ""
    is_complete: bool = False
    analysis_mode: str = "discovery"
    owner_email: str = ""
    source_process_id: str = ""


class AppStateRecord(BaseModel):
    payload: dict[str, Any] = Field(default_factory=dict)
    updated_at: str = ""


class UserInterviewPreference(BaseModel):
    active_interview_id: str | None = Field(default=None, max_length=200)
    updated_at: str = ""


class UserInterviewPreferenceUpdate(BaseModel):
    active_interview_id: str | None = Field(default=None, max_length=200)


class InterviewResponse(InterviewDecision):
    session_state: InterviewSessionState
    provider: str = "vertex-ai"
    model: str = ""


# 全社は全部門を統括するポジションを表す。配下に部門をぶら下げなくても、
# そのテナントの全組織を束ねる所属として扱う。
OrgUnitKind = Literal["全社", "部門", "課", "チーム", "その他"]


class OrgUnitRecord(BaseModel):
    """人の所属を表す組織単位。業務を分類するdepartmentsとは多対多で紐づける。

    1つの業務領域に複数の課が関わり、1つの課が複数の業務領域を担当しうるため、
    どちらかへ1対1の参照を持たせず、担当関係として別に保持する。
    """

    id: str = Field(default="", max_length=80)
    tenant_id: str = ""
    parent_id: str = Field(default="", max_length=80)
    name: str = Field(min_length=1, max_length=120)
    kind: OrgUnitKind = "部門"
    sort_order: int = Field(default=0, ge=0, le=9999)
    department_ids: list[str] = Field(default_factory=list, max_length=60)
    updated_at: str = ""


class OrgUnitUpsert(BaseModel):
    parent_id: str = Field(default="", max_length=80)
    name: str = Field(min_length=1, max_length=120)
    kind: OrgUnitKind = "部門"
    sort_order: int = Field(default=0, ge=0, le=9999)
    department_ids: list[str] = Field(default_factory=list, max_length=60)


# メール傾向の分類軸。組織や期間をまたいで件数を比べるため、名称は固定で持つ。
MailCategory = Literal[
    "見積",
    "発注",
    "ワークフロー",
    "調査依頼",
    "回答依頼",
    "報告・通知",
    "その他",
]
MailSourceKind = Literal["system", "internal", "external"]
# 件名の判定語。長い文をそのまま入れても一致しないため、短めに制限する。
MailKeyword = Annotated[str, Field(min_length=1, max_length=80)]


# 業務マップのタスク分類。見直しの着眼点を表し、価値の有無は TaskValue で別に持つ。
TaskCategory = Literal["作業", "確認", "登録", "伝達", "手戻り", "未分類"]
# 業務の成果に対する価値区分。経理の仕訳計上のように、登録でも業務の本体になりうる。
TaskValue = Literal["付加価値", "必要", "削減候補"]


class TaskClassificationItem(BaseModel):
    index: int = Field(ge=0, le=200)
    name: str = Field(min_length=1, max_length=200)
    # 既に人が決めた分類。前後関係を読むための文脈として渡し、上書きはしない。
    current_category: TaskCategory = "未分類"
    fixed: bool = False
    current_value: TaskValue | None = None
    value_fixed: bool = False


class TaskClassificationRequest(BaseModel):
    """業務単位で送る。業務内容が分からないと、名前だけのタスクは判断できない。"""

    business_name: str = Field(min_length=1, max_length=200)
    business_description: str = Field(default="", max_length=2000)
    start_condition: str = Field(default="", max_length=500)
    end_condition: str = Field(default="", max_length=500)
    tasks: list[TaskClassificationItem] = Field(default_factory=list, max_length=120)


class TaskClassificationResult(BaseModel):
    index: int = Field(ge=0, le=200)
    category: TaskCategory = "未分類"
    # 人が判定を直せるように、なぜその分類にしたのかを一言で残す。
    reason: str = Field(default="", max_length=200)
    value: TaskValue | None = None
    value_reason: str = Field(default="", max_length=200)


class TaskClassificationDecision(BaseModel):
    items: list[TaskClassificationResult] = Field(default_factory=list, max_length=120)


class TaskClassificationResponse(TaskClassificationDecision):
    provider: str = "vertex-ai"
    model: str = ""


AiProposalKind = Literal["agent", "assist", "automation", "process-change", "human", "needs-info"]
AiProposalPriority = Literal["high", "medium", "low"]
AiCapability = Literal[
    "読む・抽出",
    "検索・要約",
    "照合・構造化",
    "判断支援",
    "文面生成",
    "システム操作",
    "監視・催促",
]


class ProcessAiOpportunityStep(BaseModel):
    id: str = Field(min_length=1, max_length=120)
    label: str = Field(default="", max_length=200)
    actor: str = Field(default="", max_length=120)
    description: str = Field(default="", max_length=800)
    duration: str = Field(default="", max_length=80)
    monthly_volume: str = Field(default="", max_length=80)
    risk: str = Field(default="", max_length=40)
    branch_labels: list[str] = Field(default_factory=list, max_length=12)
    leads_to_gateway: bool = False
    category: TaskCategory = "未分類"
    category_source: Literal["map", "ai", "inferred"] = "inferred"


class ProcessAiConnection(BaseModel):
    from_id: str = Field(max_length=120)
    to_id: str = Field(max_length=120)
    label: str = Field(default="", max_length=200)


class ProcessAiOpportunityData(BaseModel):
    step_id: str = Field(min_length=1, max_length=120)
    name: str = Field(default="", max_length=200)
    type: str = Field(default="", max_length=40)
    relation: str = Field(default="", max_length=20)


class ProcessAiOpportunitySystem(BaseModel):
    step_id: str = Field(min_length=1, max_length=120)
    name: str = Field(default="", max_length=200)


class ProcessAiOpportunityRequest(BaseModel):
    title: str = Field(default="", max_length=200)
    department: str = Field(default="", max_length=120)
    steps: list[ProcessAiOpportunityStep] = Field(default_factory=list, max_length=120)
    data_items: list[ProcessAiOpportunityData] = Field(default_factory=list, max_length=400)
    systems: list[ProcessAiOpportunitySystem] = Field(default_factory=list, max_length=400)
    connections: list[ProcessAiConnection] = Field(default_factory=list, max_length=400)


class ProcessAiProposalDraft(BaseModel):
    """Geminiが返す提案。工程IDと分類だけを受け取り、事実はリクエスト側から補う。"""

    step_ids: list[str] = Field(default_factory=list, max_length=20)
    kind: AiProposalKind = "needs-info"
    priority: AiProposalPriority = "low"
    title: str = Field(default="", max_length=120)
    summary: str = Field(default="", max_length=400)
    ecrs: list[Literal["E", "C", "R", "S"]] = Field(min_length=1, max_length=4)
    before: str = Field(min_length=1, max_length=800)
    after: str = Field(min_length=1, max_length=800)
    improvement_actions: list[str] = Field(min_length=1, max_length=8)
    capabilities: list[AiCapability] = Field(default_factory=list, max_length=7)
    ai_actions: list[str] = Field(default_factory=list, max_length=6)
    reasons: list[str] = Field(default_factory=list, max_length=6)
    expected_benefits: list[str] = Field(default_factory=list, max_length=6)
    human_role: str = Field(default="", max_length=300)
    requirements: list[str] = Field(default_factory=list, max_length=8)
    risks: list[str] = Field(default_factory=list, max_length=8)
    missing_information: list[str] = Field(default_factory=list, max_length=8)


class ProcessAiProposalDraftSet(BaseModel):
    proposals: list[ProcessAiProposalDraft] = Field(default_factory=list, max_length=24)


class ProcessAiProposalDataItem(BaseModel):
    name: str = ""
    type: str = ""
    relation: str = ""


class ProcessAiProposal(ProcessAiProposalDraft):
    """検証済みの提案。工程名・データ・システムは入力の事実だけで埋める。"""

    id: str = ""
    actor: str = ""
    step_labels: list[str] = Field(default_factory=list)
    input_data: list[ProcessAiProposalDataItem] = Field(default_factory=list)
    output_data: list[ProcessAiProposalDataItem] = Field(default_factory=list)
    system_names: list[str] = Field(default_factory=list)
    evidence_level: Literal["高", "中", "低"] = "低"


class ProcessAiOpportunityResponse(BaseModel):
    proposals: list[ProcessAiProposal] = Field(default_factory=list)
    recommended_count: int = 0
    agent_candidate_count: int = 0
    assist_candidate_count: int = 0
    automation_candidate_count: int = 0
    needs_info_count: int = 0
    uncovered_step_labels: list[str] = Field(default_factory=list)
    provider: str = "vertex-ai"
    model: str = ""
    generated_at: str = ""


class AiUsageUserRow(BaseModel):
    user_email: str = ""
    calls: int = 0
    total_duration_ms: int = 0
    errors: int = 0
    rate_limited: int = 0
    prompt_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0


class AiUsageFeatureRow(BaseModel):
    feature: str = ""
    calls: int = 0
    total_duration_ms: int = 0
    total_tokens: int = 0


class AiUsageDayRow(BaseModel):
    day: str = ""
    calls: int = 0
    total_tokens: int = 0


class AiUsageReport(BaseModel):
    date_from: str = ""
    date_to: str = ""
    scope: Literal["tenant", "self"] = "self"
    total_calls: int = 0
    total_tokens: int = 0
    rate_limit_per_minute: int = 0
    rate_limit_per_day: int = 0
    used_today: int = 0
    by_user: list[AiUsageUserRow] = Field(default_factory=list)
    by_feature: list[AiUsageFeatureRow] = Field(default_factory=list)
    by_day: list[AiUsageDayRow] = Field(default_factory=list)


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    llm_configured: bool
    # provider/model は運用者向けの情報なので、本番では返さない。
    provider: str | None = None
    model: str | None = None


AuthRole = Literal["admin", "manager", "user", "viewer"]
# システムロールは3種。admin=全テナントの管理、viewer=全テナントの閲覧、
# none=システム権限なし（所属テナントの権限だけで動く）。
SystemRole = Literal["none", "admin", "viewer"]


class TenantMembership(BaseModel):
    tenant_id: str = Field(min_length=1, max_length=80)
    role: AuthRole = "viewer"
    # 組織はテナントごとに別なので、所属もテナントごとに持つ。
    org_unit_id: str = Field(default="", max_length=80)


class TenantRecord(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    enabled: bool = True
    created_at: str | None = None
    updated_at: str | None = None


class TenantUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    enabled: bool = True


class DepartmentTenantMoveRequest(BaseModel):
    target_tenant_id: str = Field(min_length=1, max_length=80)


class DepartmentTenantMoveResponse(BaseModel):
    department_id: str
    source_tenant_id: str
    target_tenant_id: str
    moved_interview_ids: list[str] = Field(default_factory=list)


class AuthConfig(BaseModel):
    google_oauth_enabled: bool
    google_client_id: str = ""
    # メールアドレスだけで入れるお試しログイン（Docker Composeの体験用）。
    demo_login_enabled: bool = False


class AuthDemoLoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)


class AuthGoogleLoginRequest(BaseModel):
    # Google IDトークンは通常1KB前後。検証へ進む前に桁違いの入力を弾く。
    credential: str = Field(min_length=1, max_length=8192)


class AuthUser(BaseModel):
    email: str
    name: str
    google_subject: str | None = None
    oauth_name: str | None = None
    oauth_picture: str | None = None
    department: str | None = None
    department_id: str | None = None
    org_unit_id: str | None = None
    role: SystemRole
    tenant_memberships: list[TenantMembership] = Field(default_factory=list)


class AuthLoginResponse(BaseModel):
    token: str | None = None
    user: AuthUser


class UserMasterEntry(BaseModel):
    email: str
    name: str
    department: str | None = None
    department_id: str | None = None
    org_unit_id: str | None = None
    role: SystemRole = "none"
    tenant_memberships: list[TenantMembership] = Field(default_factory=list)
    enabled: bool = True
    google_subject: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class UserMasterUpdate(BaseModel):
    email: str | None = None
    name: str
    department: str | None = None
    department_id: str | None = None
    org_unit_id: str | None = None
    role: SystemRole = "none"
    tenant_memberships: list[TenantMembership] = Field(default_factory=list)
    enabled: bool = True
    google_subject: str | None = None


# ---- システム設定（AIの接続方法・モデル・Google Cloud の認証） ----

AiConnection = Literal["gemini-api", "vertex"]
SpeechEngine = Literal["gemini-tts", "cloud-tts"]


class GeminiSettings(BaseModel):
    """Gemini APIキーの設定状況。キーそのものは返さない。"""

    # environment … GEMINI_API_KEY（画面からは変更できない）
    # stored      … 画面から登録したキー
    # none        … 未設定
    source: Literal["environment", "stored", "none"]
    configured: bool
    # 登録したキーの見分けに使う末尾4文字。
    key_hint: str | None = None


class GeminiApiKeyUpdate(BaseModel):
    api_key: str = Field(min_length=1, max_length=512)


class GoogleCloudAuthSettings(BaseModel):
    """② Vertex AI（Google Cloud）への接続。Vertex AI と Cloud Text-to-Speech で共通に使う。"""

    # 空なら GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION に従う。
    project: str = Field(default="", max_length=30)
    location: str = Field(default="", max_length=40)
    # Kubernetes 上でだけ使う Workload Identity 連携の識別子（任意）。
    wif_project_number: str = Field(default="", max_length=20)
    wif_pool_id: str = Field(default="", max_length=32)
    wif_provider_id: str = Field(default="", max_length=32)
    wif_service_account: str = Field(default="", max_length=120)


class GoogleCloudEnvironment(BaseModel):
    project: str
    location: str


class GoogleCloudSettingsResponse(GoogleCloudAuthSettings):
    # 画面で空のときに使われる、環境変数の値。
    environment: GoogleCloudEnvironment
    # いま使われる認証。Kubernetes 上で WIF が設定されていれば wif、それ以外は adc（google.auth.default）。
    active_auth: Literal["adc", "wif"]
    running_on_kubernetes: bool


class AiModelSettings(BaseModel):
    """役割ごとの接続方法とモデル。空の項目は環境変数に従う。

    接続方法: gemini-api（① Gemini API キー）/ vertex（② Vertex AI）。
    読み上げは方式で接続方法が決まる（gemini-tts は ①、cloud-tts は ②）。
    """

    chat_connection: Literal["", "gemini-api", "vertex"] = ""
    chat_model: str = Field(default="", max_length=100)
    transcription_connection: Literal["", "gemini-api", "vertex"] = ""
    transcription_model: str = Field(default="", max_length=100)
    speech_engine: Literal["", "gemini-tts", "cloud-tts"] = ""
    speech_model: str = Field(default="", max_length=100)


class AiModelValues(BaseModel):
    chat_connection: AiConnection
    chat_model: str
    transcription_connection: AiConnection
    transcription_model: str
    speech_engine: SpeechEngine
    speech_model: str


class AiModelSettingsResponse(AiModelSettings):
    # 画面で何も選んでいないときの値（環境変数とその既定）と、実際に使われる値。
    environment: AiModelValues
    effective: AiModelValues


class WorkloadIdentityInfo(BaseModel):
    """GCP 側で信頼を登録するための値。どれも秘密ではない。"""

    subject: str
    namespace: str
    service_account: str
    issuer: str
    jwks: dict


class ConnectionCheckResult(BaseModel):
    ok: bool
    # credentials: 認証情報の用意 / sts: トークンの交換 / api: サービスへの問い合わせ
    step: Literal["credentials", "sts", "api"]
    message: str
