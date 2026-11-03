<template>
  <div
    v-if="sessionSettings.holdsActivePreset"
    class="border-t border-border pt-4 flex flex-wrap items-center gap-2"
  >
    <Button variant="secondary" class="px-3 py-1.5 rounded text-sm" @click="saveAsDefault">
      {{ languages.AGENT_SAVE_AS_DEFAULT }}
    </Button>
    <Button variant="secondary" class="px-3 py-1.5 rounded text-sm" @click="resetToDefault">
      {{ languages.AGENT_RESET_TO_DEFAULT }}
    </Button>
  </div>
  <slot v-else />
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import { useSessionSettings } from '@/assets/js/store/sessionSettings'
import { Button } from '@/components/ui/button'
import * as toast from '@/assets/js/toast'

const emit = defineEmits<{ reset: [] }>()

const languages = useI18N().state
const sessionSettings = useSessionSettings()

function saveAsDefault() {
  if (sessionSettings.saveAsDefault()) toast.success(languages.SESSION_SETTINGS_SAVED_AS_DEFAULT)
}

function resetToDefault() {
  if (!sessionSettings.resetToDefault()) return
  emit('reset')
  toast.success(languages.AGENT_RESET_TO_DEFAULT_DONE)
}
</script>
