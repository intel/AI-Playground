/**
 * Canonical list of DOM ids that carry help copy. The demo-mode tour
 * (`tourSteps.ts`) anchors its steps to the same ids, so keeping the list in one
 * place is what stops the two surfaces from drifting apart.
 */
export type HelpTopicId =
  | 'prompt-input'
  | 'plus-icon'
  | 'mode-buttons'
  | 'mode-button-chat'
  | 'mode-button-imageGen'
  | 'mode-button-imageEdit'
  | 'mode-button-video'
  | 'send-button'
  | 'camera-button'
  | 'microphone-button'
  | 'advanced-settings-button'
  | 'advanced-settings-sidebar'
  | 'app-settings-button'
  | 'app-settings-sidebar'
  | 'show-history-button'
  | 'preset-selector'

export type HelpTopic = {
  title: string
  body: string
}

/**
 * Short "what is this" copy for click-to-learn help mode. The demo tour uses the
 * longer, guided-narration variants in `tourSteps.ts` for the same anchors.
 *
 * POC copy — move to i18n (`src/assets/i18n/*.json`) when productizing.
 */
export const HELP_TOPICS: Record<HelpTopicId, HelpTopic> = {
  'prompt-input': {
    title: 'Unified Prompt',
    body: 'Write prompts here for every mode. Attach images or documents (plus icon or drag-and-drop) to guide chat, image edit, or other workflows.',
  },
  'plus-icon': {
    title: 'Add images or documents',
    body: 'Load files into the prompt or drag and drop onto the field. In Chat, ask about documents or images. For Image Edit, add images to edit. Use Prompt Settings presets (Vision, RAG, etc.) if a file type is not supported.',
  },
  'mode-buttons': {
    title: 'Pick your mode',
    body: 'These buttons switch what you generate: Chat, Image Gen, Image Edit, or Video. Each mode has its own presets and settings.',
  },
  'mode-button-chat': {
    title: 'Chat mode',
    body: 'Ask questions like a typical AI chat. In Prompt Settings, choose models and options such as RAG, reasoning, or vision.',
  },
  'mode-button-imageGen': {
    title: 'Image Gen mode',
    body: 'Describe a scene, character, or style to generate images. Presets in Prompt Settings control quality, speed, and look.',
  },
  'mode-button-imageEdit': {
    title: 'Image Edit mode',
    body: 'Edit photos by describing changes. Use presets to upscale, inpaint, outpaint, create 3D from images, and more.',
  },
  'mode-button-video': {
    title: 'Video mode',
    body: 'Create short video clips from text prompts, optionally guided by reference images or video.',
  },
  'send-button': {
    title: 'Send',
    body: 'Starts generation for the current mode. While a run is in progress this becomes Stop.',
  },
  'camera-button': {
    title: 'Camera',
    body: 'Capture a photo from your camera and attach it to the prompt for vision-capable chat models.',
  },
  'microphone-button': {
    title: 'Microphone',
    body: 'Record speech into the prompt after Speech to Text is enabled in App Settings.',
  },
  'advanced-settings-button': {
    title: 'Prompt settings',
    body: 'Mode-specific presets and options: model, tokens, aspect ratio, seeds, and more. This is where you tune each workflow.',
  },
  'advanced-settings-sidebar': {
    title: 'Prompt settings panel',
    body: 'Browse presets and adjust parameters for the active mode. Changes apply to the next generation.',
  },
  'app-settings-button': {
    title: 'App settings',
    body: 'Language, theme, backend installation, speech mode, and other application-wide options.',
  },
  'app-settings-sidebar': {
    title: 'App settings panel',
    body: 'Configure backends, appearance, and global features from this sidebar.',
  },
  'show-history-button': {
    title: 'History',
    body: 'Reopen past chat and generation history across modes.',
  },
  'preset-selector': {
    title: 'Presets',
    body: 'Each tile is a preset tuned for a task (chat model, image workflow, etc.). Click a tile to select it; use help mode on a tile to read what that preset does.',
  },
}

export function getHelpTopic(id: string): HelpTopic | undefined {
  return Object.prototype.hasOwnProperty.call(HELP_TOPICS, id)
    ? HELP_TOPICS[id as HelpTopicId]
    : undefined
}

export const HELP_TOGGLE_ID = 'contextual-help-toggle'
export const HELP_PANEL_ID = 'contextual-help-panel'

const HELP_ATTR = 'data-aipg-help'
const PRESET_NAME_ATTR = 'data-aipg-preset-name'
const VARIANT_NAME_ATTR = 'data-aipg-variant-name'

export type HelpResolveResult =
  | { element: HTMLElement; kind: 'static'; topicId: HelpTopicId }
  | { element: HTMLElement; kind: 'preset'; presetName: string }
  | { element: HTMLElement; kind: 'preset-variant'; presetName: string; variantName: string }

function isOwnChrome(from: HTMLElement): boolean {
  for (let el: HTMLElement | null = from; el; el = el.parentElement) {
    if (el.id === HELP_TOGGLE_ID || el.id === HELP_PANEL_ID) return true
  }
  return false
}

/**
 * Walks up from an event target to the nearest element carrying help metadata.
 * Own chrome (the toggle and the panel) resolves to `null` so help mode never
 * explains itself.
 */
export function resolveHelpTarget(from: EventTarget | null): HelpResolveResult | null {
  if (!(from instanceof HTMLElement)) return null
  if (isOwnChrome(from)) return null

  for (let el: HTMLElement | null = from; el && el !== document.body; el = el.parentElement) {
    // A variant tile carries both attributes; the variant name is the internal
    // name, not the display label, so preset lookups line up.
    const presetName = el.getAttribute(PRESET_NAME_ATTR)
    const variantName = el.getAttribute(VARIANT_NAME_ATTR)
    if (presetName && variantName) {
      return { kind: 'preset-variant', element: el, presetName, variantName }
    }
    if (presetName) {
      return { kind: 'preset', element: el, presetName }
    }

    const topicId = el.getAttribute(HELP_ATTR) ?? el.id
    if (getHelpTopic(topicId)) {
      return { kind: 'static', topicId: topicId as HelpTopicId, element: el }
    }
  }
  return null
}
