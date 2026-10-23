import { randomUUID } from 'node:crypto'
import { generateText } from 'ai'
import { ChatSummarizeRequestSchema, type ChatSummarizeRequest } from '@/types/chatIpc'
import { createMainChatModel } from './chatModelMain'
import { ensureChatBackendReady, setLastChatBackendLoadActive } from './chatReadiness'
import { finishTextRequest, submitTextRequest } from '../kernel/orchestrator'

// ── One-shot conversation summarization (step 6: chat inference in main) ────
//
// Title generation for conversations ran through the renderer's shared model
// factory before the move; the model call now has to come from main, so the
// store ships the same prompt plus a ChatModelConfig over `chat:summarize`.
// Step 15: admit as a short `text` occupancy and load here (remember: false
// so a Home Agent `/load` cannot overwrite the GPU swap-back snapshot).

const SUMMARY_PROMPT_PREFIX =
  'Summarize this conversation in 5 words or less. ' +
  'Output only the summary, no quotes, no punctuation.\n\n'

const SUMMARIZE_CONVERSATION_KEY = 'home-agent-summarize'

export async function summarizeConversationText(request: unknown): Promise<string> {
  const req = ChatSummarizeRequestSchema.parse(request) as ChatSummarizeRequest
  const config = req.model
  const runId = `summarize-${randomUUID()}`
  await submitTextRequest({
    runId,
    conversationKey: SUMMARIZE_CONVERSATION_KEY,
    needsGpu: config.backend !== 'cloud' && Boolean(config.readiness),
  })
  try {
    if (config.backend === 'cloud') {
      setLastChatBackendLoadActive(false)
    } else if (config.readiness) {
      await ensureChatBackendReady(config.readiness, {
        skipGpuAdmission: true,
        remember: false,
        conversationKey: SUMMARIZE_CONVERSATION_KEY,
      })
    }
    const { text } = await generateText({
      model: createMainChatModel(req.model),
      prompt: `${SUMMARY_PROMPT_PREFIX}${req.messagesText}`,
      maxOutputTokens: 24,
    })
    return text.trim().split(/\s+/).slice(0, 5).join(' ')
  } finally {
    finishTextRequest(runId)
  }
}
