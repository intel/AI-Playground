<script lang="ts" setup>
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ChevronDownIcon } from '@heroicons/vue/24/solid'

interface DropdownItem {
  label: string
  value: string
  active: boolean
  /**
   * Partially available: the item backs several resources and only some of them
   * are in place (e.g. Qwen TTS needs one model for built-in voices and another
   * for created voices). Renders the status dot half-filled, which reads as
   * "usable, but not everything is downloaded" — neither a full dot (nothing
   * left to fetch) nor an empty one (nothing there at all). Ignored when
   * `active` is true.
   */
  partial?: boolean
  // Optional hover text shown as a tooltip on the item (e.g. a voice description).
  description?: string
}

const props = defineProps<{
  title?: string
  items: DropdownItem[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}>()

const selectedItem = computed(() => {
  return (
    props.items.find((item) => item.value === props.value) || {
      label: 'Select...',
      value: '',
      active: false,
    }
  )
})
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child :disabled="props.disabled">
      <button :disabled="props.disabled">
        <div
          class="w-full h-[30px] rounded-md bg-card border border-border text-foreground px-3 flex items-center justify-between disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <div
            class="w-2 h-2 rounded-full shrink-0 relative overflow-hidden"
            :class="selectedItem.active ? 'bg-primary' : 'bg-muted-foreground'"
          >
            <div
              v-if="!selectedItem.active && selectedItem.partial"
              class="absolute inset-y-0 left-0 w-1/2 bg-primary"
            ></div>
          </div>
          <span class="text-xs flex-grow text-left px-3 text-nowrap">
            {{ selectedItem.label }}
          </span>
          <ChevronDownIcon class="size-4 text-muted-foreground"></ChevronDownIcon>
        </div>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      :align="'start'"
      :align-offset="-20"
      class="w-full rounded-md p-[3px] border border-border bg-card max-h-[188px] overflow-y-auto z-[100] ml-4"
    >
      <DropdownMenuLabel v-if="title" class="text-foreground px-3 py-2 text-sm font-medium">{{
        title
      }}</DropdownMenuLabel>
      <DropdownMenuSeparator v-if="title" class="bg-border" />
      <TooltipProvider :delay-duration="300">
        <div class="py-1">
          <Tooltip v-for="item in items" :key="item.value">
            <TooltipTrigger as-child>
              <DropdownMenuItem
                @click="
                  () => {
                    props.onChange(item.value)
                  }
                "
                class="text-sm px-4 py-1 flex items-center text-left hover:bg-muted text-foreground"
              >
                <div
                  class="w-2 h-2 rounded-full mr-2 shrink-0 relative overflow-hidden"
                  :class="item.active ? 'bg-primary' : 'bg-muted-foreground'"
                >
                  <div
                    v-if="!item.active && item.partial"
                    class="absolute inset-y-0 left-0 w-1/2 bg-primary"
                  ></div>
                </div>
                {{ item.label }}
              </DropdownMenuItem>
            </TooltipTrigger>
            <TooltipContent v-if="item.description" side="right" class="max-w-[280px] text-sm">
              {{ item.description }}
            </TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
