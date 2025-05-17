<script lang="ts" setup>
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useTextInference, backendToService } from '@/assets/js/store/textInference'
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChevronDownIcon } from '@heroicons/vue/24/solid'
import { Checkbox } from './ui/checkbox'

const backendServices = useBackendServices()
const textInference = useTextInference()
const runningOnOpenvinoNpu = computed(
  () =>
    !!backendServices.info
      .find((s) => s.serviceName === backendToService[textInference.backend])
      ?.devices.find((d) => d.selected)
      ?.id.includes('NPU'),
)
const showOnlyCompatible = ref(true)

const value = computed(
  () =>
    textInference.llmModels.filter((m) => m.type === textInference.backend).find((m) => m.active)
      ?.name ?? '',
)

const items = computed(() =>
  textInference.llmModels
    .filter((m) => m.type === textInference.backend)
    .filter((m) =>
      runningOnOpenvinoNpu.value && showOnlyCompatible.value ? m.name.includes('sym') : true,
    )
    .map((item) => ({
      label: item.name.split('/').at(-1) ?? item.name,
      value: item.name,
      active: item.downloaded,
    })),
)

const selectedItem = computed(() => {
  return (
    items.value.find((item) => item.value === value.value) || {
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
            class="w-2 h-2 rounded-full flex-shrink-0"
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
      <DropdownMenuLabel class="text-white px-3 py-2 text-sm font-medium">{{
        'Text Inference Model'
      }}</DropdownMenuLabel>
      <div class="px-3 flex items-center" v-if="runningOnOpenvinoNpu">
        <Checkbox
          id="showOnlyCompatible"
          :model-value="showOnlyCompatible"
          :onclick="() => (showOnlyCompatible = !showOnlyCompatible)"
        />
        <label
          for="showOnlyCompatible"
          class="px-2 text-xs font-light text-base leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
        >
          Show only NPU compatible models
        </label>
      </div>
      <DropdownMenuSeparator class="bg-white/20" />
      <div class="py-1">
        <DropdownMenuItem
          v-for="item in items"
          :key="item.value"
          @click="() => textInference.selectModel(textInference.backend, item.value)"
          class="text-sm px-4 py-1 flex items-center text-left hover:bg-white/10 text-white"
        >
          <div
            class="w-2 h-2 rounded-full mr-2 flex-shrink-0"
            :class="item.active ? 'bg-green-500' : 'bg-gray-400'"
          ></div>
          {{ item.label }}
        </DropdownMenuItem>
      </div>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
