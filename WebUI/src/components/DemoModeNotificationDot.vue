<template>
  <Teleport :to="`#${targetId}`" v-if="mounted && targetExists">
    <span
      v-if="demoMode.enabled && !demoMode.isVisited(targetId)"
      class="demo-dot pointer-events-none"
      aria-hidden="true"
    >
      <span class="demo-dot-ping"></span>
    </span>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useDemoMode, type DemoButtonId } from '@/assets/js/store/demoMode'

const props = defineProps<{ targetId: DemoButtonId }>()

const demoMode = useDemoMode()
const mounted = ref(false)
const targetExists = ref(false)

let observer: MutationObserver | null = null

function checkTarget() {
  const el = document.getElementById(props.targetId)
  if (el) {
    targetExists.value = true
    // Ensure the target has relative positioning for the absolute dot
    // Use inline style directly on the element because it has higher specificity
    // than class selectors, which might unintentionally be overridden by other CSS classes.
    const style = getComputedStyle(el)
    if (style.position === 'static') {
      el.style.position = 'relative'
    }
    return true
  }
  targetExists.value = false
  return false
}

onMounted(() => {
  mounted.value = true
  if (!checkTarget()) {
    // Watch for the element to appear in the DOM
    observer = new MutationObserver(() => {
      if (checkTarget()) {
        observer?.disconnect()
        observer = null
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
})
</script>

<style scoped>
.demo-dot {
  position: absolute;
  top: -4px;
  right: -4px;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 10px;
  height: 10px;
  border-radius: 9999px;
  background-color: var(--demo-button-color, #00c4fa);
}

.demo-dot-ping {
  position: absolute;
  width: 10px;
  height: 10px;
  border-radius: 9999px;
  background-color: var(--demo-button-color, #00c4fa);
  opacity: 0.75;
  animation: demo-ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite;
}

@keyframes demo-ping {
  75%,
  100% {
    transform: scale(2);
    opacity: 0;
  }
}
</style>
