<template>
  <drop-selector :array="i18n.languageOptions" @change="i18n.changeLanguage">
    <template #selected>
      <div class="flex gap-2 items-center">
        <span class="rounded-full bg-green-500 w-2 h-2"></span>
        <span>{{ i18n.currentLanguageName }}</span>
      </div>
    </template>
    <template #list="slotItem">
      <div class="flex gap-2 items-center">
        <span class="rounded-full bg-green-500 w-2 h-2"></span>
        <span>{{ slotItem.item.name }}</span>
      </div>
    </template>
  </drop-selector>
</template>

<script setup lang="ts">
import DropSelector from '../components/DropSelector.vue'
import { useI18N } from '@/assets/js/store/i18n'
const i18n = useI18N()
</script>
