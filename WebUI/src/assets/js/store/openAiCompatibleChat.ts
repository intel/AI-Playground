import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'
import { Chat } from '@ai-sdk/vue'
import {
  convertToModelMessages,
  type FileUIPart,
  DefaultChatTransport,
  LanguageModelUsage,
  streamText,
  stepCountIs,
  type ToolSet,
  UIDataTypes,
  UIMessage,
} from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { useTextInference } from './textInference'
import { useConversations } from './conversations'
import { aipgTools } from '../tools/tools'
import z from 'zod'
import { AipgTools } from '../tools/tools'
import * as toast from '../toast'
import { LanguageModelV2ToolResultOutput, JSONSchema7 } from '@ai-sdk/provider'
import { dynamicTool, jsonSchema } from '@ai-sdk/provider-utils'
import { imageUrlToDataUri } from '@/lib/utils'

const LlamaCppRawValueTimingsSchema = z.object({
  cache_n: z.number(),
  prompt_n: z.number(),
  prompt_ms: z.number(),
  prompt_per_token_ms: z.number(),
  prompt_per_second: z.number(),
  predicted_n: z.number(),
  predicted_ms: z.number(),
  predicted_per_token_ms: z.number(),
  predicted_per_second: z.number(),
})

const LlamaCppRawValueSchema = z.object({
  choices: z.array(z.any()).optional(),
  created: z.number().optional(),
  id: z.string().optional(),
  model: z.string().optional(),
  system_fingerprint: z.string().optional(),
  object: z.string().optional(),
  usage: z
    .object({
      completion_tokens: z.number(),
      prompt_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
  timings: LlamaCppRawValueTimingsSchema.optional(),
})

export type AipgMetadata = {
  model?: string
  timestamp?: number
  conversationTitle?: string
  timings?: z.infer<typeof LlamaCppRawValueTimingsSchema>
  ragSource?: string
  usage?: LanguageModelUsage
}

export type AipgUiMessage = UIMessage<AipgMetadata, UIDataTypes, AipgTools>

export const useOpenAiCompatibleChat = defineStore(
  'openAiCompatibleChat',
  () => {
    const textInference = useTextInference()
    const conversations = useConversations()
    const manuallyStopped = ref(false)

    const processing = computed(() => {
      // If manually stopped, immediately return false to unblock UI
      if (manuallyStopped.value) return false
      const status = chats[conversations.activeKey]?.status
      return status === 'submitted' || status === 'streaming'
    })

    const model = computed(() =>
      createOpenAICompatible({
        name: 'model',
        baseURL: `${textInference.currentBackendUrl}/v1/`,
        includeUsage: true,
      }).chatModel(textInference.activeModel?.split('/').join('---') ?? ''),
    )

    function isToolEnabled(toolName: string): boolean {
      const name = toolName.toLowerCase()
      // These blender tools fill up context, but still only work with separate api keys
      const excludedKeywords = ['hyper', 'rodin', 'sketchfab', 'hunyuan', 'polyhaven']
      return !excludedKeywords.some((keyword) => name.includes(keyword))
    }

    async function resolveTools(): Promise<ToolSet> {
      if (!textInference.modelSupportsToolCalling) return {}

      const builtinTools = resolveBuiltinTools()
      const mcpTools = await resolveMcpTools()
      return { ...builtinTools, ...mcpTools }
    }

    function resolveBuiltinTools(): ToolSet {
      if (!textInference.aipgToolsEnabled) return {}
      return { ...aipgTools }
    }

    async function resolveMcpTools(): Promise<ToolSet> {
      if (!textInference.mcpToolsEnabled) return {}

      const resolvedTools: ToolSet = {}
      let servers: Awaited<ReturnType<typeof window.electronAPI.mcp.listServers>>
      try {
        servers = await window.electronAPI.mcp.listServers()
      } catch (error) {
        console.error('Failed to list MCP servers:', error)
        return {}
      }

      for (const server of servers) {
        let status: Awaited<ReturnType<typeof window.electronAPI.mcp.getServerStatus>>
        try {
          status = await window.electronAPI.mcp.getServerStatus(server.id)
        } catch (error) {
          console.error(`Failed to get MCP server status for ${server.id}:`, error)
          continue
        }
        if (status.state !== 'running') {
          continue
        }

        let allMcpTools: Awaited<ReturnType<typeof window.electronAPI.mcp.listServerTools>>
        try {
          allMcpTools = await window.electronAPI.mcp.listServerTools(server.id)
        } catch (error) {
          console.error(`Failed to list MCP tools for ${server.id}:`, error)
          continue
        }
        const mcpTools = allMcpTools.filter((t) => isToolEnabled(t.name))

        for (const mcpTool of mcpTools) {
          const aiToolName = `mcp__${server.id}__${mcpTool.name}`
          resolvedTools[aiToolName] = dynamicTool({
            description: mcpTool.description || `${server.name} tool: ${mcpTool.name}`,
            inputSchema: jsonSchema({
              ...mcpTool.inputSchema,
              properties: mcpTool.inputSchema.properties ?? {},
              additionalProperties: false,
            } as JSONSchema7),
            execute: async (input) => {
              const args = input as Record<string, unknown>
              return await window.electronAPI.mcp.invokeServerTool(server.id, mcpTool.name, args)
            },
          }) as ToolSet[string]
        }
      }

      return resolvedTools
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const customFetch = async (_: any, options: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = JSON.parse(options.body) as any
      const reasoningTimings = new Map<string, { started: number; finished: number }>()
      const startOfRequestTime: number = Date.now()
      let firstTokenTime: number = 0
      let finishTime: number = 0
      let timings: z.infer<typeof LlamaCppRawValueTimingsSchema> | undefined = undefined
      let usage: LanguageModelUsage | undefined = undefined
      let usageFromRawChunk: LanguageModelUsage | undefined = undefined
      let lastStepUsage: LanguageModelUsage | undefined = undefined
      const systemPromptToUse = temporarySystemPrompt.value || textInference.systemPrompt
      let messages = await convertToModelMessages(m.messages)

      // Convert aipg-media image URLs to base64 for the backend
      messages = await Promise.all(
        messages.map(async (msg) => {
          if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg
          const content = await Promise.all(
            msg.content.map(async (part) => {
              if (
                part.type === 'file' &&
                part.mediaType?.startsWith('image/') &&
                typeof part.data === 'string' &&
                part.data.startsWith('aipg-media://')
              ) {
                return { ...part, data: await imageUrlToDataUri(part.data) }
              }
              return part
            }),
          )
          return { ...msg, content }
        }),
      )

      // Filter out annotatedImageUrl json from tool results
      messages = messages.map((m) => {
        if (m.role !== 'tool') return m
        return {
          ...m,
          content: m.content.map((part) => {
            if (
              part.type === 'tool-result' &&
              part.toolName === 'visualizeObjectDetections' &&
              part.output.type === 'json'
            ) {
              return {
                ...part,
                output: {
                  type: 'text',
                  value: 'Object detections visualized on image successfully',
                } as LanguageModelV2ToolResultOutput,
              }
            }
            return part
          }),
        }
      })

      // Filter out image parts from messages if model doesn't support vision
      if (!textInference.modelSupportsVision) {
        messages = messages.map((msg) => {
          if (msg.role === 'user' && Array.isArray(msg.content)) {
            const filteredContent = msg.content.filter((part) => part.type === 'text')
            // If all content was images, keep at least an empty text
            if (filteredContent.length === 0) {
              return {
                ...msg,
                content: [
                  {
                    type: 'text' as const,
                    text: 'This message contained an image, but the model does not support vision.',
                  },
                ],
              }
            }
            return { ...msg, content: filteredContent }
          }
          return msg
        })
      }

      // Only enable tools if model supports tool calling and tools are enabled
      console.log(
        'textInference.modelSupportsToolCalling:',
        textInference.modelSupportsToolCalling,
        'textInference.aipgToolsEnabled:',
        textInference.aipgToolsEnabled,
        'textInference.mcpToolsEnabled:',
        textInference.mcpToolsEnabled,
      )
      const availableTools = await resolveTools()
      const hasTools = Object.keys(availableTools).length > 0

      console.log('customFetch called with messages:', {
        messages,
        systemPromptToUse,
        hasTools,
      })
      const result = await streamText({
        model: model.value,
        messages,
        abortSignal: options.signal,
        system: systemPromptToUse,
        maxOutputTokens: textInference.maxTokens,
        temperature: textInference.temperature,
        includeRawChunks: true,
        ...(hasTools
          ? {
              tools: availableTools,
              stopWhen: stepCountIs(20),
            }
          : {}),
        onChunk: (chunk) => {
          if (chunk.chunk.type === 'raw') {
            const rawValue = LlamaCppRawValueSchema.safeParse(chunk.chunk.rawValue)
            if (rawValue.success) {
              if (rawValue.data.timings) {
                timings = rawValue.data.timings
              }
              if (rawValue.data.usage) {
                const u = rawValue.data.usage
                usageFromRawChunk = {
                  inputTokens: u.prompt_tokens,
                  outputTokens: u.completion_tokens,
                  totalTokens: u.total_tokens,
                  inputTokenDetails: {
                    noCacheTokens: undefined,
                    cacheReadTokens: undefined,
                    cacheWriteTokens: undefined,
                  },
                  outputTokenDetails: {},
                } as LanguageModelUsage
                if (!timings) {
                  const now = Date.now()
                  const promptMs = Math.max(
                    0,
                    firstTokenTime ? firstTokenTime - startOfRequestTime : 0,
                  )
                  const predictedMs = Math.max(
                    0,
                    firstTokenTime ? now - firstTokenTime : now - startOfRequestTime,
                  )
                  timings = {
                    cache_n: 0,
                    prompt_n: u.prompt_tokens,
                    prompt_ms: promptMs,
                    prompt_per_token_ms: u.prompt_tokens > 0 ? promptMs / u.prompt_tokens : 0,
                    prompt_per_second: promptMs > 0 ? (u.prompt_tokens / promptMs) * 1000 : 0,
                    predicted_n: u.completion_tokens,
                    predicted_ms: predictedMs,
                    predicted_per_token_ms:
                      u.completion_tokens > 0 ? predictedMs / u.completion_tokens : 0,
                    predicted_per_second:
                      predictedMs > 0 ? (u.completion_tokens / predictedMs) * 1000 : 0,
                  }
                }
              }
            }
          }
          // Track per-block reasoning timing. The SDK reuses the same reasoning ID (e.g., "reasoning-0")
          // across multiple tool call cycles, but onChunk never receives reasoning-start/reasoning-end.
          // We detect a new reasoning block by a >100ms gap since the last delta (tool execution time).
          if (chunk.chunk.type === 'reasoning-delta') {
            if (!firstTokenTime) {
              firstTokenTime = Date.now()
            }
            const reasoningId = chunk.chunk.id
            const now = Date.now()
            let timing = reasoningTimings.get(reasoningId)
            if (!timing || now - timing.finished > 100) {
              timing = { started: now, finished: now }
              reasoningTimings.set(reasoningId, timing)
            } else {
              timing.finished = now
            }
            chunk.chunk.providerMetadata = {
              aipg: {
                reasoningStarted: timing.started,
                reasoningFinished: timing.finished,
              },
            }
          }
          if (chunk.chunk.type === 'text-delta') {
            if (!firstTokenTime) {
              firstTokenTime = Date.now()
            }
          }
        },
        onFinish: (result) => {
          finishTime = Date.now()
          console.log('Stream finished:', result)
          if (result.usage) {
            usage = result.usage
          } else if (usageFromRawChunk) {
            usage = usageFromRawChunk
          }
          if (!timings) {
            const effectiveUsage = result.usage ?? usageFromRawChunk
            const promptMs = Math.max(0, firstTokenTime ? firstTokenTime - startOfRequestTime : 0)
            const predictedMs = Math.max(
              0,
              firstTokenTime ? finishTime - firstTokenTime : finishTime - startOfRequestTime,
            )
            const inputTokens = effectiveUsage?.inputTokens ?? 0
            const outputTokens = effectiveUsage?.outputTokens ?? 0
            timings = {
              cache_n: effectiveUsage?.cachedInputTokens ?? 0,
              prompt_n: inputTokens,
              prompt_ms: promptMs,
              prompt_per_token_ms: inputTokens > 0 ? promptMs / inputTokens : 0,
              prompt_per_second: promptMs > 0 ? (inputTokens / promptMs) * 1000 : 0,
              predicted_n: outputTokens,
              predicted_ms: predictedMs,
              predicted_per_token_ms: outputTokens > 0 ? predictedMs / outputTokens : 0,
              predicted_per_second: predictedMs > 0 ? (outputTokens / predictedMs) * 1000 : 0,
            }
          }
        },
      })

      return result.toUIMessageStreamResponse({
        sendReasoning: true,
        messageMetadata: (options) => {
          if (options.part.type === 'text-delta' || options.part.type === 'reasoning-delta') {
            return {}
          }

          if (options.part.type === 'finish-step') {
            lastStepUsage = options.part.usage
          }

          let effectiveUsage: LanguageModelUsage | undefined = undefined
          if (options.part.type === 'finish') {
            effectiveUsage = lastStepUsage ?? options.part.totalUsage
          }

          return {
            model: textInference.activeModel,
            timestamp: Date.now(),
            timings,
            usage: effectiveUsage ?? usage,
          }
        },
      })
    }

    const chats: Record<string, Chat<AipgUiMessage>> = {}

    watch(
      () => conversations.activeKey,
      (activeKey) => {
        if (!activeKey) return
        if (activeKey in chats) return
        const chat = new Chat<AipgUiMessage>({
          transport: new DefaultChatTransport({
            fetch: customFetch,
            body: { timings_per_token: true },
          }),
          messages: conversations.conversationList[activeKey],
        })
        chats[activeKey] = chat
        console.log('Created new chat for key:', {
          activeKey,
          chat,
          messages: conversations.conversationList[activeKey],
        })
      },
      { immediate: true },
    )

    watch(
      () => chats[conversations.activeKey]?.messages,
      () => {
        console.log('chat messages changed:', chats[conversations.activeKey]?.messages)
      },
    )

    const messages = computed(() => chats[conversations.activeKey]?.messages)

    const contextUsage = computed(() => {
      const lastAssistantMessage = messages.value?.findLast((m) => m.metadata?.usage)
      return lastAssistantMessage?.metadata?.usage
    })

    const usedTokens = computed(() => {
      return (contextUsage.value?.inputTokens ?? 0) + (contextUsage.value?.outputTokens ?? 0)
    })

    const messageInput = ref('')
    const fileInput = ref<FileUIPart[]>([])
    const temporarySystemPrompt = ref<string | null>(null)

    async function generate(question: string) {
      // 1. Ensure backend and models are ready
      await textInference.ensureReadyForInference()

      // Reset manual stop flag
      manuallyStopped.value = false

      // 2. Block if images attached to non-vision model
      if (fileInput.value.length > 0 && !textInference.modelSupportsVision) {
        const hasImageFiles = fileInput.value.some((part) => part.mediaType?.startsWith('image/'))
        if (hasImageFiles) {
          const errorMessage =
            'The selected model does not support image inputs. Please remove the images or select a vision-capable model.'
          toast.error(errorMessage)
          throw new Error(errorMessage)
        }
      }

      // 3. Prepare RAG context (if RAG is enabled)
      const ragContext = await textInference.prepareRagContext(question)
      console.log('ragContext', ragContext)
      temporarySystemPrompt.value = ragContext.systemPrompt

      // 4. Get chat instance and send message
      const chat = chats[conversations.activeKey]
      if (!chat) {
        throw new Error(`No chat instance found for conversation: ${conversations.activeKey}`)
      }

      messageInput.value = question
      try {
        await chat.sendMessage({
          text: messageInput.value,
          files: fileInput.value.length > 0 ? fileInput.value : undefined,
          metadata: {
            model: textInference.activeModel,
            timestamp: Date.now(),
          },
        })
      } finally {
        temporarySystemPrompt.value = null
      }

      // 5. Store RAG source in message metadata
      if (ragContext.ragSourceText) {
        const latestMessage = messages.value?.[messages.value.length - 1]
        if (latestMessage && latestMessage.role === 'assistant' && latestMessage.metadata) {
          latestMessage.metadata.ragSource = ragContext.ragSourceText
        }
      }

      // 6. Persist conversation (sanitize base64 image parts to aipg-media)
      conversations.updateConversation(messages.value, conversations.activeKey)

      // 7. Clear inputs
      messageInput.value = ''
      fileInput.value = []
    }

    async function stop() {
      // Set manual stop flag to immediately show as not processing
      manuallyStopped.value = true
      await chats[conversations.activeKey]?.stop()
    }

    async function regenerate(messageId: string) {
      await textInference.ensureReadyForInference()
      manuallyStopped.value = false
      await chats[conversations.activeKey]?.regenerate({ messageId })
      conversations.updateConversation(messages.value, conversations.activeKey)
    }

    async function removeMessage(messageId: string) {
      const chat = chats[conversations.activeKey]
      if (!chat) return
      const indexOfAssistantMeessage = chat.messages.findIndex((m) => m.id === messageId)
      console.log('removeMessage', { messageId, indexOfAssistantMeessage, messages: chat.messages })
      if (indexOfAssistantMeessage > 0) {
        chat.messages.splice(indexOfAssistantMeessage - 1, 2)
      } else {
        chat.messages.splice(indexOfAssistantMeessage, 1)
      }
      conversations.updateConversation(chat.messages, conversations.activeKey)
    }

    const error = computed(() => chats[conversations.activeKey]?.error?.message)

    return {
      chat: chats[conversations.activeKey],
      messages,
      contextUsage,
      usedTokens,
      messageInput,
      fileInput,
      generate,
      stop,
      processing,
      removeMessage,
      regenerate,
      error,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: [],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useOpenAiCompatibleChat, import.meta.hot))
}
