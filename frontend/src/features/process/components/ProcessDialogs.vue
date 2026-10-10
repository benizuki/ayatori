<script setup lang="ts">
import AssetExtractionDialog from './AssetExtractionDialog.vue'
import AssetManagementDialog from './AssetManagementDialog.vue'
import LaneDeleteDialog from './LaneDeleteDialog.vue'
import LaneManagementDialog from './LaneManagementDialog.vue'
import ProcessDetailsDialog from './ProcessDetailsDialog.vue'
import ProcessEvidenceDialog from './ProcessEvidenceDialog.vue'
import ProcessInterviewHistoryDialog from './ProcessInterviewHistoryDialog.vue'
import ProcessVersionDialog from './ProcessVersionDialog.vue'
import { useInterviewWorkflow } from '../../interviews/useInterviewWorkflow'
import { useWorkspaceStore } from '../../workspace/useWorkspaceStore'
import { useProcessEditor } from '../useProcessEditor'

// As-Is画面のダイアログ群。状態は useProcessEditor が持つので、App.vue を経由せずここで結び付ける。
const {
  interviewHistoryDialog,
  interviewHistoryLoading,
  interviewHistoryError,
  interviewHistorySessions,
  selectedHistorySessionId,
  selectedProcessHistorySession,
  selectedHistorySourceFragments,
  historyFragmentStepNames,
  activeProcessModel,
  assetManagementDialog,
  assetSearch,
  selectedAssetId,
  filteredProcessAssets,
  selectedManagedAsset,
  activeProcessSteps,
  assetExtractionLoading,
  addOperationalAsset,
  deleteOperationalAsset,
  assetExtractionError,
  reflowProcessAssets,
  unlinkAssetFromSelectedStep,
  assetExtractionDialog,
  selectedAssetExtractionFields,
  assetExtractionFileName,
  assetExtractionDocumentType,
  assetExtractionSummary,
  assetExtractionFields,
  assetExtractionWarnings,
  applyExtractedInformationItems,
  laneManagementDialog,
  managedNewLaneName,
  laneBulkMoveFrom,
  laneBulkMoveTo,
  renameProcessLane,
  moveProcessLane,
  requestDeleteProcessLane,
  addManagedProcessLane,
  moveAllLaneSteps,
  saveLaneManagement,
  laneDeleteDialog,
  laneDeleteDestination,
  laneDeleteTarget,
  laneDeleteStepCount,
  confirmDeleteProcessLane,
  processDetailsDialog,
  processDetailsForm,
  processDetailsError,
  saveProcessDetails,
  versionDialog,
  activeVersions,
  versionDifference,
  restoreVersion,
  evidenceDialog,
  selected,
  selectedProcessBusiness,
} = useProcessEditor()
const { departments, workFragments } = useWorkspaceStore()
const { openInterviewHistoryAttachment, updateAsIsFromInterviewSessionId } = useInterviewWorkflow()
</script>

<template>
  <ProcessInterviewHistoryDialog
    v-model="interviewHistoryDialog"
    :process-title="activeProcessModel?.title ?? ''"
    :loading="interviewHistoryLoading"
    :error="interviewHistoryError"
    :sessions="interviewHistorySessions"
    :selected-session-id="selectedHistorySessionId"
    :selected-session="selectedProcessHistorySession"
    :source-fragments="selectedHistorySourceFragments"
    :step-names-by-fragment-id="historyFragmentStepNames"
    @select-session="selectedHistorySessionId = $event"
    @open-attachment="openInterviewHistoryAttachment"
    @update-as-is="updateAsIsFromInterviewSessionId"
  />

  <AssetManagementDialog
    v-model="assetManagementDialog"
    v-model:search="assetSearch"
    v-model:selected-asset-id="selectedAssetId"
    :assets="filteredProcessAssets"
    :selected-asset="selectedManagedAsset"
    :asset-links="activeProcessModel?.assetLinks ?? []"
    :information="activeProcessModel?.information ?? []"
    :steps="activeProcessSteps"
    :work-fragments="workFragments"
    @add-asset="addOperationalAsset"
    @delete-asset="deleteOperationalAsset"
    @reflow-assets="reflowProcessAssets"
    @unlink-asset="unlinkAssetFromSelectedStep"
  />

  <AssetExtractionDialog
    v-model="assetExtractionDialog"
    v-model:selected-field-indexes="selectedAssetExtractionFields"
    :loading="assetExtractionLoading"
    :error="assetExtractionError"
    :file-name="assetExtractionFileName"
    :document-type="assetExtractionDocumentType"
    :summary="assetExtractionSummary"
    :fields="assetExtractionFields"
    :warnings="assetExtractionWarnings"
    @apply="applyExtractedInformationItems"
  />

  <LaneManagementDialog
    v-model="laneManagementDialog"
    v-model:new-lane-name="managedNewLaneName"
    v-model:bulk-move-from="laneBulkMoveFrom"
    v-model:bulk-move-to="laneBulkMoveTo"
    :lanes="activeProcessModel?.lanes ?? []"
    :steps="activeProcessSteps"
    @rename="renameProcessLane"
    @move="moveProcessLane"
    @request-delete="requestDeleteProcessLane"
    @add-lane="addManagedProcessLane"
    @bulk-move="moveAllLaneSteps"
    @save="saveLaneManagement"
  />

  <LaneDeleteDialog
    v-model="laneDeleteDialog"
    v-model:destination="laneDeleteDestination"
    :lane-name="laneDeleteTarget"
    :step-count="laneDeleteStepCount"
    :destination-lanes="(activeProcessModel?.lanes ?? []).filter(item => item !== laneDeleteTarget)"
    @confirm="confirmDeleteProcessLane"
  />

  <ProcessDetailsDialog
    v-model="processDetailsDialog"
    v-model:title="processDetailsForm.title"
    v-model:department-id="processDetailsForm.departmentId"
    :departments="departments"
    :error="processDetailsError"
    @save="saveProcessDetails"
  />

  <ProcessVersionDialog
    v-model="versionDialog"
    :model="activeProcessModel"
    :step-count="activeProcessSteps.length"
    :versions="activeVersions"
    :difference="versionDifference"
    @restore="restoreVersion"
  />

  <ProcessEvidenceDialog
    v-model="evidenceDialog"
    :step="selected"
    :business-name="selectedProcessBusiness.name"
  />
</template>
