<template>
  <div class="outpaint-control flex items-center justify-center">
    <div class="outpaint-control-bg">
      <button
        class="outpaint-drieciton top"
        :class="{ active: modelValue === 'top' }"
        @click="updateDirection('top')"
      ></button>
      <button
        class="outpaint-drieciton right"
        :class="{ active: modelValue === 'right' }"
        @click="updateDirection('right')"
      ></button>
      <button
        class="outpaint-drieciton bottom"
        :class="{ active: modelValue === 'bottom' }"
        @click="updateDirection('bottom')"
      ></button>
      <button
        class="outpaint-drieciton left"
        :class="{ active: modelValue === 'left' }"
        @click="updateDirection('left')"
      ></button>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  modelValue: 'top' | 'right' | 'bottom' | 'left'
}>()

const emits = defineEmits<{
  (e: 'update:modelValue', value: 'top' | 'right' | 'bottom' | 'left'): void
}>()

function updateDirection(value: 'top' | 'right' | 'bottom' | 'left') {
  emits('update:modelValue', value)
}
</script>

<style scoped>
.outpaint-control {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 180px;
  height: 108px;
}

.outpaint-control-bg {
  width: 142px;
  height: 92px;
  background: url('@/assets/svg/outpaint-bg.svg') 0px 0px no-repeat;
  position: relative;
}

.outpaint-drieciton {
  width: 28px;
  height: 28px;
  position: absolute;
  background: hsl(var(--muted));
  border-radius: 4px;
  cursor: pointer;
  border: none;
  transition: background 0.2s;
}

.outpaint-drieciton.active {
  background: var(--main-gradient);
}

.outpaint-drieciton::after {
  position: absolute;
  content: '';
  width: 18px;
  height: 18px;
  left: calc(50% - 9px);
  top: calc(50% - 9px);
  background-color: hsl(var(--foreground));
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-size: 100% 100%;
  mask-size: 100% 100%;
  -webkit-mask-image: url('@/assets/svg/outpaint-dir.svg');
  mask-image: url('@/assets/svg/outpaint-dir.svg');
}

.outpaint-drieciton.top {
  left: calc(50% - 14px);
  top: -14px;
}

.outpaint-drieciton.right {
  top: calc(50% - 14px);
  right: -14px;
  transform: rotate(90deg);
}

.outpaint-drieciton.bottom {
  left: calc(50% - 14px);
  bottom: -14px;
  transform: rotate(180deg);
}

.outpaint-drieciton.left {
  top: calc(50% - 14px);
  left: -14px;
  transform: rotate(270deg);
}
</style>

