<template>
  <div class="dialog-container z-10">
    <div
      class="dialog-mask absolute left-0 top-0 w-full h-full bg-background/55 flex justify-center items-center"
    >
      <div
        class="py-10 px-20 w-600px flex flex-col items-center justify-center bg-card rounded-3xl gap-6 text-foreground"
        :class="{ 'animate-scale-in': animate }"
      >
        <h2 class="text-xl font-semibold text-center">
          {{ i18nState.PRESET_REQUIREMENTS_TITLE || 'Preset Requirements' }}
        </h2>
        <p class="text-center text-muted-foreground">
          {{
            i18nState.PRESET_REQUIREMENTS_MESSAGE ||
            'In order to use this preset we need to install some additional components:'
          }}
        </p>

        <div class="w-full flex flex-col gap-4 max-h-96 overflow-y-auto">
          <!-- Models Section -->
          <div v-if="requirementsData.missingModels.length > 0" class="flex flex-col gap-2">
            <h3 class="font-semibold">{{ i18nState.PRESET_REQUIREMENTS_MODELS || 'Models:' }}</h3>
            <ul class="list-disc list-inside ml-4 space-y-1">
              <li v-for="model in requirementsData.missingModels" :key="model.name">
                {{ model.name }}
                <span v-if="model.type" class="text-muted-foreground text-sm"
                  >({{ model.type }})</span
                >
              </li>
            </ul>
          </div>

          <!-- ComfyUI Custom Nodes Section -->
          <div v-if="requirementsData.missingCustomNodes.length > 0" class="flex flex-col gap-2">
            <h3 class="font-semibold">
              {{ i18nState.PRESET_REQUIREMENTS_CUSTOM_NODES || 'ComfyUI custom_nodes:' }}
            </h3>
            <ul class="list-disc list-inside ml-4 space-y-1">
              <li v-for="node in requirementsData.missingCustomNodes" :key="node">
                {{ formatCustomNodeName(node) }}
              </li>
            </ul>
          </div>

          <!-- Python Packages Section -->
          <div v-if="requirementsData.missingPythonPackages.length > 0" class="flex flex-col gap-2">
            <h3 class="font-semibold">
              {{ i18nState.PRESET_REQUIREMENTS_PYTHON_PACKAGES || 'Python Packages:' }}
            </h3>
            <ul class="list-disc list-inside ml-4 space-y-1">
              <li v-for="pkg in requirementsData.missingPythonPackages" :key="pkg">
                {{ pkg }}
              </li>
            </ul>
          </div>
        </div>

        <p class="text-center text-muted-foreground">
          {{ i18nState.PRESET_REQUIREMENTS_INSTALL_PROMPT || 'Do you want to install them now?' }}
        </p>

        <div class="flex justify-center items-center gap-9">
          <button @click="cancelConfirm" class="bg-muted text-foreground py-1 px-4 rounded">
            {{ i18nState.COM_CANCEL }}
          </button>
          <button @click="confirmInstall" class="bg-primary text-foreground py-1 px-4 rounded">
            {{ i18nState.PRESET_REQUIREMENTS_INSTALL || 'Install' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useI18N } from '@/assets/js/store/i18n.ts'
import { useDialogStore } from '@/assets/js/store/dialogs.ts'
import { storeToRefs } from 'pinia'

const i18nState = useI18N().state
const dialogStore = useDialogStore()
const animate = ref(false)

const { presetRequirementsData, presetRequirementsDialogVisible } = storeToRefs(dialogStore)

const requirementsData = computed(() => {
  return (
    presetRequirementsData.value || {
      missingModels: [],
      missingCustomNodes: [],
      missingPythonPackages: [],
    }
  )
})

watch(presetRequirementsDialogVisible, (newValue) => {
  if (newValue) {
    animate.value = false
    nextTick(() => {
      animate.value = true
    })
  } else {
    animate.value = false
  }
})

function formatCustomNodeName(nodeString: string): string {
  // Format: "username/repoName@gitRef" or "username/repoName"
  const parts = nodeString.split('@')
  const repoPart = parts[0]
  const gitRef = parts[1]

  if (gitRef) {
    return `${repoPart} (${gitRef})`
  }
  return repoPart
}

function confirmInstall() {
  dialogStore.presetRequirementsConfirmFunction?.()
  dialogStore.closePresetRequirementsDialog()
}

function cancelConfirm() {
  dialogStore.closePresetRequirementsDialog()
}
</script>
