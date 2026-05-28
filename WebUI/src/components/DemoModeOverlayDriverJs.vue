<template>
  <div></div>
</template>

<script setup lang="ts">
import { driver, type DriveStep } from 'driver.js'
import 'driver.js/dist/driver.css'
import { useDemoMode, type DemoButtonId } from '@/assets/js/store/demoMode'
import { useI18N } from '@/assets/js/store/i18n'
import { computed } from 'vue'

const demoMode = useDemoMode()
const i18n = useI18N()

onMounted(() => {
  demoMode.registerDriverJs({
    triggerFirstTimeHelp: (buttonId: DemoButtonId) => triggerFirstTimeHelp(buttonId),
  })
})

type Step = {
  id: string
  title: string
  descr: string
  align?: 'start' | 'center' | 'end'
}

type StepList = Step[]

const SELECTOR_TO_MODE: Record<string, ModeType> = {
  '#mode-button-chat': 'chat',
  '#mode-button-imageGen': 'imageGen',
  '#mode-button-imageEdit': 'imageEdit',
  '#mode-button-video': 'video',
}

const enabledModes = computed(
  () => demoMode.profile?.enabledModes ?? ['chat', 'imageGen', 'imageEdit', 'video'],
)

function isStepEnabled(step: Step): boolean {
  const mode = SELECTOR_TO_MODE[step.id]
  return !mode || enabledModes.value.includes(mode)
}

const steps = computed<StepList>(() => [
  {
    id: '#demo-buttons-group',
    title: i18n.state.TOUR_WELCOME_TITLE,
    descr: i18n.state.TOUR_WELCOME_DESCR,
  },
  {
    id: '#mode-buttons',
    title: i18n.state.TOUR_MODE_PICK_TITLE,
    descr: i18n.state.TOUR_MODE_PICK_DESCR,
  },
  {
    id: '#prompt-input',
    title: i18n.state.TOUR_UNIFIED_PROMPT_TITLE,
    descr: i18n.state.TOUR_UNIFIED_PROMPT_DESCR,
  },
  {
    id: '#send-button',
    title: i18n.state.TOUR_READY_TITLE,
    descr: i18n.state.TOUR_READY_DESCR,
    align: 'end',
  },
])

const stepsAlternative = computed<StepList>(() => [
  {
    id: '#plus-icon',
    title: i18n.state.TOUR_PLUS_ICON_TITLE,
    descr: i18n.state.TOUR_PLUS_ICON_DESCR,
  },
  {
    id: '#mode-button-chat',
    title: i18n.state.TOUR_CHAT_TITLE,
    descr: i18n.state.TOUR_CHAT_DESCR,
  },
  {
    id: '#mode-button-imageGen',
    title: i18n.state.TOUR_IMAGE_GEN_TITLE,
    descr: i18n.state.TOUR_IMAGE_GEN_DESCR,
  },
  {
    id: '#mode-button-imageEdit',
    title: i18n.state.TOUR_IMAGE_EDIT_TITLE,
    descr: i18n.state.TOUR_IMAGE_EDIT_DESCR,
  },
  {
    id: '#mode-button-video',
    title: i18n.state.TOUR_VIDEO_TITLE,
    descr: i18n.state.TOUR_VIDEO_DESCR,
  },
  {
    id: '#microphone-button',
    title: i18n.state.TOUR_MIC_TITLE,
    descr: i18n.state.TOUR_MIC_DESCR,
  },
  {
    id: '#camera-button',
    title: i18n.state.TOUR_CAMERA_TITLE,
    descr: i18n.state.TOUR_CAMERA_DESCR,
  },
  {
    id: '#advanced-settings-button',
    title: i18n.state.TOUR_PROMPT_SETTINGS_TITLE,
    descr: i18n.state.TOUR_PROMPT_SETTINGS_DESCR,
    align: 'end',
  },
  {
    id: '#app-settings-button',
    title: i18n.state.TOUR_APP_SETTINGS_TITLE,
    descr: i18n.state.TOUR_APP_SETTINGS_DESCR,
  },
  {
    id: '#show-history-button',
    title: i18n.state.TOUR_HISTORY_TITLE,
    descr: i18n.state.TOUR_HISTORY_DESCR,
  },
])

function startTour() {
  const filteredSteps = steps.value.filter(isStepEnabled)
  const driverObj = driver({
    showProgress: true,
    showButtons: ['next', 'previous', 'close'],
    nextBtnText: i18n.state.TOUR_NEXT,
    prevBtnText: i18n.state.TOUR_PREV,
    doneBtnText: i18n.state.TOUR_DONE_BUTTON,
    popoverOffset: 20,
    steps: filteredSteps.map((step) => ({
      element: step.id,
      popover: {
        title: step.title,
        description: step.descr,
        side: 'top',
        align: step.align,
      },
    })),
  })
  driverObj.drive()
}

