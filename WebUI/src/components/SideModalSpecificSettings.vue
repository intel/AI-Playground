<template>
  <SideModalBase
    id="advanced-settings-sidebar"
    :is-visible="isVisible"
    :title="
      i18nState.COM_MODE_SETTINGS
        ? i18nState.COM_MODE_SETTINGS.replace('{mode}', mapModeToLabel(mode))
        : `${mapModeToLabel(mode)} Settings`
    "
    side="right"
    @close="$emit('close')"
  >
    <SettingsChat v-show="props.mode == 'chat'" />
    <SettingsWorkflow
      v-show="props.mode == 'imageGen'"
      :categories="['create-images']"
      :title="
        i18nState.COM_MODE_PRESETS
          ? i18nState.COM_MODE_PRESETS.replace('{mode}', mapModeToLabel(mode))
          : `${mapModeToLabel(mode)} Presets`
      "
    />
    <SettingsWorkflow
      v-show="props.mode == 'imageEdit'"
      :categories="['edit-images']"
      :title="
        i18nState.COM_MODE_PRESETS
          ? i18nState.COM_MODE_PRESETS.replace('{mode}', mapModeToLabel(mode))
          : `${mapModeToLabel(mode)} Presets`
      "
    />
    <SettingsWorkflow
      v-show="props.mode == 'video'"
      :categories="['create-videos']"
      :title="
        i18nState.COM_MODE_PRESETS
          ? i18nState.COM_MODE_PRESETS.replace('{mode}', mapModeToLabel(mode))
          : `${mapModeToLabel(mode)} Presets`
      "
    />
  </SideModalBase>
</template>

<script setup lang="ts">
import SideModalBase from '@/components/SideModalBase.vue'
import SettingsChat from '@/components/SettingsChat.vue'
import SettingsWorkflow from '@/components/SettingsWorkflow.vue'
import { mapModeToLabel } from '@/lib/utils.ts'
import { useI18N } from '@/assets/js/store/i18n.ts'

const props = defineProps<{
  mode: ModeType
  isVisible: boolean
}>()

defineEmits<{
  close: []
}>()

const i18nState = useI18N().state
</script>
