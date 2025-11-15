<template>
  <div class="outpaint-canvas-container flex flex-col gap-4">
    <div class="flex justify-center">
      <div
        ref="canvasContainer"
        class="relative border-2 border-border rounded-lg bg-muted overflow-hidden"
        :style="{
          width: `${canvasDisplayWidth}px`,
          height: `${canvasDisplayHeight}px`,
        }"
      >
        <canvas
          ref="canvas"
          :width="targetWidth"
          :height="targetHeight"
          class="absolute inset-0 w-full h-full"
          style="image-rendering: pixelated;"
        ></canvas>
        <!-- Image element - always render when URL exists so @load can fire -->
        <img
          v-if="imageUrl && imageUrl.trim() !== ''"
          ref="sourceImage"
          :src="imageUrl"
          class="hidden"
          @load="onImageLoad"
          @error="onImageError"
        />
        <!-- Image container - only show when loaded -->
        <div
          v-if="imageUrl && imageUrl.trim() !== '' && imageLoaded"
          ref="imageContainer"
          class="absolute cursor-move border-2 border-primary"
          :style="{
            left: `${imageX}px`,
            top: `${imageY}px`,
            width: `${imageWidth}px`,
            height: `${imageHeight}px`,
            transform: `scale(${canvasScale})`,
            transformOrigin: 'top left',
          }"
          @pointerdown="startDrag"
        >
          <img
            :src="imageUrl"
            class="w-full h-full object-contain"
            style="pointer-events: none;"
          />
          <!-- Scale handles -->
          <div
            class="absolute bottom-0 right-0 w-4 h-4 bg-primary cursor-nwse-resize"
            @pointerdown.stop="startResize"
          ></div>
        </div>
        <div
          v-else-if="imageUrl && imageUrl.trim() !== '' && !imageLoaded"
          class="absolute inset-0 flex items-center justify-center text-foreground/60"
        >
          Loading image...
        </div>
        <div
          v-else
          class="absolute inset-0 flex items-center justify-center text-foreground/60"
        >
          Load an image to position it
        </div>
      </div>
    </div>
    <div class="text-sm text-foreground/60 text-center">
      Target: {{ targetWidth }} × {{ targetHeight }}px
      <span v-if="imageUrl && imageLoaded">
        | Original: {{ sourceImageWidth }} × {{ sourceImageHeight }}px
        | Scale: {{ (scaleBy * 100).toFixed(1) }}%
        | Crop: {{ cropWidth }} × {{ cropHeight }}px
        | Padding: L:{{ left }} T:{{ top }} R:{{ right }} B:{{ bottom }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets'

const props = defineProps<{
  imageUrl: string
  targetWidth: number
  targetHeight: number
  left: number
  top: number
  right: number
  bottom: number
  feathering: number
}>()

const emits = defineEmits<{
  (e: 'update:left', value: number): void
  (e: 'update:top', value: number): void
  (e: 'update:right', value: number): void
  (e: 'update:bottom', value: number): void
  (e: 'update:feathering', value: number): void
  (e: 'update:scaleBy', value: number): void
  (e: 'update:cropWidth', value: number): void
  (e: 'update:cropHeight', value: number): void
  (e: 'update:cropX', value: number): void
  (e: 'update:cropY', value: number): void
}>()

const imageGeneration = useImageGenerationPresets()

const canvas = useTemplateRef<HTMLCanvasElement>('canvas')
const canvasContainer = useTemplateRef<HTMLDivElement>('canvasContainer')
const imageContainer = useTemplateRef<HTMLDivElement>('imageContainer')
const sourceImage = useTemplateRef<HTMLImageElement>('sourceImage')

const MAX_CANVAS_DISPLAY_SIZE = 400
const imageLoaded = ref(false)
const sourceImageWidth = ref(0)
const sourceImageHeight = ref(0)

// Canvas display size (scaled down for UI)
const canvasScale = computed(() => {
  const scaleX = MAX_CANVAS_DISPLAY_SIZE / props.targetWidth
  const scaleY = MAX_CANVAS_DISPLAY_SIZE / props.targetHeight
  return Math.min(scaleX, scaleY, 1)
})

const canvasDisplayWidth = computed(() => props.targetWidth * canvasScale.value)
const canvasDisplayHeight = computed(() => props.targetHeight * canvasScale.value)

// Image position and size (in target resolution coordinates)
const imageX = ref(0)
const imageY = ref(0)
const imageWidth = ref(0)
const imageHeight = ref(0)

// Drag state
const isDragging = ref(false)
const isResizing = ref(false)
const dragStartX = ref(0)
const dragStartY = ref(0)
const dragStartImageX = ref(0)
const dragStartImageY = ref(0)
const resizeStartWidth = ref(0)
const resizeStartHeight = ref(0)
const resizeStartX = ref(0)
const resizeStartY = ref(0)

// Calculate scale factor from image size vs original size
// The canvas shows the final cropped image size (imageWidth x imageHeight)
// We need to calculate what scale factor would produce this size from the original
// The user can scale independently in X and Y, so we need to ensure the scaled image
// is large enough to contain the crop region
const scaleBy = computed(() => {
  if (!sourceImageWidth.value || !imageWidth.value || !sourceImageHeight.value || !imageHeight.value) return 1.0
  // Calculate scale factors for both dimensions
  const scaleX = imageWidth.value / sourceImageWidth.value
  const scaleY = imageHeight.value / sourceImageHeight.value
  // Use the larger scale to ensure the scaled image contains the crop region
  // This ensures we can crop the desired region from the scaled image
  const scale = Math.max(scaleX, scaleY)
  // Don't scale up beyond 1.0
  return Math.min(scale, 1.0)
})

// Calculate crop parameters (in scaled image coordinates)
// After scaling the original image, we crop to get the final size shown in canvas
// The crop should extract the exact region that matches imageWidth x imageHeight
const scaledImageWidth = computed(() => Math.round(sourceImageWidth.value * scaleBy.value))
const scaledImageHeight = computed(() => Math.round(sourceImageHeight.value * scaleBy.value))

// Crop width/height should match the canvas image size
const cropWidth = computed(() => Math.round(imageWidth.value))
const cropHeight = computed(() => Math.round(imageHeight.value))
// Crop position: start from top-left (0,0) for now
// TODO: Allow user to adjust crop position in canvas
const cropX = computed(() => 0)
const cropY = computed(() => 0)

// Calculate padding values from image position
const left = computed(() => Math.max(0, Math.round(imageX.value)))
const top = computed(() => Math.max(0, Math.round(imageY.value)))
const right = computed(() =>
  Math.max(0, Math.round(props.targetWidth - (imageX.value + imageWidth.value))),
)
const bottom = computed(() =>
  Math.max(0, Math.round(props.targetHeight - (imageY.value + imageHeight.value))),
)

// Watch all calculated values and emit updates
// Only emit when image is loaded to ensure inputs are available
watch([left, top, right, bottom, scaleBy, cropWidth, cropHeight, cropX, cropY], 
  ([l, t, r, b, scale, cw, ch, cx, cy]) => {
    if (!imageLoaded.value) return // Don't emit until image is loaded
    console.log('Canvas values changed:', { scale, cw, ch, cx, cy, l, t, r, b })
    emits('update:left', l)
    emits('update:top', t)
    emits('update:right', r)
    emits('update:bottom', b)
    emits('update:scaleBy', scale)
    emits('update:cropWidth', cw)
    emits('update:cropHeight', ch)
    emits('update:cropX', cx)
    emits('update:cropY', cy)
  }
)

// Emit initial values when image loads
watch(imageLoaded, (loaded) => {
  if (loaded) {
    // Emit all current values once image is loaded
    emits('update:left', left.value)
    emits('update:top', top.value)
    emits('update:right', right.value)
    emits('update:bottom', bottom.value)
    emits('update:scaleBy', scaleBy.value)
    emits('update:cropWidth', cropWidth.value)
    emits('update:cropHeight', cropHeight.value)
    emits('update:cropX', cropX.value)
    emits('update:cropY', cropY.value)
  }
})

// Watch target resolution changes and recalculate image position
watch([() => props.targetWidth, () => props.targetHeight], () => {
  if (imageLoaded.value) {
    constrainImagePosition()
  }
  drawCanvas()
})

function onImageLoad() {
  if (!sourceImage.value) return

  console.log('Image loaded in canvas:', sourceImage.value.src.substring(0, 50))
  imageLoaded.value = true
  sourceImageWidth.value = sourceImage.value.naturalWidth
  sourceImageHeight.value = sourceImage.value.naturalHeight

  // Initialize image position: center the image in the canvas
  const scale = Math.min(
    props.targetWidth / sourceImageWidth.value,
    props.targetHeight / sourceImageHeight.value,
    1, // Don't scale up
  )

  imageWidth.value = sourceImageWidth.value * scale
  imageHeight.value = sourceImageHeight.value * scale

  // Center the image
  imageX.value = (props.targetWidth - imageWidth.value) / 2
  imageY.value = (props.targetHeight - imageHeight.value) / 2

  // If we have existing padding values, use them to position the image
  if (props.left !== 0 || props.top !== 0 || props.right !== 0 || props.bottom !== 0) {
    imageX.value = props.left
    imageY.value = props.top
    // Recalculate size based on padding
    const availableWidth = props.targetWidth - props.left - props.right
    const availableHeight = props.targetHeight - props.top - props.bottom
    const sizeScale = Math.min(availableWidth / sourceImageWidth.value, availableHeight / sourceImageHeight.value, 1)
    imageWidth.value = sourceImageWidth.value * sizeScale
    imageHeight.value = sourceImageHeight.value * sizeScale
  }

  constrainImagePosition()
  drawCanvas()
}

function onImageError(e: Event) {
  console.error('Failed to load image in canvas:', e)
  imageLoaded.value = false
}

function constrainImagePosition() {
  // Ensure image stays within canvas bounds
  imageX.value = Math.max(0, Math.min(imageX.value, props.targetWidth - imageWidth.value))
  imageY.value = Math.max(0, Math.min(imageY.value, props.targetHeight - imageHeight.value))
  
  // Ensure minimum size
  const minSize = 64
  if (imageWidth.value < minSize) {
    imageWidth.value = minSize
    imageX.value = Math.max(0, Math.min(imageX.value, props.targetWidth - minSize))
  }
  if (imageHeight.value < minSize) {
    imageHeight.value = minSize
    imageY.value = Math.max(0, Math.min(imageY.value, props.targetHeight - minSize))
  }
}

function drawCanvas() {
  if (!canvas.value) return

  const ctx = canvas.value.getContext('2d')
  if (!ctx) return

  // Clear canvas with neutral background
  ctx.fillStyle = '#f5f5f5'
  ctx.fillRect(0, 0, props.targetWidth, props.targetHeight)

  // Draw grid
  ctx.strokeStyle = '#e0e0e0'
  ctx.lineWidth = 1
  const gridSize = 64
  for (let x = 0; x < props.targetWidth; x += gridSize) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, props.targetHeight)
    ctx.stroke()
  }
  for (let y = 0; y < props.targetHeight; y += gridSize) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(props.targetWidth, y)
    ctx.stroke()
  }

  // Draw padding areas (outpaint regions)
  ctx.fillStyle = 'rgba(156, 163, 175, 0.3)' // neutral gray with transparency
  
  // Top padding
  if (top.value > 0) {
    ctx.fillRect(0, 0, props.targetWidth, top.value)
  }
  // Bottom padding
  if (bottom.value > 0) {
    ctx.fillRect(0, props.targetHeight - bottom.value, props.targetWidth, bottom.value)
  }
  // Left padding
  if (left.value > 0) {
    ctx.fillRect(0, 0, left.value, props.targetHeight)
  }
  // Right padding
  if (right.value > 0) {
    ctx.fillRect(props.targetWidth - right.value, 0, right.value, props.targetHeight)
  }
}

