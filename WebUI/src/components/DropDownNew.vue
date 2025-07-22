<script lang="ts" setup>
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChevronDownIcon } from '@heroicons/vue/24/solid'

interface DropdownItem {
  label: string
  value: string
  active: boolean
}

const props = defineProps<{
  title?: string
  items: DropdownItem[]
  value: string
  onChange: (value: string) => void
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
    <DropdownMenuTrigger as-child>
      <button>
        <div
          class="w-full h-[30px] rounded-[15px] bg-[#05010f] border border-[#cdcdcd] text-white px-3 flex items-center justify-between"
        >
          <div
            class="w-2 h-2 rounded-full shrink-0"
            :class="selectedItem.active ? 'bg-green-500' : 'bg-gray-400'"
          ></div>
          <span class="text-xs flex-grow text-left px-3 text-nowrap">
            {{ selectedItem.label }}
          </span>
          <ChevronDownIcon class="size-4 text-gray-200"></ChevronDownIcon>
        </div>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      :align="'start'"
      :align-offset="-20"
      class="w-full rounded-lg p-[3px] border border-[#cdcdcd] bg-[#05010f] max-h-[188px] overflow-y-auto z-[100] ml-4"
    >
      <DropdownMenuLabel v-if="title" class="text-white px-3 py-2 text-sm font-medium">{{
        title
      }}</DropdownMenuLabel>
      <DropdownMenuSeparator v-if="title" class="bg-white/20" />
      <div class="py-1">
        <DropdownMenuItem
          v-for="item in items"
          :key="item.value"
          @click="
            () => {
              props.onChange(item.value)
            }
          "
          class="text-sm px-4 py-1 flex items-center text-left hover:bg-white/10 text-white"
        >
          <div
            class="w-2 h-2 rounded-full mr-2 shrink-0"
            :class="item.active ? 'bg-green-500' : 'bg-gray-400'"
          ></div>
          {{ item.label }}
        </DropdownMenuItem>
      </div>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
