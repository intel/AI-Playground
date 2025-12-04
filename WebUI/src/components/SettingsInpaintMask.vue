<template>
  <div class="flex flex-col gap-4 w-full">
    <!-- Controls -->
    <div class="flex items-center gap-4">
      <div class="flex items-center gap-2">
        <div class="flex gap-2">
          <button
            :class="[
              'px-3 py-1 rounded border',
              mode === 'brush'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-foreground border-border',
            ]"
            @click="mode = 'brush'"
          >
            <PaintBrushIcon class="size-4"></PaintBrushIcon>
          </button>
          <button
            :class="[
              'px-3 py-1 rounded border',
              mode === 'eraser'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-foreground border-border',
            ]"
            @click="mode = 'eraser'"
          >
            <TrashIcon class="size-4"></TrashIcon>
          </button>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <Slider v-model="brushSize" :min="10" :max="100" :step="5" class="w-16" />
        <span class="text-sm text-foreground/60 w-12">{{ brushSize }}px</span>
      </div>
      <button
        class="px-3 py-1 rounded border bg-background text-foreground border-border hover:bg-muted"
        @click="clearMask"
      >
        <NoSymbolIcon class="size-4"></NoSymbolIcon>
      </button>
    </div>

    <!-- Canvas Container -->
    <div ref="parentContainer" class="flex justify-center w-full">
      <div
        ref="canvasContainer"
        class="relative border-2 border-border rounded-lg bg-muted overflow-hidden"
        :style="{
          width: imageLoaded ? `${canvasDisplayWidth}px` : '100%',
          height: imageLoaded ? `${canvasDisplayHeight}px` : 'auto',
          maxWidth: '100%',
          maxHeight: '100%',
        }"
      >
        <!-- Base image - use originalImageUrl if available, otherwise use imageUrl prop -->
        <img
          v-if="(originalImageUrl || imageUrl) && (originalImageUrl || imageUrl).trim() !== ''"
          ref="sourceImage"
          :src="originalImageUrl || imageUrl"
          class="absolute inset-0 w-full h-full object-contain"
          @load="onImageLoad"
          @error="onImageError"
        />

        <!-- Mask canvas (drawing layer) -->
        <canvas
          v-if="imageLoaded"
          ref="maskCanvas"
          :width="imageWidth"
          :height="imageHeight"
          class="absolute inset-0"
          :style="{
            cursor: mode === 'brush' ? 'crosshair' : 'crosshair',
            width: `${canvasDisplayWidth}px`,
            height: `${canvasDisplayHeight}px`,
            imageRendering: 'pixelated',
          }"
          @pointerdown="startDrawing"
          @pointermove="updateCursor"
        />

        <!-- Preview overlay (red tint on masked areas) -->
        <canvas
          v-if="imageLoaded"
          ref="previewCanvas"
          :width="imageWidth"
          :height="imageHeight"
          class="absolute inset-0 pointer-events-none"
          :style="{
            width: `${canvasDisplayWidth}px`,
            height: `${canvasDisplayHeight}px`,
            imageRendering: 'pixelated',
          }"
        />

        <!-- Loading/Empty states -->
        <div
          v-if="
            (originalImageUrl || imageUrl) &&
            (originalImageUrl || imageUrl).trim() !== '' &&
            !imageLoaded
          "
          class="absolute inset-0 flex items-center justify-center text-foreground/60 pointer-events-none"
        >
          Loading image...
        </div>
        <div
          v-else-if="
            (!originalImageUrl && !imageUrl) || (originalImageUrl || imageUrl || '').trim() === ''
          "
          class="absolute inset-0 flex items-center justify-center text-foreground/60 pointer-events-none"
        >
          Load an image to draw mask
        </div>
      </div>
    </div>

    <!-- Info -->
    <div class="text-sm text-foreground/60 text-center">
      <span v-if="imageUrl && imageLoaded">
        Image: {{ imageWidth }} × {{ imageHeight }}px | Draw on areas you want to inpaint
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import Slider from './ui/slider/Slider.vue'
import { NoSymbolIcon, PaintBrushIcon, TrashIcon } from '@heroicons/vue/24/outline'

