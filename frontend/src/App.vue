<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import AppSidebar from './components/layout/AppSidebar.vue'
import AppTopbar from './components/layout/AppTopbar.vue'
import SpeechPreferencesDialog from './features/interviews/components/SpeechPreferencesDialog.vue'
import MasterSettingsTabs from './components/layout/MasterSettingsTabs.vue'
import type { ViewKey } from './components/layout/types'
import DepartmentManagerDialog from './features/admin/components/DepartmentManagerDialog.vue'
import TenantEditorDialog from './features/admin/components/TenantEditorDialog.vue'
import TenantManagementPage from './features/admin/components/TenantManagementPage.vue'
import AiUsagePage from './features/admin/components/AiUsagePage.vue'
import BackupManagementPage from './features/admin/components/BackupManagementPage.vue'
import SystemSettingsPage from './features/admin/components/SystemSettingsPage.vue'
import OrgUnitMasterPage from './features/admin/components/OrgUnitMasterPage.vue'
import UserEditorDialog from './features/admin/components/UserEditorDialog.vue'
import UserManagementPage from './features/admin/components/UserManagementPage.vue'
import { useAuthSession } from './features/admin/useAuthSession'
import InterviewPage from './features/interviews/components/InterviewPage.vue'
import InterviewSessionsPage from './features/interviews/components/InterviewSessionsPage.vue'
import { useInterviewContext } from './features/interviews/useInterviewContext'
import { useInterviewWorkflow } from './features/interviews/useInterviewWorkflow'
import type { InterviewSessionSummary } from './features/interviews/types'
import BusinessMasterPage from './features/master/components/BusinessMasterPage.vue'
import BusinessProcessMapPage from './features/master/components/BusinessProcessMapPage.vue'
import { useMasterEditor } from './features/master/useMasterEditor'
import OverviewPage from './features/overview/components/OverviewPage.vue'
import BusinessDeleteDialog from './features/master/components/BusinessDeleteDialog.vue'
import ProcessEditorPage from './features/process/components/ProcessEditorPage.vue'
import { useProcessEditor } from './features/process/useProcessEditor'
import { useAppShell } from './features/shell/useAppShell'
import AuthGate from './components/auth/AuthGate.vue'
import InterviewDialogs from './features/interviews/components/InterviewDialogs.vue'
import ProcessDialogs from './features/process/components/ProcessDialogs.vue'
import { useWorkspaceStore } from './features/workspace/useWorkspaceStore'
import { useWorkspaceRestore } from './features/workspace/useWorkspaceRestore'
import { useDepartmentManager } from './features/admin/useDepartmentManager'
import type {
  BusinessProcessMaster,
  Department,
  ProcessModel,
} from './models'

const {
  departments,
  businessMasters,
  processModels,
  snackbar,
  snackbarMessage,
  configureAppStatePersistence,
} = useWorkspaceStore()

const {
  currentView,
  activeNavKey,
  inMasterSettings,
  mobileNav,
  sidebarHidden,
  pageTitle,
  goTo,
  setSidebarHidden,
} = useAppShell()

const {
  authConfig,
  loginRequired,
  handleDemoLogin,
  authReady,
  authLoading,
  authError,
  currentUser,
  googleButton,
  users,
  tenants,
  activeTenantId,
  tenantSwitching,
  tenantEditorOpen,
  tenantForm,
  userEditorOpen,
  editingUserEmail,
  editingTenantId,
  userForm,
  userInitials,
  loadTenants,
  loadUsers,
  orgUnits,
  tenantOrgUnits,
  loadOrgUnits,
  orgUnitSaving,
  submitOrgUnit,
  removeOrgUnit,
  currentTenant,
  currentTenantRole,
  canEdit,
  canManageTenantAssignments,
  canManageOrgUnits,
  canManageUsers,
  isSystemAdmin,
  visibleNavItems,
  visibleMasterItems,
  navigate,
  appAccessible,
  configureTenantSwitch,
  initializeAuth,
  handleLogout,
  switchTenant,
  openNewUser,
  editUser,
  openNewTenant,
  editTenant,
  submitTenant,
  submitUser,
  removeUser,
} = useAuthSession()

const {
  interviewMode,
  interviewStartStyle,
  selectedInterviewBusiness,
  activeInterviewId,
  selectedInterviewMaster,
  currentInterviewDepartmentName,
  currentInterviewParticipant,
  activeInterviewFragments,
  activeInterviewLaneCandidates,
  messages,
} = useInterviewContext()

