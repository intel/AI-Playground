import type { HelpTopicId } from '@/assets/js/help/helpTopics'

/**
 * Anchors the demo tour uses that are deliberately not click-to-learn targets.
 * The help toggle is one: help mode refuses to explain its own chrome. Everything
 * else must be a `HelpTopicId`, so renaming an id in one surface fails type-check
 * in the other instead of silently orphaning a step.
 */
export const TOUR_ONLY_ANCHORS = ['#contextual-help-toggle'] as const

type TourOnlyAnchor = (typeof TOUR_ONLY_ANCHORS)[number]

export type TourStep = {
  id: `#${HelpTopicId}` | TourOnlyAnchor
  title: string
  descr: string
  align?: 'start' | 'center' | 'end'
}

/** Guided-narration copy for the demo-mode walkthrough, auto-started in demo mode. */
export const TOUR_STEPS: TourStep[] = [
  {
    id: '#contextual-help-toggle',
    title: 'Welcome to Intel AI-Playground!',
    descr:
      'Intel AI-Playground is a generative AI app that provides local-powered chat, image, and video capabilities. Whenever you want to know what something does, click this "?" button and then click the control — help mode explains it without changing anything. Click "Next" or press "Right" to start the tour.',
  },
  {
    id: '#mode-buttons',
    title: 'Pick your Mode',
    descr:
      'Here are multiple mode buttons, that define the type of content you are generating. Select any one of these modes later to explore each. Little dots generally indicate additional help is available when clicking the first time.',
  },
  {
    id: '#prompt-input',
    title: 'Unified Prompt',
    descr:
      'This is your Prompt field. This is the core experience of AI Playground, across all features of the app. This is where you write a prompt, add images or documents to guide your content, and select modes for the type of content you want to generate.',
  },
  {
    id: '#send-button',
    title: 'Ready to start?',
    descr:
      'This is the magic button that will start a generation. Select a mode like Chat, enter a question and click this button to get your first response.',
    align: 'end',
  },
]

/** Per-control copy used by the mini tours triggered from individual buttons. */
export const TOUR_STEPS_ALTERNATIVE: TourStep[] = [
  {
    id: '#plus-icon',
    title: 'Add Images or Documents',
    descr:
      "The PLUS icon allows you to load content like documents or images to the prompt. Alternatively you can also drag and drop content here. When added this content is part of your generation. In Chat mode you can ask questions about a document or an image. For Image Edit you can add images you want to edit. Note: If you're not able to load a certain type of document, check Prompt Settings as you might need to select a preset like Vision to support images, or RAG to support text documents",
  },
  {
    id: '#mode-button-chat',
    title: 'Chat Mode',
    descr:
      'Chat works like a typical AI chat. You can type questions to get information on almost any topic you can imagine. In the settings you can select from a variety of chat options where you can do document search, work with Reasoning or Vision models, and more. Click the prompt input to see a sample prompt!',
  },
  {
    id: '#mode-button-imageGen',
    title: 'Image Mode',
    descr:
      "The Image Gen mode allows you to generate images from text you enter. Describe a scene or character and style (photographic, watercolor, etc), you wish to generate, and have watching your ideas come to life. When in this mode, you'll find ready to go presets in the Prompt Settings that allow you to create images using generative models to achieve different levels of realism and generation times. Click the prompt input to see a sample prompt!",
  },
  {
    id: '#mode-button-imageEdit',
    title: 'Image Edit Mode',
    descr:
      'The Image Edit mode allows you to edit existing images or photos, often by describing what to change. Simply drag in a photo, select an editing Preset in Prompt Settings where you can upscale images, edit images with precision, generate 3D models from images, and more. An input image is already pre-selected for you. Click the prompt input to see a sample prompt!',
  },
  {
    id: '#mode-button-video',
    title: 'Video Mode',
    descr:
      'Video generation allows you to create short video clips from your imagination either from prompt or guided by images and video.',
  },
  {
    id: '#microphone-button',
    title: 'Mic Button',
    descr:
      "The Mic button is only active after you've selected and turned on Speech Mode in app settings.When done you simply click this icon, start talking in a language you're comfortable speaking, then click again. You'll see your speech written out as text in the prompt field.",
  },
  {
    id: '#camera-button',
    title: 'Camera Button',
    descr:
      'Click this button to capture an image from your camera. The captured image will be added to your prompt for vision-capable models to analyze.',
  },
  {
    id: '#advanced-settings-button',
    title: 'Prompt Settings',
    descr:
      'Each mode has prompt settings specific to the mode of content you are generating. Here you will find ready to go preset to do targeted tasks. Each preset is already dialed in to go, but you choose to adjust options and own values from Max Tokens in Chat, to Aspect Ratio settings for Image Gen. Prompt settings is at the heart of getting AI Playground to do what you want it to do. Select a Mode and explore what our Prompt Settings have to offer.',
    align: 'end',
  },
  {
    id: '#app-settings-button',
    title: 'Application Settings',
    descr:
      "Select this gear icon to see a list of application-level settings, from to language options, installation manager, and speech mode. You'll find important application settings here. Click here and select the Theme menu to give AI Playground different looks.",
  },
  {
    id: '#show-history-button',
    title: 'History Panel',
    descr:
      "The History Panel keeps track of all that you've generated. History will show you the latest content from each mode you used. Use this to scroll back through and revisit previous discussion and content generated from AI Playground.",
  },
]