const props = defineProps<{
  imageUrl: string
}>()

const emits = defineEmits<{
  (e: 'update:image', value: string): void
}>()

const parentContainer = useTemplateRef<HTMLDivElement>('parentContainer')
const canvasContainer = useTemplateRef<HTMLDivElement>('canvasContainer')
const sourceImage = useTemplateRef<HTMLImageElement>('sourceImage')
const maskCanvas = useTemplateRef<HTMLCanvasElement>('maskCanvas')
const previewCanvas = useTemplateRef<HTMLCanvasElement>('previewCanvas')

const imageLoaded = ref(false)
const imageWidth = ref(0)
const imageHeight = ref(0)
const sourceImageWidth = ref(0)
const sourceImageHeight = ref(0)
const originalImageUrl = ref<string>('') // Store original image URL separately
const containerWidth = ref(0)
const containerHeight = ref(0)

const mode = ref<'brush' | 'eraser'>('brush')
const brushSize = ref(30)
const isDrawing = ref(false)

// Use ResizeObserver to track parent container size
let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  if (parentContainer.value) {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        console.log('### resizeObserver', entry.contentRect.width, entry.contentRect.height)
        containerWidth.value = entry.contentRect.width
        containerHeight.value = entry.contentRect.height
      }
    })
    resizeObserver.observe(parentContainer.value)

    // Initial size
    containerWidth.value = parentContainer.value.clientWidth
    containerHeight.value = parentContainer.value.clientHeight
  }
})

onUnmounted(() => {
  if (resizeObserver && parentContainer.value) {
    resizeObserver.unobserve(parentContainer.value)
    resizeObserver.disconnect()
  }
})

// Canvas display size (scaled to fit parent container width, height calculated from aspect ratio)
const canvasScale = computed(() => {
  console.log(
    '### canvasScale',
    imageWidth.value,
    imageHeight.value,
    containerWidth.value,
    containerHeight.value,
  )
  if (!imageWidth.value || !imageHeight.value || !containerWidth.value) return 1
  // Use container width minus some padding (e.g., 20px on each side)
  const availableWidth = containerWidth.value - 40
  // Calculate scale based on width only
  const scale = availableWidth / imageWidth.value
  // Don't scale up beyond 1:1
  return Math.min(scale, 1)
})

const canvasDisplayWidth = computed(() => imageWidth.value * canvasScale.value)
const canvasDisplayHeight = computed(() => {
  if (!imageWidth.value || !imageHeight.value) return 0
  // Calculate height based on scaled width and image aspect ratio
  return (canvasDisplayWidth.value / imageWidth.value) * imageHeight.value
})

function onImageLoad() {
  if (!sourceImage.value) return

  console.log('### onImageLoad', sourceImage.value.naturalWidth, sourceImage.value.naturalHeight)
  imageLoaded.value = true
  sourceImageWidth.value = sourceImage.value.naturalWidth
  sourceImageHeight.value = sourceImage.value.naturalHeight
  imageWidth.value = sourceImageWidth.value
  imageHeight.value = sourceImageHeight.value

  // Store the original image URL for display purposes
  originalImageUrl.value = props.imageUrl

  nextTick(() => {
    initializeMaskCanvas()
    drawPreview()
    // Don't emit immediately - wait for user to draw a mask
    // The original image will be used until a mask is drawn
  })
}

function onImageError() {
  imageLoaded.value = false
}

function initializeMaskCanvas() {
  if (!maskCanvas.value) return

  const ctx = maskCanvas.value.getContext('2d', { willReadFrequently: true })
  if (!ctx) return

  // Clear mask canvas (transparent)
  ctx.clearRect(0, 0, imageWidth.value, imageHeight.value)
}