const {
  processBusinessId,
  processDepartmentId,
  proposalFocusStepId,
  proposalViewRequested,
  activeProcessModel,
  processDepartmentItems,
  filteredProcessSelectItems,
  selectProcessBusiness,
  selectProcessDepartment,
  unsavedProcessCount,
} = useProcessEditor()
const improvementMapStepIds = ref<string[]>([])
/** 読み上げの設定（声・トーン・ペース）のダイアログ。上部の音声ボタンから開く。 */
const speechSettingsOpen = ref(false)
function openTaskImprovements(businessId: string, stepId = '') {
  openAsIsById(businessId)
  proposalFocusStepId.value = stepId
  proposalViewRequested.value = true
}
function showImprovementMap(stepIds: string[]) {
  if (!activeProcessModel.value) return
  selectBusiness(activeProcessModel.value.businessId)
  improvementMapStepIds.value = stepIds
  goTo('processMap')
}


const {
  deleteDialog,
  selectedBusinessId,
  masterDepartment,
  masterSearch,
  selectedBusiness,
  filteredBusinessMasters,
  selectedDepartmentName,
  selectedAsIsModel,
  asIsBusinessCount,
  asIsTaskCount,
  validParentBusinesses,
  selectedBusinessRelations,
  selectBusiness,
  openAsIs,
  openAsIsById,
  addBusiness,
  saveBusiness,
  applyBusinessFlowImport,
  addBusinessRelation,
  deleteBusinessRelation,
  deleteBusiness,
} = useMasterEditor()

const {
  response,
  interviewSessionFilter,
  interviewSessionDepartmentId,
  interviewPage,
  aiThinking,
  llmConnectionStatus,
  llmStatusDetail,
  pendingInterviewText,
  queuedInterviewAttachments,
  pendingInterviewAttachments,
  stopPendingInterviewTurn,
  interviewAttachmentError,
  interviewAttachmentDragActive,
  interviewCompletionScore,
  interviewPhase,
  interviewMissingItems,
  interviewConfirmedFacts,
  draftGenerating,
  draftGenerationError,
  interviewPreviewProcess,
  consultantTopics,
  voiceInputSupported,
  voiceOutputSupported,
  isVoiceListening,
  isVoiceTranscribing,
  isAiSpeaking,
  voicePlaybackEnabled,
  voiceStatus,
  voiceError,
  speakAiMessage,
  toggleVoicePlayback,
  toggleVoiceInput,
  isRefinementInterview,
  discoveryCoverage,
  interviewSessionGroups,
  filteredInterviewSessions,
  departmentFilteredInterviewSessions,
  activeInterviewSession,
  interviewSessionCounts,
  interviewTopicStates,
  interviewTopicStatuses,
  clearDisplayedInterview,
  restoreCurrentUserInterview,
  setInterviewSessionDepartment,
  openInterviewSessionEditor,
  openInterviewTranscript,
  suspendCurrentInterview,
  deleteInterviewSession,
  cancelAndDeleteCurrentInterview,
  resumeInterviewSession,
  updateAsIsFromInterviewSession,
  openAsIsForInterviewSession,
  syncSavedInterviewSessionSummaries,
  startDiscoveryInterview,
  startGuidedInterview,
  startBusinessMasterInterview,
  continueInterviewFromProcess,
  onInterviewAttachmentInput,
  onInterviewPaste,
  onInterviewDrop,
  removeInterviewAttachment,
  formatAttachmentSize,
  sendMessage,
  retryLlmConnection,
  generateDraftFromInterview,
  openInterviewAsIsPreview,
} = useInterviewWorkflow()



const { resetWorkspaceToSeeds, restoreAppStateFromBackend } = useWorkspaceRestore()
const {
  departmentManagerOpen,
  departmentDeleteDialog,
  editingDepartmentId,
  departmentFormError,
  departmentStages,
  departmentIconOptions,
  departmentForm,
  departmentReferences,
  linkedBusinessMasters,
  linkedProcessModels,
  reassignBusinessMasterDepartment,
  reassignProcessModelDepartment,
  selectDepartmentForEditing,
  openDepartmentManager,
  openNewDepartment,
  saveDepartment,
  requestDepartmentDeletion,
  deleteDepartment,
} = useDepartmentManager()

configureTenantSwitch({
  resetWorkspace: resetWorkspaceToSeeds,
  restoreWorkspace: restoreAppStateFromBackend,
  clearDisplayedInterview,
  restoreCurrentUserInterview,
  selectDepartmentForEditing,
})

