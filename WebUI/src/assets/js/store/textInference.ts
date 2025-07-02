import { acceptHMRUpdate, defineStore } from 'pinia'
import { z } from 'zod'
import { useBackendServices } from './backendServices'
import { useModels } from './models'
import * as Const from '@/assets/js/const'
import { Document } from 'langchain/document'

export const llmBackendTypes = ['openVINO', 'ipexLLM', 'llamaCPP', 'ollama'] as const

const LlmBackendSchema = z.enum(llmBackendTypes)
export type LlmBackend = z.infer<typeof LlmBackendSchema>
type LlmBackendKV = { [key in LlmBackend]: string | null }

export const backendToService = {
  ipexLLM: 'ai-backend',
  llamaCPP: 'llamacpp-backend',
  openVINO: 'openvino-backend',
  ollama: 'ollama-backend',
} as const

export type LlmModel = {
  name: string
  type: LlmBackend
  active: boolean
  downloaded: boolean
}

export type ValidFileExtension = 'txt' | 'doc' | 'docx' | 'md' | 'pdf'

export type IndexedDocument = {
  filename: string
  filepath: string
  type: ValidFileExtension
  splitDB: Document[]
  hash: string
  isChecked: boolean
}

export type EmbedInquiry = {
  prompt: string
  ragList: IndexedDocument[]
  backendBaseUrl: string
  embeddingModel: string
  maxResults?: number
}

// Thinking model markers for different models
export const thinkingModels: Record<string, string> = {
  'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B': '</think>\n\n',
  'deepseek-ai/DeepSeek-R1-Distill-Qwen-14B': '</think>\n\n',
  'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B': '</think>\n\n',
  'OpenVINO/DeepSeek-R1-Distill-Qwen-1.5B-int4-ov': '</think>\n\n',
  'OpenVINO/DeepSeek-R1-Distill-Qwen-7B-int4-ov': '</think>\n\n',
  'OpenVINO/DeepSeek-R1-Distill-Qwen-14B-int4-ov': '</think>\n\n',
}

// A friendly display name for each backend
export const textInferenceBackendDisplayName: Record<LlmBackend, string> = {
  ipexLLM: 'IPEX-LLM',
  llamaCPP: 'llamaCPP - GGUF',
  openVINO: 'OpenVINO',
  ollama: 'Ollama',
}