function getCanvasCoordinates(e: PointerEvent): { x: number; y: number } | null {
  if (!maskCanvas.value || !canvasContainer.value) return null

  const rect = canvasContainer.value.getBoundingClientRect()
  const scaleX = imageWidth.value / canvasDisplayWidth.value
  const scaleY = imageHeight.value / canvasDisplayHeight.value

  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  }
}

function startDrawing(e: PointerEvent) {
  if (!maskCanvas.value || !imageLoaded.value) return

  isDrawing.value = true
  const coords = getCanvasCoordinates(e)
  if (!coords) return

  drawAt(coords.x, coords.y)

  maskCanvas.value.setPointerCapture(e.pointerId)
  maskCanvas.value.addEventListener('pointermove', onDrawing)
  maskCanvas.value.addEventListener('pointerup', stopDrawing, { once: true })
}

function onDrawing(e: PointerEvent) {
  if (!isDrawing.value || !maskCanvas.value) return

  const coords = getCanvasCoordinates(e)
  if (!coords) return

  drawAt(coords.x, coords.y)
}

function stopDrawing() {
  isDrawing.value = false
  if (maskCanvas.value) {
    maskCanvas.value.removeEventListener('pointermove', onDrawing)
  }
  drawPreview()
  emitMaskedImage()
}

function drawAt(x: number, y: number) {
  if (!maskCanvas.value) return

  const ctx = maskCanvas.value.getContext('2d', { willReadFrequently: true })
  if (!ctx) return

  ctx.globalCompositeOperation = mode.value === 'brush' ? 'source-over' : 'destination-out'

  if (mode.value === 'brush') {
    // Draw white (will become alpha=255 in final image)
    ctx.fillStyle = 'rgba(255, 255, 255, 255)'
  }

  ctx.beginPath()
  ctx.arc(x, y, brushSize.value / 2, 0, 2 * Math.PI)
  ctx.fill()

  // Update preview in real-time
  drawPreview()
}

function drawPreview() {
  if (!previewCanvas.value || !maskCanvas.value || !sourceImage.value) return

  const previewCtx = previewCanvas.value.getContext('2d')
  const maskCtx = maskCanvas.value.getContext('2d', { willReadFrequently: true })
  if (!previewCtx || !maskCtx) return

  // Clear preview
  previewCtx.clearRect(0, 0, imageWidth.value, imageHeight.value)

  // Get mask data
  const maskData = maskCtx.getImageData(0, 0, imageWidth.value, imageHeight.value)

  // Draw red tint overlay on masked areas
  previewCtx.fillStyle = 'rgba(255, 0, 0, 0.4)' // Red tint with transparency
  for (let i = 0; i < maskData.data.length; i += 4) {
    const alpha = maskData.data[i + 3]
    if (alpha > 0) {
      const x = (i / 4) % imageWidth.value
      const y = Math.floor(i / 4 / imageWidth.value)
      previewCtx.fillRect(x, y, 1, 1)
    }
  }
}

function clearMask() {
  if (!maskCanvas.value) return

  const ctx = maskCanvas.value.getContext('2d', { willReadFrequently: true })
  if (!ctx) return

  ctx.clearRect(0, 0, imageWidth.value, imageHeight.value)
  drawPreview()
  emitMaskedImage()
}

function updateCursor(_e: PointerEvent) {
  // Could add cursor preview here if needed
}

