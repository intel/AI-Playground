<template>
  <drop-down-new
    :items="languageItems"
    :value="i18n.langName"
    @change="(value) => i18n.changeLanguage({ value }, 0)"
  />
</template>

<script setup lang="ts">
import DropDownNew from '../components/DropDownNew.vue'
import { useI18N } from '@/assets/js/store/i18n'

const i18n = useI18N()

const languageItems = computed(() =>
  i18n.languageOptions.map((lang) => ({
    label: lang.name,
    value: lang.value,
    active: true,
  })),
)
</script>
