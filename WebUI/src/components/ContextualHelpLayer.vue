<template>
  <Teleport to="body">
    <div
      v-if="contextualHelp.active"
      :id="HELP_PANEL_ID"
      class="pointer-events-none fixed inset-0 z-[40015]"
    >
      <div
        role="status"
        class="pointer-events-none fixed top-14 left-1/2 z-[40016] max-w-lg -translate-x-1/2 rounded-lg border border-primary/40 bg-primary/15 px-4 py-2.5 text-center text-sm font-medium text-foreground shadow-md backdrop-blur-sm"
      >
        Help mode — click a control to learn about it. Press Esc to exit.
      </div>
      <div
        v-if="contextualHelp.panelOpen && contextualHelp.panelTopic"
        ref="panelRef"
        class="pointer-events-auto fixed z-[40020] w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl"
        :style="panelStyle"
        role="dialog"
        :aria-labelledby="headingId"
        tabindex="-1"
      >
        <h2 :id="headingId" class="mb-2 text-base font-semibold">
          {{ contextualHelp.panelTopic.title }}
        </h2>
        <p class="text-sm leading-relaxed text-muted-foreground whitespace-pre-line">
          {{ contextualHelp.panelTopic.body }}
        </p>
        <div class="mt-4 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            @click="dismissPanel"
          >
            Got it
          </button>
          <button
            type="button"
            class="text-xs text-muted-foreground underline-offset-2 hover:underline"
            @click="exitHelpMode"
          >
            Exit help mode
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'
import {
  HELP_PANEL_ID,
  HELP_TOGGLE_ID,
  resolveHelpTarget,
  type HelpResolveResult,
} from '@/assets/js/help/helpTopics'
import {
  findPresetByName,
  helpTopicFromPreset,
  helpTopicFromPresetVariant,
} from '@/assets/js/help/presetHelp'
import { useContextualHelp } from '@/assets/js/store/contextualHelp'
import { usePresets } from '@/assets/js/store/presets'
import { usePromptStore } from '@/assets/js/store/promptArea'
import * as toast from '@/assets/js/toast'

const contextualHelp = useContextualHelp()
const presetsStore = usePresets()
const promptStore = usePromptStore()

const headingId = 'contextual-help-heading'
const panelRef = useTemplateRef<HTMLElement>('panelRef')

const HIGHLIGHT_CLASS = 'aipg-help-highlight'
const FALLBACK_PANEL_HEIGHT = 160

// The element the panel points at. Kept out of the store so no DOM node ends up in
// Pinia state; the layer is a singleton, so module scope is enough.
let highlightedEl: HTMLElement | null = null
let anchorEl: HTMLElement | null = null
let hoverFrame = 0
let repositionFrame = 0

const panelHeight = ref(FALLBACK_PANEL_HEIGHT)

const panelStyle = computed(() => {
  const a = contextualHelp.anchor
  if (!a) return {}
  const margin = 8
  const panelW = Math.min(352, window.innerWidth - 32)
  const left = Math.max(
    16,
    Math.min(a.left + a.width / 2 - panelW / 2, window.innerWidth - panelW - 16),
  )
  // Prefer above the anchor; flip below when there isn't room, and clamp so a tall
  // panel next to a bottom-edge control can't run off screen.
  const above = a.top - panelHeight.value - margin
  const top =
    above < 16
      ? Math.min(a.top + a.height + margin, window.innerHeight - panelHeight.value - 16)
      : above
  return {
    top: `${Math.max(16, top)}px`,
    left: `${left}px`,
  }
})

function clearHighlight() {
  highlightedEl?.classList.remove(HIGHLIGHT_CLASS)
  highlightedEl = null
}

function setHighlight(el: HTMLElement | null) {
  if (highlightedEl === el) return
  clearHighlight()
  if (el) {
    el.classList.add(HIGHLIGHT_CLASS)
    highlightedEl = el
  }
}

function topicFor(resolved: HelpResolveResult) {
  if (resolved.kind === 'static') return null
  const preferredType = promptStore.getCurrentMode() === 'chat' ? 'chat' : 'comfy'
  const preset = findPresetByName(presetsStore.presets, resolved.presetName, preferredType)
  return resolved.kind === 'preset'
    ? helpTopicFromPreset(preset, resolved.presetName)
    : helpTopicFromPresetVariant(preset, resolved.presetName, resolved.variantName)
}

function openHelpFor(resolved: HelpResolveResult) {
  anchorEl = resolved.element
  const topic = topicFor(resolved)
  if (topic) contextualHelp.openPanelForTopic(resolved.element, topic)
  else if (resolved.kind === 'static') contextualHelp.openPanel(resolved.element, resolved.topicId)
  setHighlight(resolved.element)
}

/** True when the event originated in help mode's own chrome, which must keep working. */
function isOwnChrome(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest(`#${HELP_PANEL_ID}, #${HELP_TOGGLE_ID}`) !== null
  )
}

function onCaptureClick(event: MouseEvent) {
  if (!contextualHelp.active || isOwnChrome(event.target)) return

  event.preventDefault()
  event.stopPropagation()

  const resolved = resolveHelpTarget(event.target)
  if (!resolved) {
    toast.show('No help topic here — try the prompt bar, mode buttons, or settings icons.')
    return
  }
  openHelpFor(resolved)
}

