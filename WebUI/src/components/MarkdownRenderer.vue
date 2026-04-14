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

      renderedHtml.value = sanitizeMarkdown(parse(nextContent) as string)
      nextTick(attachCopyHandlers)

      if (pendingContent !== null) {
        const sixtyFpsMax = new Promise((resolve) => setTimeout(resolve, 16))
        const animationFrameMax = new Promise((resolve) => requestAnimationFrame(resolve))
        await Promise.all([sixtyFpsMax, animationFrameMax])
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
  },
  { immediate: true },
)

onMounted(attachCopyHandlers)
</script>

<template>
  <div ref="root" v-html="renderedHtml"></div>
</template>