export const useTextInference = defineStore(
  'textInference',
  () => {
    const backendServices = useBackendServices()
    const models = useModels()
    const backend = ref<LlmBackend>('openVINO')
    const ragList = ref<IndexedDocument[]>([])

    const selectedModels = ref<LlmBackendKV>({
      ipexLLM: null,
      llamaCPP: null,
      openVINO: null,
      ollama: null,
    })

    const selectedEmbeddingModels = ref<LlmBackendKV>({
      ipexLLM: null,
      llamaCPP: null,
      openVINO: null,
      ollama: null,
    })

    const llmModels: Ref<LlmModel[]> = computed(() => {
      const llmTypeModels = models.models.filter((m) =>
        ['ipexLLM', 'llamaCPP', 'openVINO'].includes(m.type),
      )
      const newModels = llmTypeModels.map((m) => {
        const selectedModelForType = selectedModels.value[m.type as LlmBackend]
        return {
          name: m.name,
          type: m.type as LlmBackend,
          downloaded: m.downloaded,
          active:
            m.name === selectedModelForType ||
            (!llmTypeModels.some((m) => m.name === selectedModelForType) && m.default),
        }
      })
      
      // Add Ollama models
      if (backend.value === 'ollama') {
        newModels.push({
          name: 'ollama-default',
          type: 'ollama',
          downloaded: true,
          active: true,
        })
      }
      
      console.log('llmModels changed', newModels)
      return newModels
    })

    const llmEmbeddingModels: Ref<LlmModel[]> = computed(() => {
      const llmEmbeddingTypeModels = models.models.filter((m) => m.type === 'embedding')
      console.log('llmEmbeddingTypeModels', llmEmbeddingTypeModels)
      const newEmbeddingModels = llmEmbeddingTypeModels.map((m) => {
        const selectedEmbeddingModelForType = selectedEmbeddingModels.value[m.backend as LlmBackend]
        return {
          name: m.name,
          type: m.backend as LlmBackend,
          downloaded: m.downloaded,
          active:
            m.name === selectedEmbeddingModelForType ||
            (!llmEmbeddingTypeModels.some((m) => m.name === selectedEmbeddingModelForType) &&
              m.default),
        }
      })
      
      // Add Ollama embedding models
      if (backend.value === 'ollama') {
        newEmbeddingModels.push({
          name: 'ollama-embedding',
          type: 'ollama',
          downloaded: true,
          active: true,
        })
      }
      
      console.log('llmEmbeddingModels changed', newEmbeddingModels)
      return newEmbeddingModels
    })

    const runningOnOpenvinoNpu = computed(
      () =>
        !!backendServices.info
          .find((s) => s.serviceName === backendToService[backend.value])
          ?.devices.find((d) => d.selected)
          ?.id.includes('NPU'),
    )

    const selectModel = (backend: LlmBackend, modelName: string) => {
      selectedModels.value[backend] = modelName
    }

    const selectEmbeddingModel = (backend: LlmBackend, modelName: string) => {
      selectedEmbeddingModels.value[backend] = modelName
    }

    const backendToAipgBackendName = {
      openVINO: 'openvino',
      ipexLLM: 'default',
      llamaCPP: 'llama_cpp',
      ollama: 'ollama',
    } as const

    const backendToAipgModelTypeNumber = {
      openVINO: Const.MODEL_TYPE_OPENVINO,
      ipexLLM: Const.MODEL_TYPE_LLM,
      llamaCPP: Const.MODEL_TYPE_LLAMA_CPP,
      ollama: Const.MODEL_TYPE_LLM, // Using LLM type for Ollama
    } as const

    const activeModel: Ref<string | undefined> = computed(() => {
      const newActiveModel = llmModels.value
        .filter((m) => m.type === backend.value)
        .find((m) => m.active)?.name
      console.log('activeModel changed', newActiveModel)
      return newActiveModel
    })
    const activeEmbeddingModel: Ref<string | undefined> = computed(() => {
      const newActiveEmbeddingModel = llmEmbeddingModels.value
        .filter((m) => m.type === backend.value)
        .find((m) => m.active)?.name
      console.log(llmEmbeddingModels)
      console.log('activeEmbeddingModel changed', newActiveEmbeddingModel)
      return newActiveEmbeddingModel
    })
    const metricsEnabled = ref(false)
    const maxTokens = ref<number>(1024)

    const currentBackendUrl = computed(
      () =>
        backendServices.info.find((item) => item.serviceName === backendToService[backend.value])
          ?.baseUrl,
    )

    async function getDownloadParamsForCurrentModelIfRequired(type: 'llm' | 'embedding') {
      // For Ollama backend, we don't need to download models from a repository
      if (backend.value === 'ollama') {
        return []
      }
      
      let model: string | undefined
      if (type === 'llm') {
        model = activeModel.value
      } else {
        model = activeEmbeddingModel.value
      }
      if (!model) return []
      
      const checkList = {
        repo_id: model,
        type:
          type === 'embedding'
            ? Const.MODEL_TYPE_EMBEDDING
            : backendToAipgModelTypeNumber[backend.value],
        backend: backendToAipgBackendName[backend.value],
      }
      const checkedModels = await models.checkModelAlreadyLoaded([checkList])
      const notYetDownloaded = checkedModels.filter((m) => !m.already_loaded)
      return notYetDownloaded
    }

    function toggleMetrics() {
      metricsEnabled.value = !metricsEnabled.value
    }

    const fontSizeIndex = ref<number>(1)
    const fontSizes = [
      'text-xs',
      'text-sm',
      'text-base',
      'text-lg',
      'text-xl',
      'text-2xl',
      'text-3xl',
      'text-4xl',
      'text-5xl',
      'text-6xl',
      'text-7xl',
      'text-8xl',
      'text-9xl',
    ]
    const iconSizes = [
      'size-[40px]',
      'size-[42px]',
      'size-[44px]',
      'size-[46px]',
      'size-[48px]',
      'size-[50px]',
      'size-[52px]',
      'size-[54px]',
      'size-[56px]',
      'size-[58px]',
      'size-[60px]',
      'size-[62px]',
      'size-[64px]',
    ]

    const fontSizeClass = computed(() => fontSizes[fontSizeIndex.value])
    const nameSizeClass = computed(() => fontSizes[Math.max(fontSizeIndex.value - 2, 0)])
    const iconSizeClass = computed(() => iconSizes[fontSizeIndex.value])
    const isMaxSize = computed(() => fontSizeIndex.value >= fontSizes.length - 1)
    const isMinSize = computed(() => fontSizeIndex.value <= 0)

    function increaseFontSize() {
      if (!isMaxSize.value) {
        fontSizeIndex.value++
      }
    }
    function decreaseFontSize() {
      if (!isMinSize.value) {
        fontSizeIndex.value--
      }
    }

    async function addDocumentToRagList(document: IndexedDocument) {
      const langchainDocument: IndexedDocument =
        await window.electronAPI.addDocumentToRAGList(document)
      console.log(langchainDocument)
      if (ragList.value.some((item) => item.hash === langchainDocument.hash)) {
        console.log('Document already in list')
        return
      }
      ragList.value.push(langchainDocument)
    }

    async function embedInputUsingRag(prompt: string) {
      const checkedRagList = ragList.value
        .filter((item) => item.isChecked)
        .map((doc) => JSON.parse(JSON.stringify(doc)))
      if (checkedRagList.length === 0) {
        throw new Error('No documents selected')
      }
      if (!currentBackendUrl.value) {
        throw new Error('Backend service not found')
      }
      if (!activeEmbeddingModel.value) {
        throw new Error('No embedding model selected')
      }
      const newEmbedInquiry: EmbedInquiry = {
        prompt: prompt,
        ragList: checkedRagList,
        backendBaseUrl: currentBackendUrl.value,
        embeddingModel: activeEmbeddingModel.value,
        maxResults: runningOnOpenvinoNpu.value ? 2 : 8,
      }
      console.log('trying to request rag for', { newEmbedInquiry, ragList: ragList.value })
      const response = await window.electronAPI.embedInputUsingRag(newEmbedInquiry)
      return response
    }

    function updateFileCheckStatus(hash: string, isChecked: boolean) {
      const index = ragList.value.findIndex((item) => item.hash === hash)
      if (index !== -1) {
        ragList.value[index].isChecked = isChecked
      }
    }

    function deleteFile(hash: string) {
      const index = ragList.value.findIndex((item) => item.hash === hash)
      if (index !== -1) {
        ragList.value.splice(index, 1)
      }
    }

    function checkAllFiles() {
      ragList.value.forEach((item) => (item.isChecked = true))
    }

    function uncheckAllFiles() {
      ragList.value.forEach((item) => (item.isChecked = false))
    }

    function deleteAllFiles() {
      ragList.value.length = 0
    }
    
    // Extract the thinking text from the model's output
    function extractPreMarker(fullAnswer: string, model?: string): string {
      const modelName = model || activeModel.value
      if (modelName && thinkingModels[modelName]) {
        const marker = thinkingModels[modelName]
        const idx = fullAnswer.indexOf(marker)
        return idx === -1 ? fullAnswer : fullAnswer.slice(0, idx)
      }
      return fullAnswer
    }

    // Extract the final response after the thinking marker
    function extractPostMarker(fullAnswer: string, model?: string): string {
      const modelName = model || activeModel.value
      if (modelName && thinkingModels[modelName]) {
        const marker = thinkingModels[modelName]
        const idx = fullAnswer.indexOf(marker)
        return idx === -1 ? '' : fullAnswer.slice(idx + marker.length)
      }
      return ''
    }
    
    // Define a type for document location information
    type DocumentLocation = {
      pageNumber?: number;
      lines?: { 
        from?: number; 
        to?: number 
      };
    };
    
    // Format RAG sources for display
    function formatRagSources(documents: Document[] | { metadata?: { source?: string; loc?: DocumentLocation } }[]): string {
      // Group documents by source file
      const fileGroups = new Map<
        string,
        Array<{
          lines?: { from: number; to: number }
          page?: number
        }>
      >()
      const unknownSources: string[] = []

      // Process each document
      documents.forEach((doc) => {
        const source = doc.metadata?.source
        const location = doc.metadata?.loc

        // Handle unknown sources
        if (!source) {
          unknownSources.push('Unknown Source')
          return
        }

        // Get or create array for this file
        const entries = fileGroups.get(source) || []

        // Create entry with available location information
        const entry: { lines?: { from: number; to: number }; page?: number } = {}

        // Add line information if available
        if (location?.lines?.from && location?.lines?.to) {
          entry.lines = {
            from: location.lines.from,
            to: location.lines.to,
          }
        }

        // Add page information if available
        if (location?.pageNumber !== undefined) {
          entry.page = location.pageNumber
        }

        // Only add entry if it has some location information
        if (Object.keys(entry).length > 0) {
          entries.push(entry)
          fileGroups.set(source, entries)
        }
      })

      // Function to merge overlapping line ranges for the same page
      const mergeRanges = (
        entries: Array<{ lines?: { from: number; to: number }; page?: number }>,
      ): Array<{ lines?: { from: number; to: number }; page?: number }> => {
        if (entries.length <= 1) return entries

        // Group entries by page number
        const pageGroups = new Map<
          number | undefined,
          Array<{ lines?: { from: number; to: number }; page?: number }>
        >()

        entries.forEach((entry) => {
          const pageKey = entry.page
          const pageEntries = pageGroups.get(pageKey) || []
          pageEntries.push(entry)
          pageGroups.set(pageKey, pageEntries)
        })

        const result: Array<{ lines?: { from: number; to: number }; page?: number }> = []

        // Process each page group
        pageGroups.forEach((pageEntries, pageNumber) => {
          // For entries with line information, merge overlapping ranges
          const entriesWithLines = pageEntries.filter((e) => e.lines)

          if (entriesWithLines.length > 0) {
            // Sort by starting line
            const sortedEntries = [...entriesWithLines].sort(
              (a, b) => (a.lines?.from || 0) - (b.lines?.from || 0),
            )

            let current = sortedEntries[0]

            // Merge overlapping line ranges
            for (let i = 1; i < sortedEntries.length; i++) {
              const next = sortedEntries[i]

              // Check if ranges overlap or are adjacent
              if ((current.lines?.to || 0) >= (next.lines?.from || 0) - 1) {
                // Merge ranges
                current = {
                  lines: {
                    from: current.lines?.from || 0,
                    to: Math.max(current.lines?.to || 0, next.lines?.to || 0),
                  },
                  page: pageNumber,
                }
              } else {
                // No overlap, add current to result and move to next
                result.push(current)
                current = next
              }
            }

            // Add the last range
            result.push(current)
          }

          // For entries with only page information (no lines), add a single entry per page
          if (pageEntries.some((e) => !e.lines)) {
            // If we haven't already added an entry for this page from the line merging
            if (!result.some((r) => r.page === pageNumber && !r.lines)) {
              result.push({ page: pageNumber })
            }
          }
        })

        return result
      }

      // Format results
      const formattedResults: string[] = []

      // Process each file group
      fileGroups.forEach((entries, source) => {
        const filename = source.split(/[\/\\]/).pop() || source
        const mergedEntries = mergeRanges(entries)

        // Format each merged entry
        mergedEntries.forEach((entry) => {
          let locationInfo = ''

          // Format based on available information
          if (entry.page !== undefined && entry.lines) {
            // Both page and line information
            locationInfo = `Page ${entry.page}, Lines ${entry.lines.from}-${entry.lines.to}`
          } else if (entry.page !== undefined) {
            // Only page information
            locationInfo = `Page ${entry.page}`
          } else if (entry.lines) {
            // Only line information
            locationInfo = `Lines ${entry.lines.from}-${entry.lines.to}`
          }

          formattedResults.push(`${filename} (${locationInfo})`)
        })
      })

      // Add unknown sources
      formattedResults.push(...unknownSources)

      return formattedResults.join('\n')
    }

    async function ensureBackendReadiness(): Promise<void> {
      if (backend.value === 'llamaCPP') {
        const serviceName = backendToService[backend.value]
        const llmModelName = activeModel.value
        const embeddingModelName = activeEmbeddingModel.value
        
        if (!llmModelName) {
          throw new Error('No active LLM model selected')
        }
        
        const ragDocumentsSelected = ragList.value.some(doc => doc.isChecked)
        const embeddingModelToSend = ragDocumentsSelected ? embeddingModelName : undefined
        
        if (ragDocumentsSelected && !embeddingModelName) {
          throw new Error('No embedding model selected but RAG documents are enabled')
        }
        
        await backendServices.ensureBackendReadiness(serviceName, llmModelName, embeddingModelToSend)
      }
    }

    return {
      backend,
      activeModel,
      selectedModels,
      llmModels,
      llmEmbeddingModels,
      currentBackendUrl,
      metricsEnabled,
      maxTokens,
      fontSizeClass,
      nameSizeClass,
      iconSizeClass,
      isMaxSize,
      isMinSize,
      ragList,
      selectModel,
      selectEmbeddingModel,
      getDownloadParamsForCurrentModelIfRequired,
      toggleMetrics,
      increaseFontSize,
      decreaseFontSize,
      addDocumentToRagList,
      embedInputUsingRag,
      updateFileCheckStatus,
      deleteFile,
      checkAllFiles,
      uncheckAllFiles,
      deleteAllFiles,
      extractPreMarker,
      extractPostMarker,
      formatRagSources,
      ensureBackendReadiness,
    }
  },
  {
    persist: {
      pick: ['backend', 'selectedModels', 'maxTokens', 'ragList'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTextInference, import.meta.hot))
}
