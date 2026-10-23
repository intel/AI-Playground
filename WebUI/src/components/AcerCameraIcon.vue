<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { CameraIcon } from '@heroicons/vue/24/solid'
import AcerPhoneWebcamImage from '@/assets/image/AcerPhoneWebcam.png'
import { useAcerPhoneWebcam } from '@/assets/js/store/acerPhoneWebcam'

const props = withDefaults(
  defineProps<{
    class?: string
  }>(),
  {
    class: 'w-5 h-5',
  },
)

const acerPhoneWebcam = useAcerPhoneWebcam()
const { directActive } = storeToRefs(acerPhoneWebcam)

onMounted(() => {
  acerPhoneWebcam.acquire()
})

onBeforeUnmount(() => {
  acerPhoneWebcam.release()
})

const resolvedClass = computed(() => props.class)
</script>

<template>
  <img
    v-if="directActive"
    :src="AcerPhoneWebcamImage"
    alt=""
    class="object-contain"
    :class="resolvedClass"
  />
  <CameraIcon v-else :class="resolvedClass" />
</template>
