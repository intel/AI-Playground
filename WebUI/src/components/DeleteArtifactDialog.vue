<template>
  <AlertDialog :open="open" @update:open="(value) => emit('update:open', value)">
    <AlertDialogContent @click.stop>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ languages.ARTIFACT_DELETE_TITLE }}</AlertDialogTitle>
        <AlertDialogDescription>{{ languages.ARTIFACT_DELETE_BODY }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel @click.stop>{{ languages.COM_CANCEL }}</AlertDialogCancel>
        <AlertDialogAction @click.stop="emit('confirm')">
          {{ languages.COM_DELETE }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

defineProps<{ open: boolean }>()

const emit = defineEmits<{
  'update:open': [open: boolean]
  confirm: []
}>()

const languages = useI18N().state
</script>
