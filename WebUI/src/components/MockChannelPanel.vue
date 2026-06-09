<template>
  <div v-if="homeAgent.showMockPanel" class="fixed top-12 right-4 z-9999 font-mono text-xs">
    <div
      class="w-96 max-h-[70vh] flex flex-col rounded-lg border border-border bg-background/95 shadow-2xl backdrop-blur"
    >
      <div class="flex items-center justify-between px-3 py-2 border-b border-border/40">
        <span class="font-bold">Home Agent mock channel</span>
        <div class="flex items-center gap-2">
          <span :class="homeAgent.channels.mock?.active ? 'text-green-500' : 'text-red-500'">
            {{ homeAgent.channels.mock?.active ? 'active' : 'inactive' }}
          </span>
          <button
            class="text-muted-foreground hover:text-foreground"
            title="Close"
            @click="homeAgent.showMockPanel = false"
          >
            <XMarkIcon class="w-4 h-4" />
          </button>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto p-2 space-y-1">
        <p v-if="outbox.length === 0" class="text-muted-foreground italic">No captured output yet.</p>
        <div
          v-for="(ev, idx) in outbox"
          :key="idx"
          class="rounded border border-border/30 px-2 py-1"
        >
          <div class="text-[10px] uppercase text-muted-foreground">{{ ev.kind }}</div>
          <div v-if="ev.text" class="whitespace-pre-wrap wrap-break-word">{{ ev.text }}</div>
          <div v-if="ev.caption" class="whitespace-pre-wrap wrap-break-word italic">
            {{ ev.caption }}
          </div>
          <div v-if="ev.filename" class="text-muted-foreground">file: {{ ev.filename }}</div>
          <div v-if="ev.base64" class="text-muted-foreground">
            [{{ ev.mime ?? 'binary' }}, {{ ev.base64.length }} b64 chars]
          </div>
          <div v-if="ev.buttons" class="text-muted-foreground">
            keyboard: {{ ev.buttons.flat().map((b) => b.text).join(' | ') }}
          </div>
        </div>
      </div>

      <div class="border-t border-border/40 p-2 space-y-2">
        <textarea
          v-model="draft"
          rows="2"
          placeholder="Message to inject (try /help, /imgGen, or a chat prompt)…"
          class="w-full resize-none rounded border border-border bg-input px-2 py-1 text-foreground"
          @keydown.enter.exact.prevent="send"
        />
        <div class="flex gap-2">
          <button
            class="flex-1 rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50"
            :disabled="busy || !draft.trim()"
            @click="send"
          >
            {{ busy ? 'Sending…' : 'Send' }}
          </button>
          <button class="rounded border border-border px-2 py-1" @click="homeAgent.mockClear()">
            Clear
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { XMarkIcon } from '@heroicons/vue/24/solid'
import { useHomeAgent } from '@/assets/js/store/homeAgent'

const homeAgent = useHomeAgent()
const draft = ref('')
const busy = ref(false)

const outbox = homeAgent.mockOutbox

async function send() {
  const text = draft.value.trim()
  if (!text || busy.value) return
  busy.value = true
  try {
    await homeAgent.mockSend(text)
    draft.value = ''
  } finally {
    busy.value = false
  }
}
</script>