function startDrag(e: PointerEvent) {
  if (!imageContainer.value) return
  
  isDragging.value = true
  dragStartX.value = e.clientX
  dragStartY.value = e.clientY
  dragStartImageX.value = imageX.value
  dragStartImageY.value = imageY.value

  imageContainer.value.setPointerCapture(e.pointerId)
  imageContainer.value.addEventListener('pointermove', onDrag)
  imageContainer.value.addEventListener('pointerup', stopDrag, { once: true })
}

function onDrag(e: PointerEvent) {
  if (!isDragging.value || !canvasContainer.value) return

  const rect = canvasContainer.value.getBoundingClientRect()
  const deltaX = (e.clientX - dragStartX.value) / canvasScale.value
  const deltaY = (e.clientY - dragStartY.value) / canvasScale.value

  imageX.value = dragStartImageX.value + deltaX
  imageY.value = dragStartImageY.value + deltaY

  constrainImagePosition()
  drawCanvas()
}

function stopDrag() {
  isDragging.value = false
  if (imageContainer.value) {
    imageContainer.value.removeEventListener('pointermove', onDrag)
  }
}

function startResize(e: PointerEvent) {
  if (!imageContainer.value) return

  e.stopPropagation()
  isResizing.value = true
  dragStartX.value = e.clientX
  dragStartY.value = e.clientY
  resizeStartWidth.value = imageWidth.value
  resizeStartHeight.value = imageHeight.value
  resizeStartX.value = imageX.value
  resizeStartY.value = imageY.value

  imageContainer.value.setPointerCapture(e.pointerId)
  imageContainer.value.addEventListener('pointermove', onResize)
  imageContainer.value.addEventListener('pointerup', stopResize, { once: true })
}