configureAppStatePersistence({
  extras: () => ({
    ...(!loginRequired.value ? { activeInterviewId: activeInterviewId.value } : {}),
    processBusinessId: processBusinessId.value,
    processDepartmentId: processDepartmentId.value,
    interviewStartStyle: interviewStartStyle.value,
    selectedInterviewBusiness: selectedInterviewBusiness.value,
  }),
  canSave: () => !(loginRequired.value && currentTenantRole.value === 'viewer'),
})









// As-Isの編集は「As-Isを保存」まで書き込まないため、未保存のまま閉じられないようにする。
function warnAboutUnsavedProcesses(event: BeforeUnloadEvent) {
  if (!unsavedProcessCount.value) return
  event.preventDefault()
  event.returnValue = ''
}

onMounted(() => {
  void initializeAuth()
  window.addEventListener('beforeunload', warnAboutUnsavedProcesses)
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', warnAboutUnsavedProcesses)
})

</script>

<template>
  <v-app>
    <AuthGate
      v-if="authReady && loginRequired && !currentUser"
      :button-ready="Boolean(googleButton)"
      :demo-login="Boolean(authConfig.demo_login_enabled)"
      :error="authError"
      :loading="authLoading"
      @demo-login="handleDemoLogin"
    >
      <div ref="googleButton" class="google-login-button"></div>
    </AuthGate>
    <template v-if="appAccessible">
    <AppSidebar
      :mobile-open="mobileNav"
      :hidden="sidebarHidden"
      :tenant-name="currentTenant?.name || ''"
      :tenant-role="currentTenantRole"
      :department-count="departments.length"
      :tenants="tenants"
      :active-tenant-id="activeTenantId"
      :tenant-switching="tenantSwitching"
      :navigation-items="visibleNavItems"
      :active-key="activeNavKey"
      @toggle-hidden="setSidebarHidden"
      @select-tenant="switchTenant"
      @navigate="navigate"
      @close-mobile="mobileNav = false"
    />

    <main class="main-shell" :class="{ 'main-shell--sidebar-hidden': sidebarHidden }">
      <AppTopbar
        :current-view="currentView"
        :sidebar-hidden="sidebarHidden"
        :page-title="pageTitle"
        :process-department-id="processDepartmentId"
        :process-departments="processDepartmentItems"
        :process-business-id="processBusinessId"
        :process-businesses="filteredProcessSelectItems"
        :current-user="currentUser"
        :tenant-role="currentTenantRole"
        :user-initials="userInitials"
        @open-mobile="mobileNav = true"
        @show-sidebar="setSidebarHidden(false)"
        @select-process-department="selectProcessDepartment"
        @select-process-business="selectProcessBusiness"
        @open-speech-settings="speechSettingsOpen = true"
        @logout="handleLogout"
      />

      <MasterSettingsTabs v-if="inMasterSettings" :items="visibleMasterItems" :current-view="currentView" @navigate="goTo" />

      <OverviewPage
        v-if="currentView === 'overview'"
        :departments="departments"
        :business-masters="businessMasters"
        :process-models="processModels"
        :can-edit="canEdit"
        @start-guided-interview="startGuidedInterview"
        @start-discovery-interview="startDiscoveryInterview"
      />

      <TenantManagementPage
        v-else-if="currentView === 'tenants'"
        :tenants="tenants"
        :users="users"
        :active-tenant-id="activeTenantId"
        :can-manage="isSystemAdmin"
        @reload="loadTenants"
        @add="openNewTenant"
        @edit="editTenant"
      />

      <OrgUnitMasterPage
        v-else-if="currentView === 'orgUnits'"
        :org-units="orgUnits"
        :users="users"
        :active-tenant-id="activeTenantId"
        :departments="departments"
        :saving="orgUnitSaving"
        :can-manage="canManageOrgUnits"
        @reload="loadOrgUnits"
        @save="submitOrgUnit"
        @remove="removeOrgUnit"
      />

      <UserManagementPage
        v-else-if="currentView === 'users'"
        :users="users"
        :tenants="tenants"
        :org-units="orgUnits"
        :active-tenant-id="activeTenantId"
        :current-user-email="currentUser?.email"
        :is-system-admin="isSystemAdmin"
        :scoped-tenant-name="currentTenant?.name || activeTenantId"
        :can-manage="canManageUsers"
        @reload="loadUsers"
        @add="openNewUser"
        @edit="editUser"
        @remove="removeUser"
      />

      <BusinessMasterPage
        v-else-if="currentView === 'master'"
        v-model:department-id="masterDepartment"
        v-model:search="masterSearch"
        :departments="departments"
        :business-masters="businessMasters"
        :process-models="processModels"
        :filtered-businesses="filteredBusinessMasters"
        :selected-business="selectedBusiness"
        :selected-business-id="selectedBusinessId"
        :selected-as-is-model="selectedAsIsModel"
        :valid-parent-businesses="validParentBusinesses"
        :selected-business-relations="selectedBusinessRelations"
        :can-edit="canEdit"
        :as-is-business-count="asIsBusinessCount"
        :as-is-task-count="asIsTaskCount"
        @manage-departments="openDepartmentManager()"
        @add="addBusiness"
        @select="selectBusiness"
        @open-as-is="openAsIs"
        @delete="deleteDialog = true"
        @start-interview="startBusinessMasterInterview"
        @save="saveBusiness"
        @apply-import="applyBusinessFlowImport"
        @add-relation="addBusinessRelation"
        @delete-relation="deleteBusinessRelation"
      />

      <BusinessProcessMapPage
        v-else-if="currentView === 'processMap'"
        :departments="departments"
        :businesses="businessMasters"
        :process-models="processModels"
        :selected-id="selectedBusinessId"
        :can-edit="canEdit"
        @select="selectBusiness"
        :focus-step-ids="improvementMapStepIds"
        @clear-focus="improvementMapStepIds = []"
        @open-improvements="openTaskImprovements"
        @open-as-is="openAsIsById"
      />

      <InterviewSessionsPage
        v-else-if="currentView === 'sessions'"
        :department-id="interviewSessionDepartmentId"
        :departments="departments"
        :all-sessions="interviewSessionGroups"
        :filtered-sessions="filteredInterviewSessions"
        :department-session-count="departmentFilteredInterviewSessions.length"
        :session-counts="interviewSessionCounts"
        :active-filter="interviewSessionFilter"
        :can-edit="canEdit"
        @sync="syncSavedInterviewSessionSummaries"
        @start-guided-interview="startGuidedInterview"
        @start-discovery-interview="startDiscoveryInterview"
        @select-department="setInterviewSessionDepartment"
        @select-filter="interviewSessionFilter = $event"
        @edit="openInterviewSessionEditor"
        @open-transcript="openInterviewTranscript"
        @resume="resumeInterviewSession"
        @open-as-is-update="updateAsIsFromInterviewSession"
        @open-as-is="openAsIsForInterviewSession"
        @delete="deleteInterviewSession"
      />

      <InterviewPage
        v-else-if="currentView === 'interview'"
        ref="interviewPage"
        :is-refinement-interview="isRefinementInterview"
        :can-edit="canEdit"
        :interview-mode="interviewMode"
        :guide-name="selectedInterviewMaster.name"
        :has-process-model="!!activeProcessModel"
        :has-preview-process="!!interviewPreviewProcess"
        :active-session="activeInterviewSession"
        :completion-score="interviewCompletionScore"
        :participant="currentInterviewParticipant"
        :department-name="currentInterviewDepartmentName"
        :coverage="discoveryCoverage"
        :consultant-topics="consultantTopics"
        :topic-states="interviewTopicStates"
        :topic-statuses="interviewTopicStatuses"
        :active-fragments="activeInterviewFragments"
        :lane-candidate-count="activeInterviewLaneCandidates.length"
        :messages="messages"
        :ai-thinking="aiThinking"
        :llm-connection-status="llmConnectionStatus"
        :llm-status-detail="llmStatusDetail"
        :interview-phase="interviewPhase"
        :pending-interview-text="pendingInterviewText"
        :pending-attachment-count="pendingInterviewAttachments.length"
        :queued-attachments="queuedInterviewAttachments"
        :attachment-error="interviewAttachmentError"
        :draft-generating="draftGenerating"
        :draft-generation-error="draftGenerationError"
        :voice-input-supported="voiceInputSupported"
        :voice-output-supported="voiceOutputSupported"
        :is-voice-listening="isVoiceListening"
        :is-voice-transcribing="isVoiceTranscribing"
        :is-ai-speaking="isAiSpeaking"
        :voice-playback-enabled="voicePlaybackEnabled"
        :voice-status="voiceStatus"
        :voice-error="voiceError"
        :confirmed-fact-count="interviewConfirmedFacts.length"
        :missing-items="interviewMissingItems"
        :format-attachment-size="formatAttachmentSize"
        v-model:response="response"
        v-model:attachment-drag-active="interviewAttachmentDragActive"
        @go-to-sessions="goTo('sessions')"
        @go-to-process="goTo('process')"
        @suspend="suspendCurrentInterview"
        @cancel-and-delete="cancelAndDeleteCurrentInterview"
        @start-discovery-interview="startDiscoveryInterview"
        @continue-from-process="continueInterviewFromProcess"
        @retry-connection="retryLlmConnection"
        @toggle-voice-playback="toggleVoicePlayback"
        @toggle-voice-input="toggleVoiceInput"
        @speak="speakAiMessage($event, true)"
        @send="sendMessage"
        @paste="onInterviewPaste"
        @drop="onInterviewDrop"
        @attachment-input="onInterviewAttachmentInput"
        @remove-attachment="removeInterviewAttachment"
        @stop-sending="stopPendingInterviewTurn"
        @generate-draft="generateDraftFromInterview"
        @preview-as-is="openInterviewAsIsPreview"
      />

      <AiUsagePage v-else-if="currentView === 'aiUsage'" />

      <BackupManagementPage v-else-if="currentView === 'backups'" />
      <SystemSettingsPage v-else-if="currentView === 'systemSettings'" />

      <ProcessEditorPage
        v-else-if="currentView === 'process' && activeProcessModel"
        :can-edit="canEdit"
        @show-improvement-map="showImprovementMap"
        @continue-interview="continueInterviewFromProcess"
        @start-discovery-interview="startDiscoveryInterview"
      />

      <!-- As-Isは業務ごとに作るため、業務やAs-Isが1件も無い状態では表示するものがない。 -->
      <section v-else-if="currentView === 'process'" class="page page--process">
        <div class="page-heading page-heading--compact">
          <div><div class="eyebrow">AS-IS PROCESS MODELER</div><h1>As-Isプロセス</h1><p>ヒアリングや業務マスターから作成したAs-Isプロセスを編集します。</p></div>
        </div>
        <section class="panel">
          <div class="asis-master-empty">
            <v-icon size="28">mdi-transit-connection-variant</v-icon>
            <div>
              <b>表示できるAs-Isプロセスがありません</b>
              <span v-if="departments.length === 0">業務領域と業務を登録すると、As-Isプロセスを作成できます。</span>
              <span v-else-if="businessMasters.length === 0">業務マスターに業務を登録すると、As-Isプロセスを作成できます。</span>
              <span v-else>業務マスターで対象の業務を選び、As-Isを作成してください。</span>
            </div>
            <button class="save-button" @click="goTo('master')">業務マスターを開く</button>
          </div>
        </section>
      </section>
    </main>

    <ProcessDialogs />
    <InterviewDialogs />

    <BusinessDeleteDialog
      v-model="deleteDialog"
      :business-name="selectedBusiness.name"
      :business-code="selectedBusiness.code"
      :department-name="selectedDepartmentName"
      @confirm="deleteBusiness"
    />

    <DepartmentManagerDialog
      v-model:open="departmentManagerOpen"
      v-model:delete-open="departmentDeleteDialog"
      :departments="departments"
      :tenants="tenants"
      :current-tenant-name="currentTenant?.name"
      :editing-department-id="editingDepartmentId"
      :form="departmentForm"
      :can-manage-tenant-assignments="canManageTenantAssignments"
      :stages="departmentStages"
      :icon-options="departmentIconOptions"
      :error="departmentFormError"
      :reference-counts="departmentReferences"
      :linked-businesses="linkedBusinessMasters"
      :linked-models="linkedProcessModels"
      @add="openNewDepartment"
      @select="selectDepartmentForEditing"
      @reassign-business="reassignBusinessMasterDepartment"
      @reassign-model="reassignProcessModelDepartment"
      @request-delete="requestDepartmentDeletion"
      @delete="deleteDepartment"
      @save="saveDepartment"
    />

    <UserEditorDialog
      v-model="userEditorOpen"
      :editing-email="editingUserEmail"
      :form="userForm"
      :tenants="tenants"
      :org-units="orgUnits"
      :tenant-org-units="tenantOrgUnits"
      :is-system-admin="isSystemAdmin"
      :scoped-tenant-id="activeTenantId"
      @save="submitUser"
    />

    <TenantEditorDialog
      v-model="tenantEditorOpen"
      :editing-id="editingTenantId"
      :active-tenant-id="activeTenantId"
      :form="tenantForm"
      @save="submitTenant"
    />
    <v-snackbar v-model="snackbar" color="primary" timeout="3000">{{ snackbarMessage }}</v-snackbar>
    <SpeechPreferencesDialog v-model="speechSettingsOpen" />
    </template>
  </v-app>
</template>