function startMiniTour(driverSteps: DriveStep[]) {
  if (driverSteps.length === 0) {
    console.warn('startMiniTour: No steps provided')
    return
  }

  const isSingleStep = driverSteps.length === 1

  const miniDriver = driver({
    showProgress: !isSingleStep,
    showButtons: isSingleStep ? ['next', 'close'] : ['next', 'previous', 'close'],
    nextBtnText: i18n.state.TOUR_NEXT,
    prevBtnText: i18n.state.TOUR_PREV,
    doneBtnText: i18n.state.TOUR_DONE_BUTTON,
    popoverOffset: 20,
    onHighlighted: (_element, _step, { driver: d }) => {
      requestAnimationFrame(() => {
        d.refresh()
        requestAnimationFrame(() => d.refresh())
      })
    },
    steps: driverSteps,
  })
  miniDriver.drive()
}

type ContextHelpTarget = ModeType | 'app-settings' | 'advanced-settings'

const contextHelpConfig: Record<ContextHelpTarget, { stepId: string; highlightElement: string }> = {
  chat: { stepId: '#mode-button-chat', highlightElement: '#prompt-input' },
  imageGen: { stepId: '#mode-button-imageGen', highlightElement: '#prompt-input' },
  imageEdit: { stepId: '#mode-button-imageEdit', highlightElement: '#prompt-input' },
  video: { stepId: '#mode-button-video', highlightElement: '#prompt-input' },
  'app-settings': { stepId: '#app-settings-button', highlightElement: '#app-settings-sidebar' },
  'advanced-settings': {
    stepId: '#advanced-settings-button',
    highlightElement: '#advanced-settings-sidebar',
  },
}

const firstTimeHelpConfig: Record<DemoButtonId, { stepId: string; highlightElement: string }> = {
  'plus-icon': { stepId: '#plus-icon', highlightElement: '#plus-icon' },
  'app-settings-button': {
    stepId: '#app-settings-button',
    highlightElement: '#app-settings-button',
  },
  'advanced-settings-button': {
    stepId: '#advanced-settings-button',
    highlightElement: '#advanced-settings-button',
  },
  'mode-button-chat': {
    stepId: '#mode-button-chat',
    highlightElement: '#prompt-input',
  },
  'mode-button-imageGen': {
    stepId: '#mode-button-imageGen',
    highlightElement: '#prompt-input',
  },
  'mode-button-imageEdit': {
    stepId: '#mode-button-imageEdit',
    highlightElement: '#prompt-input',
  },
  'mode-button-video': {
    stepId: '#mode-button-video',
    highlightElement: '#prompt-input',
  },
  'camera-button': {
    stepId: '#camera-button',
    highlightElement: '#camera-button',
  },
  'microphone-button': {
    stepId: '#microphone-button',
    highlightElement: '#microphone-button',
  },
}

function resolveDriverStep(target: ContextHelpTarget): DriveStep | null {
  const config = contextHelpConfig[target]
  const step = stepsAlternative.value.find((s) => s.id === config.stepId)
  if (!step) {
    console.warn(`triggerContextHelp: No step definition found for "${target}"`)
    return null
  }
  if (!isStepEnabled(step)) return null
  if (!document.querySelector(config.highlightElement)) {
    console.warn(`triggerContextHelp: DOM element "${config.highlightElement}" not found`)
    return null
  }
  return {
    element: config.highlightElement,
    popover: {
      title: step.title,
      description: step.descr,
      side: 'top',
      align: step.align,
    },
  }
}

function triggerContextHelp(
  mode: ModeType,
  appSettingsOpen: boolean,
  advancedSettingsOpen: boolean,
) {
  const targets: ContextHelpTarget[] = []
  if (appSettingsOpen) targets.push('app-settings')
  if (advancedSettingsOpen) targets.push('advanced-settings')
  targets.push(mode)

  const driverSteps = targets.map((target) => resolveDriverStep(target)).filter((s) => s !== null)

  startMiniTour(driverSteps)
}

function triggerFirstTimeHelp(buttonId: DemoButtonId) {
  const config = firstTimeHelpConfig[buttonId]
  if (!config) {
    console.warn(`triggerFirstTimeHelp: No config found for "${buttonId}"`)
    return
  }

  const step = stepsAlternative.value.find((s) => s.id === config.stepId)
  if (!step) {
    console.warn(`triggerFirstTimeHelp: No step definition found for "${buttonId}"`)
    return
  }

  if (!isStepEnabled(step)) return

  if (!document.querySelector(config.highlightElement)) {
    console.warn(`triggerFirstTimeHelp: DOM element "${config.highlightElement}" not found`)
    return
  }

  startMiniTour([
    {
      element: config.highlightElement,
      popover: {
        title: step.title,
        description: step.descr,
        side: 'top',
        align: step.align,
      },
    },
  ])
}

defineExpose({
  startTour,
  triggerContextHelp,
  triggerFirstTimeHelp,
})
</script>

<style>
/* Driver.js popover styling inspired by demo-mode.css */

/* DIALOG */

.driver-popover * {
  font-family: 'IntelOne';
}