function onResize(e: PointerEvent) {
  if (!isResizing.value || !canvasContainer.value) return

  const deltaX = (e.clientX - dragStartX.value) / canvasScale.value
  const deltaY = (e.clientY - dragStartY.value) / canvasScale.value

  // Calculate new size maintaining aspect ratio
  const aspectRatio = sourceImageWidth.value / sourceImageHeight.value
  const newWidth = Math.max(64, Math.min(resizeStartWidth.value + deltaX, props.targetWidth - resizeStartX.value))
  const newHeight = newWidth / aspectRatio

  // Check if height fits
  if (newHeight > props.targetHeight - resizeStartY.value) {
    const constrainedHeight = props.targetHeight - resizeStartY.value
    imageHeight.value = constrainedHeight
    imageWidth.value = constrainedHeight * aspectRatio
  } else {
    imageWidth.value = newWidth
    imageHeight.value = newHeight
  }

  constrainImagePosition()
  drawCanvas()
}

function stopResize() {
  isResizing.value = false
  if (imageContainer.value) {
    imageContainer.value.removeEventListener('pointermove', onResize)
  }
}

// Watch for image URL changes
watch(() => props.imageUrl, (newUrl, oldUrl) => {
  // Only reload if URL actually changed
  if (newUrl && newUrl.trim() !== '' && newUrl !== oldUrl) {
    imageLoaded.value = false
    nextTick(() => {
      if (sourceImage.value) {
        // Clear previous src to force reload
        sourceImage.value.src = ''
        nextTick(() => {
          if (sourceImage.value) {
            sourceImage.value.src = newUrl
          }
        })
      }
    })
  } else if (!newUrl || newUrl.trim() === '') {
    imageLoaded.value = false
    imageX.value = 0
    imageY.value = 0
    imageWidth.value = 0
    imageHeight.value = 0
    sourceImageWidth.value = 0
    sourceImageHeight.value = 0
    if (sourceImage.value) {
      sourceImage.value.src = ''
    }
    drawCanvas()
  }
}, { immediate: true })

