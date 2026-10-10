import type { Ref } from 'vue'
import type { LlmFragment } from '../../api/interview'
import type { WorkFragment } from '../../models'
import { useWorkspaceStore } from '../workspace/useWorkspaceStore'
import { mergeInterviewDataItems } from './process-draft-model'
import { useInterviewContext } from './useInterviewContext'

/**
 * AIの回答から返った作業断片を、画面の作業断片一覧へ反映する。
 * activeDiscoveryFragmentId は「いま話している断片」。次の「更新」の対象になる。
 */
export function useInterviewFragments(activeDiscoveryFragmentId: Ref<string>) {
  const { workFragments, scheduleAppStateSave } = useWorkspaceStore()
  const { activeInterviewId, currentInterviewDepartmentId, currentInterviewParticipant } = useInterviewContext()

  function applyLlmWorkFragment(data: LlmFragment | null, action: 'create' | 'update' | 'complete' | 'none', sourceText: string) {
    if (!data || action === 'complete' || action === 'none') return undefined
    const previousFragment = workFragments.value.find((item) => item.id === activeDiscoveryFragmentId.value)
    let fragment = action === 'update'
      ? previousFragment
      : undefined
    if (!fragment) {
      if (action === 'create' && previousFragment) {
        previousFragment.nextStep = data.title
        if (!previousFragment.nextActor || previousFragment.nextActor === '未確認') previousFragment.nextActor = data.actor
      }
      fragment = {
        id: `fragment-${Date.now()}`,
        title: data.title,
        description: data.description,
        departmentId: currentInterviewDepartmentId.value,
        actor: data.actor,
        participant: currentInterviewParticipant.value,
        trigger: data.trigger,
        tools: data.tools.length ? data.tools : ['未確認'],
        output: data.output,
        nextStep: data.next_step,
        nextActor: data.next_actor,
        standardTime: data.standard_time,
        processingVolume: data.processing_volume,
        sourceDocument: data.source_document,
        sourceReference: data.source_reference,
        dataItems: mergeInterviewDataItems([], data.data_items),
        personalization: data.personalization,
        sourceQuote: sourceText,
        sourceTime: 'いま',
        interviewId: activeInterviewId.value,
        confidence: data.confidence,
      }
      workFragments.value.unshift(fragment)
      activeDiscoveryFragmentId.value = fragment.id
    } else {
      fragment.title = data.title
      fragment.description = data.description
      fragment.actor = data.actor
      fragment.trigger = data.trigger
      fragment.tools = data.tools.length ? data.tools : ['未確認']
      fragment.output = data.output
      fragment.nextStep = data.next_step
      fragment.nextActor = data.next_actor
      fragment.standardTime = data.standard_time
      fragment.processingVolume = data.processing_volume
      fragment.sourceDocument = data.source_document
      fragment.sourceReference = data.source_reference
      fragment.dataItems = mergeInterviewDataItems(fragment.dataItems, data.data_items)
      fragment.personalization = data.personalization
      fragment.confidence = data.confidence
      fragment.sourceQuote = fragment.sourceQuote.includes(sourceText) ? fragment.sourceQuote : `${fragment.sourceQuote} / ${sourceText}`
    }
    scheduleAppStateSave()
    return fragment
  }

  function applyExtractedWorkFragments(items: LlmFragment[], sourceText: string) {
    if (!items.length) return
    const normalized = (value: string) => value.trim().toLocaleLowerCase()
    let lastFragment: WorkFragment | undefined
  
    const occurrenceCounts = new Map<string, number>()
    items.forEach((data, index) => {
      if (!data.title.trim()) return
      const occurrenceKey = `${normalized(data.title)}\u0000${normalized(data.actor)}`
      const occurrence = occurrenceCounts.get(occurrenceKey) ?? 0
      occurrenceCounts.set(occurrenceKey, occurrence + 1)
      const existing = workFragments.value.find((fragment) => (
        fragment.interviewId === activeInterviewId.value
        && (
          (data.source_reference && fragment.sourceReference === data.source_reference && fragment.sourceDocument === data.source_document)
          || (!data.source_reference
            && normalized(fragment.title) === normalized(data.title)
            && normalized(fragment.actor) === normalized(data.actor)
            && workFragments.value.filter((candidate) => (
              candidate.interviewId === activeInterviewId.value
              && normalized(candidate.title) === normalized(data.title)
              && normalized(candidate.actor) === normalized(data.actor)
            )).indexOf(fragment) === occurrence)
        )
      ))
      const fragment = existing ?? {
        id: `fragment-${Date.now()}-${index}`,
        title: data.title,
        description: data.description,
        departmentId: currentInterviewDepartmentId.value,
        actor: data.actor,
        participant: currentInterviewParticipant.value,
        trigger: data.trigger,
        tools: data.tools.length ? data.tools : ['未確認'],
        output: data.output,
        nextStep: data.next_step,
        nextActor: data.next_actor,
        standardTime: data.standard_time,
        processingVolume: data.processing_volume,
        sourceDocument: data.source_document,
        sourceReference: data.source_reference,
        dataItems: mergeInterviewDataItems([], data.data_items),
        personalization: data.personalization,
        sourceQuote: sourceText,
        sourceTime: 'いま',
        interviewId: activeInterviewId.value,
        confidence: data.confidence,
      }
      if (!existing) workFragments.value.unshift(fragment)
      else {
        fragment.description = data.description
        fragment.trigger = data.trigger
        fragment.tools = data.tools.length ? data.tools : ['未確認']
        fragment.output = data.output
        fragment.nextStep = data.next_step
        fragment.nextActor = data.next_actor
        fragment.standardTime = data.standard_time
        fragment.processingVolume = data.processing_volume
        fragment.sourceDocument = data.source_document
        fragment.sourceReference = data.source_reference
        fragment.dataItems = mergeInterviewDataItems(fragment.dataItems, data.data_items)
        fragment.personalization = data.personalization
        fragment.confidence = data.confidence
      }
      lastFragment = fragment
    })
    if (lastFragment) activeDiscoveryFragmentId.value = lastFragment.id
    scheduleAppStateSave()
  }

  return { applyLlmWorkFragment, applyExtractedWorkFragments }
}
