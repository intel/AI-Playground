<script lang="ts" setup>
import { ref, computed } from 'vue'
let draging = false
const props = withDefaults(
  defineProps<{
    current: number
    step: number
    min: number
    max: number
    disabled?: boolean
    showEditbox?: boolean
    showRange?: boolean
  }>(),
  {
    current: 0,
    step: 1,
    min: 0,
    max: 100,
    disabled: false,
    showEditbox: true,
    showRange: false,
  },
)

const scale = computed(() => getDecimalPlaces(props.current))

const emits = defineEmits<{
  (e: 'update:current', value: number): void
}>()
const per = computed(() => {
  //JS的浮点数精度泪流满面，全部转换为整数计算
  return `${(Math.round(props.current * scale.value - props.min * scale.value) / (props.max * scale.value - props.min * scale.value)) * 100}%`
})

const slibarPos = computed(() => {
  return `calc(${per.value} - 6px)`
})

const position = ref<HTMLDivElement>()

function getDecimalPlaces(num: number) {
  let decimalPlaces = 0
  while (num < 1) {
    decimalPlaces++
    num *= 10
  }
  return decimalPlaces == 0 ? 1 : Math.pow(10, decimalPlaces)
}

function getPercentRealVal(per: number): number {
  if (per <= 0) {
    return props.min
  } else if (per >= 1) {
    return props.max
  }
  const testVal = props.min + (props.max - props.min) * per
  let left = props.min
  let right = left
  while (left < props.max) {
    right += props.step
    if (left == testVal) {
      return left
    } else if (right > testVal) {
      return Math.abs(testVal - right) < Math.abs(testVal - left) ? right : left
    }
    left = right
  }
  return props.max
}

function clickSetVal(e: MouseEvent) {
  if (props.disabled) {
    return
  }
  if (!draging && e.currentTarget != null) {
    const radio = e.offsetY / (e.currentTarget as HTMLElement).offsetHeight
    const value = getPercentRealVal(radio)
    emits('update:current', value)
  }
}
function dragStart(e: PointerEvent) {
  if (props.disabled) {
    return
  }
  const div = position.value!
  div.onpointermove = dragMove
  div.onpointerup = dragEnd
  div.setPointerCapture(e.pointerId)
  draging = true
}

function upadteY(curY: number) {
  const rect = position.value!.getBoundingClientRect()
  let value: number
  if (curY >= rect.bottom) {
    value = props.min
  } else if (curY <= rect.top) {
    value = props.max
  } else {
    value = getPercentRealVal((rect.bottom - curY) / rect.height)
    if (value < props.min) {
      console.log(`error value:${value}. curY:${curY}, rectBottom:${rect.bottom}`)
    }
  }
  emits('update:current', value)
}

function dragMove(e: PointerEvent) {
  upadteY(e.clientY)
}

function dragEnd(e: PointerEvent) {
  position.value!.onpointermove = null
  upadteY(e.clientY)
}

function inputChange(e: Event) {
  const target = e.target as HTMLInputElement
  const match = /^-?[0-9]+(\.[0-9]*)?/.exec(target.value)
  if (match) {
    target.value = match[0]
  }
}

function changeLimit(e: Event) {
  const target = e.target as HTMLInputElement
  let numVal = parseFloat(target.value)
  if (numVal < props.min) {
    numVal = props.min
  } else if (numVal > props.max) {
    numVal = props.max
  }
  emits('update:current', numVal)
}
</script>
<template>
  <div class="v-vertical-slide" :class="{ disabled: disabled }">
    <div class="v-slide-container">
      <slot name="min" v-if="showRange"
        ><span class="v-slide-min">{{ props.min }}</span></slot
      >
      <div class="v-slide-position" ref="position" @click="clickSetVal" @pointerdown="dragStart">
        <div class="v-slide-bg">
          <i class="v-slide-bg-mask" :style="{ height: per }"></i>
        </div>
        <div class="v-slide-bar" :style="{ bottom: slibarPos }"></div>
      </div>
      <slot name="max" v-if="showRange"
        ><span class="v-slide-max">{{ props.max }}</span></slot
      >
    </div>
    <input
      class="v-slide-val"
      v-if="showEditbox"
      :value="props.current"
      type="text"
      @input="inputChange"
      @change="changeLimit"
    />
  </div>
</template>
