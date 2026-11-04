<template>
  <div class="border-t border-border pt-4 flex flex-wrap items-center gap-2">
    <Button variant="secondary" class="px-3 py-1.5 rounded text-sm gap-1.5" @click="onClick">
      <ArrowPathIcon class="size-4" />
      {{ named(label ?? languages.SESSION_SETTINGS_RESET_TO_DEFAULT_NAMED) }}
    </Button>
  </div>
</template>

<script setup lang="ts">
import { ArrowPathIcon } from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import { usePresets } from '@/assets/js/store/presets'
import { Button } from '@/components/ui/button'
import * as toast from '@/assets/js/toast'

const props = defineProps<{
  /** Restores the preset's settings; returning `false` means there was nothing to reset. */
  reset: () => boolean | void
  presetName?: string
  /** A `{preset}` template; defaults to "Reset {preset} to default". */
  label?: string
}>()

const languages = useI18N().state
const presets = usePresets()
const oemBranding = useOemBranding()

function named(template: string) {
  return template.replace(
    '{preset}',
    oemBranding.presetLabel(props.presetName ?? presets.activePresetName ?? ''),
  )
}

function onClick() {
  if (props.reset() === false) return
  toast.success(named(languages.PRESET_RESET_DONE))
}
</script>