// Watch for padding changes from outside (e.g., when preset loads)
watch([() => props.left, () => props.top, () => props.right, () => props.bottom], ([l, t, r, b]) => {
  if (imageLoaded.value && (l !== left.value || t !== top.value || r !== right.value || b !== bottom.value)) {
    // Update position based on padding
    imageX.value = l
    imageY.value = t
    const availableWidth = props.targetWidth - l - r
    const availableHeight = props.targetHeight - t - b
    if (availableWidth > 0 && availableHeight > 0) {
      const scale = Math.min(
        availableWidth / sourceImageWidth.value,
        availableHeight / sourceImageHeight.value,
        1,
      )
      imageWidth.value = sourceImageWidth.value * scale
      imageHeight.value = sourceImageHeight.value * scale
    }
    constrainImagePosition()
    drawCanvas()
  }
})

onMounted(() => {
  drawCanvas()
  // Load image if URL is already available
  if (props.imageUrl && props.imageUrl.trim() !== '') {
    nextTick(() => {
      if (sourceImage.value) {
        sourceImage.value.src = props.imageUrl
      }
    })
  }
})

watch([imageX, imageY, imageWidth, imageHeight], () => {
  drawCanvas()
})
</script>

<style scoped>
.outpaint-canvas-container {
  width: 100%;
}
</style>