/**
 * Swallow the pointer events that controls actually act on. Blocking `click` alone
 * is not enough: radix-vue opens selects on `pointerdown` and sliders drag from it,
 * so those would still fire while help mode is meant to be inert. `click` is still
 * delivered afterwards, which is what opens the help panel.
 */
function onCapturePointerDown(event: Event) {
  if (!contextualHelp.active || isOwnChrome(event.target)) return
  event.preventDefault()
  event.stopPropagation()
}

function onCaptureMouseMove(event: MouseEvent) {
  if (!contextualHelp.active || contextualHelp.panelOpen) return
  const { target } = event
  // Hover resolution walks ancestors, so coalesce the stream into one pass per frame.
  if (hoverFrame) return
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0
    setHighlight(resolveHelpTarget(target)?.element ?? null)
  })
}

function onKeyDown(event: KeyboardEvent) {
  if (!contextualHelp.active || event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  if (contextualHelp.panelOpen) dismissPanel()
  else exitHelpMode()
}

/** Keep the panel glued to its anchor while the page scrolls or the window resizes. */
function onViewportChange() {
  if (!contextualHelp.panelOpen || !anchorEl) return
  if (repositionFrame) return
  repositionFrame = requestAnimationFrame(() => {
    repositionFrame = 0
    if (!anchorEl) return
    // The anchor can disappear while the panel is open (mode switch, popover close).
    if (!anchorEl.isConnected) {
      dismissPanel()
      return
    }
    contextualHelp.setAnchorFromElement(anchorEl)
  })
}

function focusToggle() {
  document.getElementById(HELP_TOGGLE_ID)?.focus()
}

function dismissPanel() {
  contextualHelp.closePanel()
  focusToggle()
}

function exitHelpMode() {
  contextualHelp.deactivate()
  focusToggle()
}

function bindListeners() {
  document.body.classList.add('aipg-help-mode')
  document.addEventListener('click', onCaptureClick, true)
  document.addEventListener('pointerdown', onCapturePointerDown, true)
  document.addEventListener('mousedown', onCapturePointerDown, true)
  document.addEventListener('mousemove', onCaptureMouseMove, true)
  document.addEventListener('keydown', onKeyDown, true)
  // Capture so nested scroll containers (settings sidebars) are covered too.
  document.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)
}

function unbindListeners() {
  document.body.classList.remove('aipg-help-mode')
  document.removeEventListener('click', onCaptureClick, true)
  document.removeEventListener('pointerdown', onCapturePointerDown, true)
  document.removeEventListener('mousedown', onCapturePointerDown, true)
  document.removeEventListener('mousemove', onCaptureMouseMove, true)
  document.removeEventListener('keydown', onKeyDown, true)
  document.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
  if (hoverFrame) cancelAnimationFrame(hoverFrame)
  if (repositionFrame) cancelAnimationFrame(repositionFrame)
  hoverFrame = 0
  repositionFrame = 0
  anchorEl = null
  clearHighlight()
}

watch(
  () => contextualHelp.active,
  (on) => {
    if (on) bindListeners()
    else unbindListeners()
  },
)

// Keyed on the resolved topic rather than `panelTopicId`: the latter stays null for
// preset topics, so closing one was a null -> null transition that never fired.
watch(
  () => contextualHelp.panelOpen,
  async (open) => {
    if (!open) {
      anchorEl = null
      clearHighlight()
      panelHeight.value = FALLBACK_PANEL_HEIGHT
      return
    }
    await nextTick()
    // Measure the rendered panel so the above/below flip uses the real height.
    if (panelRef.value) panelHeight.value = panelRef.value.offsetHeight
    panelRef.value?.focus()
  },
)

onBeforeUnmount(() => {
  if (contextualHelp.active) contextualHelp.deactivate()
  unbindListeners()
})
</script>

<style>
body.aipg-help-mode {
  cursor: help;
}

/* Controls are inert while help mode is on, so don't keep promising `pointer`. */
body.aipg-help-mode button,
body.aipg-help-mode a,
body.aipg-help-mode input,
body.aipg-help-mode textarea,
body.aipg-help-mode [role='button'] {
  cursor: not-allowed;
}

/* Only elements that actually have help copy advertise it, so the cursor doesn't
   promise a topic that resolves to the "no help here" toast. Mirrors the anchors
   understood by resolveHelpTarget(). */
body.aipg-help-mode [data-aipg-help],
body.aipg-help-mode [data-aipg-preset-name],
body.aipg-help-mode #prompt-input,
body.aipg-help-mode #plus-icon,
body.aipg-help-mode #mode-buttons,
body.aipg-help-mode [id^='mode-button-'],
body.aipg-help-mode #send-button,
body.aipg-help-mode #camera-button,
body.aipg-help-mode #microphone-button,
body.aipg-help-mode #advanced-settings-button,
body.aipg-help-mode #app-settings-button,
body.aipg-help-mode #show-history-button,
body.aipg-help-mode #app-settings-sidebar,
body.aipg-help-mode #advanced-settings-sidebar {
  cursor: help;
}

/* Help mode's own chrome stays interactive. */
body.aipg-help-mode #contextual-help-toggle,
body.aipg-help-mode #contextual-help-panel button {
  cursor: pointer;
}

.aipg-help-highlight {
  outline: 2px solid hsl(var(--primary));
  outline-offset: 2px;
  border-radius: 4px;
}
</style>
