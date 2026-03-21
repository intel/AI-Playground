<script setup lang="ts">
import { base64ToString } from 'uint8array-extras'
import { parse } from '@/assets/js/markdownParser'
import { sanitizeMarkdown } from '@/lib/sanitize'

const props = defineProps<{
  content: string
  onCopy?: (text: string) => void
}>()

const root = ref<HTMLElement | null>(null)

const renderedHtml = computed(() => sanitizeMarkdown(parse(props.content) as string))

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
  () => {
    nextTick(attachCopyHandlers)
  },
  { immediate: true },
)

onMounted(attachCopyHandlers)
</script>

<template>
  <div ref="root" v-html="renderedHtml"></div>
</template>
