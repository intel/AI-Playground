<script setup lang="ts">
import { base64ToString } from 'uint8array-extras'
import { parse } from '@/assets/js/markdownParser'
import { sanitizeMarkdown } from '@/lib/sanitize'

const props = defineProps<{
  content: string
  onCopy?: (text: string) => void
}>()

const root = ref<HTMLElement | null>(null)
const renderedHtml = ref('')

const instanceId = crypto.randomUUID().slice(0, 3)

let pendingContent: string | null = null
let isProcessing = false

/**
 * Queues markdown for processing with coalescing support.
 * Only processes the latest markdown when multiple updates arrive quickly.
 * Uses requestAnimationFrame to yield to browser paint between batches.
 */
async function updateRenderedContent(content: string) {
  pendingContent = content

  if (isProcessing) {
    return
  }

  isProcessing = true

  try {
    while (pendingContent !== null) {
      const nextContent = pendingContent
      pendingContent = null

      const renderId = crypto.randomUUID().slice(0, 3)
      console.log(`${instanceId}: start-${renderId}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
      const start = performance.now()
      renderedHtml.value = sanitizeMarkdown(parse(nextContent) as string)
      const duration = performance.now() - start
      console.log(`${instanceId}: stop-${renderId} ${duration.toFixed(1)}ms`)

      if (pendingContent !== null) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
    }
  } catch (error) {
    console.error('Failed to process markdown:', error)
    renderedHtml.value = content.replace(/\n/g, '<br>')
  } finally {
    isProcessing = false
  }
}

function copyCode(e: MouseEvent) {
  if (!(e.target instanceof HTMLElement)) return
  if (!e.target?.dataset?.code) return
  props.onCopy?.(base64ToString(e.target?.dataset?.code))
}

function attachCopyHandlers() {
  if (!root.value) return
  root.value.querySelectorAll('.copy-code').forEach((item) => {
    const el = item as HTMLElement
    el.classList.remove('hidden')
    el.removeEventListener('click', copyCode)
    el.addEventListener('click', copyCode)
  })
}

watch(
  () => props.content,
  (newContent) => {
    updateRenderedContent(newContent)
    nextTick(attachCopyHandlers)
  },
  { immediate: true },
)

onMounted(attachCopyHandlers)
</script>

<template>
  <div ref="root" v-html="renderedHtml"></div>
</template>
