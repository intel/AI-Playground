import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { getHelpTopic, type HelpTopic, type HelpTopicId } from '@/assets/js/help/helpTopics'

export type HelpPanelAnchor = {
  top: number
  left: number
  width: number
  height: number
}

export const useContextualHelp = defineStore('contextualHelp', () => {
  const active = ref(false)
  const panelTopicId = ref<HelpTopicId | null>(null)
  const panelTopicDynamic = ref<HelpTopic | null>(null)
  const anchor = ref<HelpPanelAnchor | null>(null)

  const panelTopic = computed(
    () =>
      panelTopicDynamic.value ??
      (panelTopicId.value ? getHelpTopic(panelTopicId.value) : undefined),
  )

  const panelOpen = computed(() => panelTopic.value !== undefined && anchor.value !== null)

  function setAnchorFromElement(el: HTMLElement) {
    const rect = el.getBoundingClientRect()
    anchor.value = {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    }
  }

  function openPanelForTopic(el: HTMLElement, topic: HelpTopic) {
    panelTopicId.value = null
    panelTopicDynamic.value = topic
    setAnchorFromElement(el)
  }

  function openPanel(el: HTMLElement, topicId: HelpTopicId) {
    panelTopicDynamic.value = null
    panelTopicId.value = topicId
    setAnchorFromElement(el)
  }

  function closePanel() {
    panelTopicId.value = null
    panelTopicDynamic.value = null
    anchor.value = null
  }

  function activate() {
    active.value = true
  }

  function deactivate() {
    active.value = false
    closePanel()
  }

  function toggle() {
    if (active.value) deactivate()
    else activate()
  }

  return {
    active,
    panelTopicId,
    panelTopicDynamic,
    anchor,
    panelTopic,
    panelOpen,
    setAnchorFromElement,
    openPanel,
    openPanelForTopic,
    closePanel,
    activate,
    deactivate,
    toggle,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useContextualHelp, import.meta.hot))
}
