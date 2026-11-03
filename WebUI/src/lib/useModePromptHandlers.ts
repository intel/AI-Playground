import { nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useErrors } from '@/assets/js/store/errors'
import { useI18N } from '@/assets/js/store/i18n'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets'
import { useMediaAgentRuns } from '@/assets/js/store/mediaAgentRuns'
import { useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
import { usePresets } from '@/assets/js/store/presets'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { useSessionAudio } from '@/assets/js/store/sessionAudio'
import { useTextInference } from '@/assets/js/store/textInference'
import { ensureMediaAgentEventWiring } from '@/assets/js/agents/mediaAgent'
import { createAppError, isCancellation } from '@/assets/js/errors/appError'
import { pendingVoiceTurn, speak, speakRepliesAvailable } from '@/assets/js/speech/speechIO'
import { toolPartNameOf } from '@/lib/agentTranscript'
import { messageText } from '@/lib/chatMessageText'

const MEDIA_MODES: WorkflowModeType[] = ['imageGen', 'imageEdit', 'video']

/**
 * What the prompt bar does in each mode, registered once for the whole app, so that
 * the main area can stay the same Session timeline whichever mode is active.
 */
export function useModePromptHandlers(options: { scrollToBottom: () => void }) {
  const promptStore = usePromptStore()
  const chat = useOpenAiCompatibleChat()
  const textInference = useTextInference()
  const mediaAgentRuns = useMediaAgentRuns()
  const agentMode = useAgentMode()
  const agentTasks = useAgentTasks()
  const imageGeneration = useImageGenerationPresets()
  const presets = usePresets()
  const sessionAudio = useSessionAudio()
  const errors = useErrors()
  const languages = useI18N().state

  async function submitChat(prompt: string): Promise<void> {
    const question = prompt.trim()
    if (question === '') {
      errors.report(
        createAppError({
          category: 'validation',
          code: 'inference/empty-prompt',
          userMessage: languages.ANSWER_ERROR_NOT_PROMPT,
          surface: 'toast',
        }),
      )
      promptStore.promptSubmitted = false
      return
    }
    try {
      void nextTick(options.scrollToBottom)
      await chat.generate(question)
    } catch (error) {
      // generate() already reported through the sink, which dedupes this one.
      promptStore.promptSubmitted = false
      errors.report(error, { category: 'inference', code: 'inference/generate-failed' })
    }
  }

  // Only this conversation's turn: a bare artifact cancel would kill whichever run holds the GPU.
  function cancelChat(): void {
    if (chat.processing) chat.stop()
    promptStore.promptSubmitted = false
  }

  function submitAgent(prompt: string): void {
    options.scrollToBottom()
    void agentTasks.submitPrompt(prompt)
  }

  // A run may be between Steps with no turn to stop, so the run is stopped instead.
  function cancelAgent(): void {
    const sessionId = agentMode.openSessionId
    const task = agentTasks.taskLockingSession(sessionId)
    if (task) void agentTasks.stopTask(task.id)
    else if (agentTasks.promptRunOf(sessionId)) void agentTasks.stopPromptRun(sessionId)
    else void agentMode.stop()
  }

  function generateMedia(mode: WorkflowModeType) {
    return async (prompt: string): Promise<void> => {
      try {
        imageGeneration.prompt = prompt
        await imageGeneration.generate(mode)
      } catch (error) {
        promptStore.promptSubmitted = false
        imageGeneration.processing = false
        if (isCancellation(error)) return
        errors.report(error, {
          category: 'generation',
          code: 'generation/submit-failed',
          userMessage: languages.SESSION_IMAGE_GENERATION_FAILED,
        })
      }
    }
  }

  async function synthesize(text: string): Promise<void> {
    const preset = presets.activePreset
    if (preset?.type !== 'chat' || !preset.ttsPreset) {
      promptStore.promptSubmitted = false
      return
    }
    await sessionAudio.synthesize(text)
  }

  watch(
    () => chat.messages,
    (messages) => {
      for (const message of messages ?? []) {
        if (message.role !== 'assistant' || !Array.isArray(message.parts)) continue
        for (const part of message.parts) {
          if (toolPartNameOf(part) !== 'media') continue
          const id = (part as { toolCallId?: string }).toolCallId
          if (!id) continue
          const state = (part as { state?: string }).state
          if (state === 'output-available' && (part as { output?: unknown }).output != null) {
            mediaAgentRuns.endRun(id, 'done')
          }
          if (state === 'output-error') mediaAgentRuns.endRun(id, 'failed')
        }
      }
    },
    { deep: true, immediate: true },
  )

  // Auto-play the assistant reply when the user's input came from speech.
  watch(
    () => chat.processing,
    (processing, wasProcessing) => {
      if (!(wasProcessing && !processing)) return
      if (!speakRepliesAvailable() || !textInference.speakRepliesAllowed()) return
      if (!pendingVoiceTurn.value) return
      pendingVoiceTurn.value = false
      const last = chat.messages?.at(-1)
      if (!last || last.role !== 'assistant') return
      const text = messageText(last)
      if (text.trim().length > 0) void speak({ text, messageId: last.id })
    },
  )

  watch(
    () => promptStore.getCurrentMode(),
    (mode) => agentMode.setViewShown(mode === 'agent'),
    { immediate: true },
  )

  onMounted(() => {
    ensureMediaAgentEventWiring()
    promptStore.registerSubmitCallback('chat', submitChat)
    promptStore.registerCancelCallback('chat', cancelChat)
    promptStore.registerSubmitCallback('agent', submitAgent)
    promptStore.registerCancelCallback('agent', cancelAgent)
    promptStore.registerSubmitCallback('audio', synthesize)
    for (const mode of MEDIA_MODES) {
      promptStore.registerSubmitCallback(mode, generateMedia(mode))
      promptStore.registerCancelCallback(mode, () => imageGeneration.stopGeneration())
    }
  })

  onUnmounted(() => {
    agentMode.setViewShown(false)
    for (const mode of ['chat', 'agent', 'audio', ...MEDIA_MODES] as ModeType[]) {
      promptStore.unregisterSubmitCallback(mode)
      promptStore.unregisterCancelCallback(mode)
    }
  })
}
