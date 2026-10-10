<script setup lang="ts">
import InterviewAsIsPreviewDialog from './InterviewAsIsPreviewDialog.vue'
import InterviewSessionEditorDialog from './InterviewSessionEditorDialog.vue'
import InterviewStartDialog from './InterviewStartDialog.vue'
import InterviewTranscriptDialog from './InterviewTranscriptDialog.vue'
import { useAuthSession } from '../../admin/useAuthSession'
import { useWorkspaceStore } from '../../workspace/useWorkspaceStore'
import { useInterviewContext } from '../useInterviewContext'
import { useInterviewWorkflow } from '../useInterviewWorkflow'

// ヒアリング関連のダイアログ群。状態は useInterviewWorkflow が持つので、App.vue を経由せずここで結び付ける。
const {
  interviewAsIsPreviewOpen,
  interviewPreviewProcess,
  interviewTranscriptDialog,
  interviewTranscriptSession,
  interviewTranscriptRecord,
  interviewTranscriptMessages,
  interviewTranscriptFragments,
  interviewTranscriptCanUpdateAsIs,
  interviewTranscriptLoading,
  interviewTranscriptError,
  openInterviewHistoryAttachment,
  updateAsIsFromInterviewSession,
  interviewSessionEditorOpen,
  editingInterviewSession,
  interviewSessionEditorForm,
  interviewSessionEditorError,
  interviewSessionEditorSaving,
  saveInterviewSessionMetadata,
  createDialog,
  ensureSelectedInterviewBusiness,
  startInterview,
} = useInterviewWorkflow()
const {
  activeInterviewFragments,
  interviewStartStyle,
  discoveryDepartmentId,
  discoveryParticipant,
  selectedInterviewBusiness,
  selectableInterviewBusinesses,
  selectedInterviewMaster,
} = useInterviewContext()
const { departments, commonBusinessInterviewTopics } = useWorkspaceStore()
const { canEdit } = useAuthSession()
</script>

<template>
  <InterviewAsIsPreviewDialog
    v-model="interviewAsIsPreviewOpen"
    :model="interviewPreviewProcess"
    :fragments="activeInterviewFragments"
  />

  <InterviewTranscriptDialog
    v-model="interviewTranscriptDialog"
    :session="interviewTranscriptSession"
    :record="interviewTranscriptRecord"
    :messages="interviewTranscriptMessages"
    :fragments="interviewTranscriptFragments"
    :can-update-as-is="interviewTranscriptCanUpdateAsIs"
    :loading="interviewTranscriptLoading"
    :error="interviewTranscriptError"
    @open-attachment="openInterviewHistoryAttachment"
    @update-as-is="updateAsIsFromInterviewSession"
  />

  <InterviewSessionEditorDialog
    v-model="interviewSessionEditorOpen"
    :session="editingInterviewSession"
    :form="interviewSessionEditorForm"
    :departments="departments"
    :error="interviewSessionEditorError"
    :saving="interviewSessionEditorSaving"
    @save="saveInterviewSessionMetadata"
  />

  <InterviewStartDialog
    v-model:open="createDialog"
    v-model:style="interviewStartStyle"
    v-model:department-id="discoveryDepartmentId"
    v-model:participant="discoveryParticipant"
    v-model:business-id="selectedInterviewBusiness"
    :departments="departments"
    :selectable-businesses="selectableInterviewBusinesses"
    :selected-business="selectedInterviewMaster"
    :common-topics="commonBusinessInterviewTopics()"
    :can-edit="canEdit"
    @ensure-business="ensureSelectedInterviewBusiness"
    @start="startInterview"
  />
</template>
