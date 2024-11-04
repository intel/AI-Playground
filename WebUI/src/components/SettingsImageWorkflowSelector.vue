<template>
    <div class="items-center flex-wrap grid grid-cols-1 gap-2">
        <div class="flex flex-col gap-2">
            <p>{{ "Backend" }}</p>
            <div class="grid grid-cols-2 items-center gap-2 flex-wrap">
                <radio-bolck :checked="imageGeneration.backend === 'default'"
                    :text="'Default'"
                    @click="() => { imageGeneration.backend = 'default' }"></radio-bolck>
                <radio-bolck :checked="imageGeneration.backend === 'comfyui'"
                    :text="'ComfyUI'"
                    @click="() => { imageGeneration.backend = 'comfyui' }"></radio-bolck>
            </div>
        </div>
        <div v-if="imageGeneration.backend === 'default'" class="flex flex-col gap-2">
            <p>{{ languages.SETTINGS_MODEL_IMAGE_RESOLUTION }}</p>
            <div class="grid grid-cols-3 items-center gap-2 flex-wrap">
                <radio-bolck :checked="classicModel === 'sd1.5'"
                    :text="languages.SETTINGS_MODEL_IMAGE_RESOLUTION_STRANDARD"
                    @click="() => { classicModel = 'sd1.5' }"></radio-bolck>
                <radio-bolck :checked="classicModel === 'sdxl'"
                    :text="languages.SETTINGS_MODEL_IMAGE_RESOLUTION_HD"
                    @click="() => { classicModel = 'sdxl' }"></radio-bolck>
                <radio-bolck :checked="classicModel === 'manual'"
                    :text="languages.SETTINGS_MODEL_QUALITY_MANUAL"
                    @click="() => { classicModel = 'manual' }"></radio-bolck>
            </div>
        </div>
        <div v-if="imageGeneration.backend === 'default'" class="flex flex-col gap-2">
            <p>{{ languages.SETTINGS_MODEL_QUALITY }}</p>
            <div class="grid grid-cols-3 items-center gap-2 flex-wrap">
                <radio-bolck :checked="classicQuality === 'standard'"
                    :text="languages.SETTINGS_MODEL_QUALITY_STANDARD" @click="() => { classicQuality = 'standard' }"
                    :disabled="classicModel === 'manual'"></radio-bolck>
                <radio-bolck :checked="classicQuality === 'hq'" :text="languages.SETTINGS_MODEL_QUALITY_HIGH"
                    @click="() => { classicQuality = 'hq' }" :disabled="classicModel === 'manual'"></radio-bolck>
                <radio-bolck :checked="classicQuality === 'fast'" :text="languages.SETTINGS_MODEL_QUALITY_FAST"
                    @click="() => { classicQuality = 'fast' }" :disabled="classicModel === 'manual'"></radio-bolck>
            </div>
        </div>
        <div v-if="imageGeneration.backend === 'comfyui'" class="flex flex-col gap-2">
            <p>Workflow</p>
            <div class="flex gap-2 items-center">
                <drop-selector :array="imageGeneration.workflows.filter(w => w.backend === 'comfyui')" @change="(workflow) => imageGeneration.activeWorkflowName = workflow.name">
                    <template #selected>
                        <div class="flex gap-2 items-center">
                            <span class="rounded-full bg-green-500 w-2 h-2"></span>
                            <span>{{ imageGeneration.activeWorkflowName }}</span>
                            <span
                                class="rounded-lg h-4 px-1 text-xs"
                                :style="{ 'background-color': `${stringToColour(tag)}88` }"
                                v-for="tag in imageGeneration.activeWorkflow.tags">
                                {{ tag }}</span>
                        </div>
                    </template>
                    <template #list="slotItem">
                        <div class="flex gap-2 items-center">
                            <span class="rounded-full bg-green-500 w-2 h-2"></span>
                            <span>{{ slotItem.item.name }}</span>
                            <span 
                                class="rounded-lg h-4 px-1 text-xs"
                                :style="{ 'background-color': `${stringToColour(tag)}88` }"
                                v-for="tag in slotItem.item.tags"
                                >
                                {{ tag }}</span>
                        </div>
                    </template>
                </drop-selector>
                <button class="svg-icon i-refresh w-5 h-5 text-purple-500"
                    @click="imageGeneration.loadWorkflowsFromJson"></button>
            </div>
        </div>
    </div>
</template>
<script setup lang="ts">
import { useImageGeneration } from "@/assets/js/store/imageGeneration";
import DropSelector from "../components/DropSelector.vue";
import RadioBolck from "../components/RadioBlock.vue";
import { useI18N } from '@/assets/js/store/i18n';

const imageGeneration = useImageGeneration();

const i18n = useI18N();

const classicModel = computed({
        get() {
          if (imageGeneration.activeWorkflowName === 'Standard') {
            return 'sd1.5'
          }
          if (imageGeneration.activeWorkflowName === 'Manual') {
            return 'manual'
          }
          if (imageGeneration.activeWorkflowName?.includes('HD')) {
            return 'sdxl'
          }
          return 'sd1.5'
        },
        set(newValue) {
            if (newValue === 'sd1.5') {
                imageGeneration.activeWorkflowName = imageGeneration.workflows.find(w => w.tags.includes('sd1.5') && (classicQuality.value === 'standard' || w.tags.includes(classicQuality.value)))?.name ?? 'Standard'
            };
            if (newValue === 'sdxl') {
                imageGeneration.activeWorkflowName = imageGeneration.workflows.find(w => w.tags.includes('sdxl') && (classicQuality.value === 'standard' || w.tags.includes(classicQuality.value)))?.name ?? 'Standard'
            };
            if (newValue === 'manual') {
                imageGeneration.activeWorkflowName = 'Manual'
            };
        }
      })
const classicQuality = computed({
        get() {
          if (!imageGeneration.activeWorkflowName?.match(/(Standard|HD)/)) {
            return 'standard'
          }
          if (imageGeneration.activeWorkflowName?.includes('High Quality')) {
            return 'hq'
          }
          if (imageGeneration.activeWorkflowName?.includes('Fast')) {
            return 'fast'
          }
          return 'standard'
        },
        set(newValue) {
            if (newValue === 'standard') {
                imageGeneration.activeWorkflowName = imageGeneration.workflows.find(w => w.tags.includes(classicModel.value) && !w.tags.includes('hq') && !w.tags.includes('fast'))?.name ?? 'Standard'
            };
            if (newValue === 'hq') {
                imageGeneration.activeWorkflowName = imageGeneration.workflows.find(w => w.tags.includes(classicModel.value) && w.tags.includes('hq'))?.name ?? 'Standard'
            };
            if (newValue === 'fast') {
                imageGeneration.activeWorkflowName = imageGeneration.workflows.find(w => w.tags.includes(classicModel.value) && w.tags.includes('fast'))?.name ?? 'Standard'
            };
        }
      })

const stringToColour = (str: string) => {
  let hash = 0;
  str.split('').forEach(char => {
    hash = char.charCodeAt(0) + ((hash << 5) - hash)
  })
  let colour = '#'
  for (let i = 0; i < 3; i++) {
    const value = (hash >> (i * 8)) & 0xff
    colour += value.toString(16).padStart(2, '0')
  }
  return colour
}
</script>