.driver-popover {
  background: var(--demo-popover-bg);
  color: var(--demo-text-color);
  border: 1.5px solid var(--demo-popover-border);
  box-shadow: 0px 0.75px 4.95px var(--demo-popover-shadow);
  border-radius: 12px;
  padding: 16px 20px;
  min-width: 340px;
  max-width: 420px;
  font-family: unset;
  z-index: var(--demo-z-popover);
}

.driver-popover-title {
  font-size: 1.25rem;
  font-weight: bold;
  margin-bottom: 0.5em;
  color: var(--demo-title-color);
  font-family: unset;
}

.driver-popover-description {
  font-size: 1rem;
  margin-bottom: 1em;
  font-family: unset;
}

.driver-popover-footer {
  background: transparent;
  border-top: 1px solid var(--demo-popover-border);
  padding-top: 0.5rem;
  font-family: unset;
}

.driver-popover-progress-text {
  font-family: unset;
}

/* BUTTON */

.driver-popover-footer button {
  background: transparent;
  border: none;
  color: var(--demo-button-color);
  font-weight: bold;
  cursor: pointer;
  font-size: 18px;
  float: inline-end;
  text-shadow: none;
  font-family: unset;
}

.driver-popover-footer button:hover {
  background-color: transparent;
  text-decoration: underline;
}

.driver-popover-footer button:focus {
  background: transparent;
}

.driver-popover-close-btn {
  color: var(--demo-text-color);
  background: transparent;
  border: none;
  font-size: 1.5em;
  cursor: pointer;
  position: absolute;
  top: 12px;
  inset-inline-end: 16px;
}

.driver-popover-close-btn:hover,
.driver-popover-close-btn:focus {
  color: var(--demo-text-color);
}

/* HIGHLIGHTED ELEMENT */

.driver-active-element {
  /* Styling handled by driver.js */
}

/* ARROW */

.driver-popover-arrow {
  border: 10px solid transparent;
}

.driver-popover-arrow-side-left.driver-popover-arrow {
  border-left-color: var(--demo-popover-border);
}

.driver-popover-arrow-side-right.driver-popover-arrow {
  border-right-color: var(--demo-popover-border);
}

.driver-popover-arrow-side-top.driver-popover-arrow {
  border-top-color: var(--demo-popover-border);
}

.driver-popover-arrow-side-bottom.driver-popover-arrow {
  border-bottom-color: var(--demo-popover-border);
}

.driver-popover::before,
.driver-popover::after {
  display: none !important;
}

/* downward-facing triangle */
.driver-popover-arrow.driver-popover-arrow-side-top {
  border-top: 14px solid var(--demo-popover-border);
  border-left: 11px solid transparent;
  border-right: 11px solid transparent;
  border-bottom: none;
  background: transparent;
}

.driver-popover-arrow.driver-popover-arrow-side-top::after {
  content: '';
  position: absolute;
  border-top: 12px solid var(--demo-popover-bg);
  border-left: 10px solid transparent;
  border-right: 10px solid transparent;
  border-bottom: none;
  bottom: 3px;
  transform: translateX(-50%);
}

/* rightward-facing triangle */
.driver-popover-arrow.driver-popover-arrow-side-left {
  border-left: 14px solid var(--demo-popover-border);
  border-top: 11px solid transparent;
  border-bottom: 11px solid transparent;
  border-right: none;
}

.driver-popover-arrow.driver-popover-arrow-side-left::after {
  content: '';
  position: absolute;
  border-left: 12px solid var(--demo-popover-bg);
  border-top: 10px solid transparent;
  border-bottom: 10px solid transparent;
  border-right: none;
  right: 3px;
  transform: translateY(-50%);
}

/* upward-facing triangle */
.driver-popover-arrow.driver-popover-arrow-side-bottom {
  border-bottom: 14px solid var(--demo-popover-border);
  border-left: 11px solid transparent;
  border-right: 11px solid transparent;
  border-top: none;
}

.driver-popover-arrow.driver-popover-arrow-side-bottom::after {
  content: '';
  position: absolute;
  border-bottom: 12px solid var(--demo-popover-bg);
  border-left: 10px solid transparent;
  border-right: 10px solid transparent;
  border-top: none;
  top: 3px;
  transform: translateX(-50%);
}

/* leftward-facing triangle */
.driver-popover-arrow.driver-popover-arrow-side-right {
  border-right: 14px solid var(--demo-popover-border);
  border-top: 11px solid transparent;
  border-bottom: 11px solid transparent;
  border-left: none;
}

.driver-popover-arrow.driver-popover-arrow-side-right::after {
  content: '';
  position: absolute;
  border-right: 12px solid var(--demo-popover-bg);
  border-top: 10px solid transparent;
  border-bottom: 10px solid transparent;
  border-left: none;
  left: 3px;
  transform: translateY(-50%);
}

/* arrow position within the popup */
.driver-popover-arrow-side-top.driver-popover-arrow-align-start,
.driver-popover-arrow-side-bottom.driver-popover-arrow-align-start {
  left: 30px;
}

.driver-popover-arrow-side-top.driver-popover-arrow-align-end,
.driver-popover-arrow-side-bottom.driver-popover-arrow-align-end {
  right: 20px;
}
</style>
