<template>
  <drop-down-new
    title="Select Provider"
    @change="handleProviderChange"
    :value="cloudMode.selectedProviderId"
    :items="items"
  ></drop-down-new>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import DropDownNew from './DropDownNew.vue'
import { useCloudMode } from '@/assets/js/store/cloudMode'

const cloudMode = useCloudMode()

// Switching provider re-fetches that provider's model list (overwriting it on
// success), so the model picker reflects what the newly-selected provider serves.
function handleProviderChange(id: string) {
  cloudMode.selectProvider(id)
  cloudMode.refreshSelectedProviderModels()
}

const items = computed(() =>
  cloudMode.providers.map((p) => ({
    label: p.name,
    value: p.id,
    // A provider is "ready" once it has a base URL configured.
    active: !!p.baseUrl.trim(),
  })),
)
</script>
