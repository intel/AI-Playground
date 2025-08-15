<script lang="ts" setup>
import type { ComfyUiWorkflow } from '@/assets/js/store/imageGeneration'
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { ChevronDownIcon } from '@heroicons/vue/24/solid'

const props = defineProps<{
  title?: string
  workflows: ComfyUiWorkflow[]
  selectedWorkflowName: string | null
  onChange: (value: string) => void
}>()

const selectedWorkflow = computed(() => {
  return (
    props.workflows.find((wf) => wf.name === props.selectedWorkflowName) || {
      name: 'Select...',
      tags: [],
    }
  )
})

const categories = computed(() => new Set(props.workflows.map((wf) => wf.category ?? 'other')))

const stringToColour = (str: string) => {
  const colors = [
    '#ff00ff', // Magenta
    '#ff33cc', // Light Magenta
    '#cc00ff', // Purple
    '#9900ff', // Dark Purple
    '#6600ff', // Indigo
    '#3300ff', // Blue
    '#00ccff', // Light Blue
    '#00ffff', // Cyan
  ]

  let hash = 0
  str.split('').forEach((char) => {
    hash = char.charCodeAt(0) + ((hash << 5) - hash)
  })

  // Use the hash to select a color from the palette
  const index = Math.abs(hash) % colors.length
  return colors[index]
}
</script>

<template>
  <DropdownMenu>
    <div class="grow">
      <DropdownMenuTrigger as-child>
        <button class="w-full">
          <div
            class="w-full h-[30px] rounded-[15px] bg-[#05010f] border border-[#cdcdcd] text-white gap-1 px-3 flex items-center justify-between"
          >
            <span class="text-xs flex-grow text-left px-3 text-nowrap">
              {{ selectedWorkflow.name }}
            </span>
            <span
              class="rounded-lg h-4 px-1 text-xs"
              :style="{ 'background-color': `${stringToColour(tag)}88` }"
              v-for="tag in selectedWorkflow.tags"
              :key="tag"
            >
              {{ tag }}
            </span>
            <ChevronDownIcon class="size-4 text-gray-200"></ChevronDownIcon>
          </div>
        </button>
      </DropdownMenuTrigger>
    </div>
    <DropdownMenuContent
      :align="'start'"
      :align-offset="-20"
      class="w-full rounded-lg p-[3px] border border-[#cdcdcd] bg-[#05010f] max-h-[320px] overflow-y-auto z-[100] ml-4"
    >
      <Accordion type="single" collapsible>
        <AccordionItem :value="category" v-for="category in categories" :key="category">
          <AccordionTrigger>
            <DropdownMenuLabel class="text-white px-3 py-1 text-sm font-bold">{{
              category
                ?.split('-')
                .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
                .join(' ')
            }}</DropdownMenuLabel>
          </AccordionTrigger>
          <AccordionContent>
            <DropdownMenuItem
              v-for="wf in workflows.filter((wf) => wf.category === category)"
              :key="wf.name"
              @click="
                () => {
                  props.onChange(wf.name)
                }
              "
              class="text-sm gap-1 px-4 py-1 flex items-center justify-between text-left hover:bg-white/10 text-white"
              ><span class="flex-grow text-left text-nowrap">
                {{ wf.name }}
              </span>
              <span
                class="rounded-lg h-4 px-1 text-xs"
                :style="{ 'background-color': `${stringToColour(tag)}88` }"
                v-for="tag in wf.tags"
                :key="tag"
              >
                {{ tag }}
              </span>
            </DropdownMenuItem>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