function emitMaskedImage() {
  if (!sourceImage.value || !maskCanvas.value || !imageLoaded.value) return

  // Create a new canvas to combine image and mask
  const outputCanvas = document.createElement('canvas')
  outputCanvas.width = imageWidth.value
  outputCanvas.height = imageHeight.value
  const outputCtx = outputCanvas.getContext('2d')
  if (!outputCtx) return

  // Draw the original image
  outputCtx.drawImage(sourceImage.value, 0, 0, imageWidth.value, imageHeight.value)

  // Get mask data
  const maskCtx = maskCanvas.value.getContext('2d', { willReadFrequently: true })
  if (!maskCtx) return

  const maskData = maskCtx.getImageData(0, 0, imageWidth.value, imageHeight.value)
  const imageData = outputCtx.getImageData(0, 0, imageWidth.value, imageHeight.value)

  // Check if there's any mask drawn
  let hasMask = false
  for (let i = 3; i < maskData.data.length; i += 4) {
    if (maskData.data[i] > 0) {
      hasMask = true
      break
    }
  }

  // If no mask is drawn, emit the original image with full opacity (no inpainting)
  if (!hasMask) {
    // Set all alpha to 255 (fully opaque = no inpainting)
    for (let i = 3; i < imageData.data.length; i += 4) {
      imageData.data[i] = 255
    }
  } else {
    // Apply mask to alpha channel
    // According to ComfyUI docs: transparent areas (alpha=0) become the mask (will be inpainted)
    // Masked areas (white in mask canvas) = alpha 0 (transparent = will be inpainted)
    // Unmasked areas = alpha 255 (opaque = won't be inpainted)
    for (let i = 0; i < imageData.data.length; i += 4) {
      const maskAlpha = maskData.data[i + 3] // Alpha channel of mask
      // If mask has any opacity (user drew here), set image alpha to 0 (transparent = will be inpainted)
      // If mask is transparent (user didn't draw), set image alpha to 255 (opaque = won't be inpainted)
      imageData.data[i + 3] = maskAlpha > 0 ? 0 : 255
    }
  }

  outputCtx.putImageData(imageData, 0, 0)

  // Convert to PNG data URI (PNG preserves alpha channel)
  const dataUri = outputCanvas.toDataURL('image/png')
  emits('update:image', dataUri)
}

// Watch for image URL changes (only reload if it's a different original image, not a mask update)
watch(
  () => props.imageUrl,
  (newUrl, oldUrl) => {
    // If we already have an original image URL stored, check if this is just a mask update
    if (originalImageUrl.value && newUrl) {
      const isDataUri = newUrl.startsWith('data:')
      const originalIsDataUri = originalImageUrl.value.startsWith('data:')

      // If the new URL is a data URI and we have an original, it's likely a mask update
      // Only reload if the original image part changed
      if (isDataUri && originalIsDataUri) {
        // Extract the image data part (after the comma) and compare first few bytes
        // If it's the same base image, don't reload
        const newImageData = newUrl.split(',')[1]?.substring(0, 100)
        const originalImageData = originalImageUrl.value.split(',')[1]?.substring(0, 100)
        if (newImageData === originalImageData) {
          // Same base image, just different mask - don't reload
          return
        }
      } else if (isDataUri && !originalIsDataUri) {
        // New URL is data URI but original wasn't - this is a mask update, don't reload
        return
      }
    }

    // Only reload if this is a genuinely different image
    if (newUrl && newUrl.trim() !== '' && newUrl !== oldUrl) {
      // Check if it's a file URL or different source (not a masked version)
      const isFileUrl =
        newUrl.startsWith('file://') || newUrl.startsWith('blob:') || !newUrl.startsWith('data:')
      if (isFileUrl || !originalImageUrl.value) {
        imageLoaded.value = false
        originalImageUrl.value = '' // Reset original URL
        nextTick(() => {
          if (sourceImage.value) {
            sourceImage.value.src = newUrl
          }
        })
      }
    } else if (!newUrl || newUrl.trim() === '') {
      imageLoaded.value = false
      originalImageUrl.value = ''
      imageWidth.value = 0
      imageHeight.value = 0
      sourceImageWidth.value = 0
      sourceImageHeight.value = 0
    }
  },
  { immediate: true },
)

onMounted(() => {
  if (props.imageUrl && props.imageUrl.trim() !== '') {
    nextTick(() => {
      if (sourceImage.value) {
        sourceImage.value.src = props.imageUrl
      }
    })
  }
})
</script>
