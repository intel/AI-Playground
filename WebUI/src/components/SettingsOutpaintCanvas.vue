<template>
  <div class="outpaint-canvas-container flex flex-col gap-4">
    <div ref="parentContainer" class="flex justify-center w-full">
      <div
        class="relative border-2 border-border rounded-lg bg-muted overflow-hidden touch-none"
        :style="{
          width: `${canvasDisplayWidth}px`,
          height: `${canvasDisplayHeight}px`,
          maxWidth: '100%',
          maxHeight: '100%',
        }"
      >
        <canvas
          ref="canvas"
          :width="targetWidth"
          :height="targetHeight"
          class="absolute inset-0 w-full h-full touch-none"
          :style="{ cursor: canvasCursor }"
          style="image-rendering: pixelated"
          @pointerdown="startDrag"
          @pointermove="updateCursor"
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
        <div
          v-if="imageUrl && imageUrl.trim() !== '' && !imageLoaded"
          class="absolute inset-0 flex items-center justify-center text-foreground/60 pointer-events-none"
        >
          Loading image...
        </div>
        <div
          v-else-if="!imageUrl || imageUrl.trim() === ''"
          class="absolute inset-0 flex items-center justify-center text-foreground/60 pointer-events-none"
        >
          Load an image to position it
        </div>
      </div>
    </div>
    <!-- <div class="text-sm text-foreground/60 text-center">
      Target: {{ targetWidth }} × {{ targetHeight }}px
      <span v-if="imageUrl && imageLoaded">
        | Original: {{ sourceImageWidth }} × {{ sourceImageHeight }}px | Scale:
        {{ (scaleBy * 100).toFixed(1) }}% | Crop: {{ cropWidth }} × {{ cropHeight }}px | Padding:
        L:{{ computedLeft }} T:{{ computedTop }} R:{{ computedRight }} B:{{ bottom }}
      </span>
    </div> -->
  </div>
</template>

<script setup lang="ts">
import { computed, watch, nextTick, onMounted, onUnmounted } from 'vue'

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
  (e: 'update:preview', value: string): void
  /** RGBA PNG for Comfy LoadImage: opaque where the source sits, transparent in outpaint regions */
  (e: 'compositeExport', value: string): void
}>()

const canvas = useTemplateRef<HTMLCanvasElement>('canvas')
const parentContainer = useTemplateRef<HTMLDivElement>('parentContainer')
const sourceImage = useTemplateRef<HTMLImageElement>('sourceImage')

const imageLoaded = ref(false)
const sourceImageWidth = ref(0)
const sourceImageHeight = ref(0)
const containerWidth = ref(0)
const containerHeight = ref(0)

// Use ResizeObserver to track parent container size
let resizeObserver: ResizeObserver | null = null
let resizeObservedParent: HTMLElement | null = null

/** Canvas stroke/fill ignores CSS var() syntax; resolve theme tokens explicitly. */
function hslFromCssVariable(cssVarName: string, fallbackHueChannel: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(cssVarName).trim()
  return raw ? `hsl(${raw})` : `hsl(${fallbackHueChannel})`
}

function safeReleasePointerCapture(el: HTMLElement, pointerId: number) {
  try {
    if (el.hasPointerCapture(pointerId)) {
      el.releasePointerCapture(pointerId)
    }
  } catch {
    // Already released or invalid id
  }
}

onMounted(() => {
  const parentEl = parentContainer.value
  if (parentEl) {
    resizeObservedParent = parentEl
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        containerWidth.value = entry.contentRect.width
        containerHeight.value = entry.contentRect.height
      }
    })
    resizeObserver.observe(parentEl)
    containerWidth.value = parentEl.clientWidth
    containerHeight.value = parentEl.clientHeight
  }

  drawCanvas()
  if (props.imageUrl && props.imageUrl.trim() !== '') {
    nextTick(() => {
      if (sourceImage.value) {
        sourceImage.value.src = props.imageUrl
      }
    })
  }
})

onUnmounted(() => {
  if (resizeObserver) {
    if (resizeObservedParent) {
      resizeObserver.unobserve(resizeObservedParent)
    }
    resizeObserver.disconnect()
    resizeObserver = null
    resizeObservedParent = null
  }
})

// Canvas display size (scaled to fit parent container width, height calculated from aspect ratio)
const canvasScale = computed(() => {
  if (!props.targetWidth || !props.targetHeight || !containerWidth.value) return 1
  // Use container width minus some padding (e.g., 20px on each side)
  const availableWidth = containerWidth.value - 40
  // Calculate scale based on width only
  const scale = availableWidth / props.targetWidth
  // Don't scale up beyond 1:1
  return Math.min(scale, 1)
})

const canvasDisplayWidth = computed(() => props.targetWidth * canvasScale.value)
const canvasDisplayHeight = computed(() => {
  if (!props.targetWidth || !props.targetHeight) return 0
  // Calculate height based on scaled width and target aspect ratio
  return (canvasDisplayWidth.value / props.targetWidth) * props.targetHeight
})

// Image position and size (in target resolution coordinates)
const imageX = ref(0)
const imageY = ref(0)
const imageWidth = ref(0)
const imageHeight = ref(0)

// Cursor state
const canvasCursor = ref('default')

// Crop state (relative to image position, in canvas coordinates)
const cropX = ref(0)
const cropY = ref(0)
const cropWidth = ref(0)
const cropHeight = ref(0)

// Drag state
const isDragging = ref(false)
const isResizing = ref(false)
const isCropping = ref(false)
const cropHandle = ref<'left' | 'right' | 'top' | 'bottom' | null>(null)

// Flag to prevent prop sync watch from updating during our own emits
const isEmitting = ref(false)
const dragStartX = ref(0)
const dragStartY = ref(0)
const dragStartImageX = ref(0)
const dragStartImageY = ref(0)
const resizeStartWidth = ref(0)
const resizeStartHeight = ref(0)
const resizeStartX = ref(0)
const resizeStartY = ref(0)
const cropStartX = ref(0)
const cropStartY = ref(0)
const cropStartWidth = ref(0)
const cropStartHeight = ref(0)
const resizeStartCropX = ref(0)
const resizeStartCropY = ref(0)
const resizeStartCropWidth = ref(0)
const resizeStartCropHeight = ref(0)

// Calculate scale factor from displayed image size vs original size
// The scale is based on the full displayed image (imageWidth x imageHeight)
// which represents the scaled image before cropping
// Example: 1000x1000 original -> scale 0.3 -> 300x300 displayed -> crop to 300x200
const scaleBy = computed(() => {
  if (
    !sourceImageWidth.value ||
    !imageWidth.value ||
    !sourceImageHeight.value ||
    !imageHeight.value
  )
    return 1.0
  // Calculate scale factors for both dimensions based on displayed image size
  const scaleX = imageWidth.value / sourceImageWidth.value
  const scaleY = imageHeight.value / sourceImageHeight.value
  // Use the larger scale to ensure the scaled image contains the crop region
  // This ensures we can crop the desired region from the scaled image
  const scale = Math.max(scaleX, scaleY)
  // Don't scale up beyond 1.0
  return Math.min(scale, 1.0)
})

// Calculate padding values from cropped image position
// Padding is relative to the cropped region, not the full displayed image
// The cropped image is positioned at (imageX + cropX, imageY + cropY) with size (cropWidth, cropHeight)
const computedLeft = computed(() => Math.max(0, Math.round(imageX.value + cropX.value)))
const computedTop = computed(() => Math.max(0, Math.round(imageY.value + cropY.value)))
const computedRight = computed(() =>
  Math.max(0, Math.round(props.targetWidth - (imageX.value + cropX.value + cropWidth.value))),
)
const bottom = computed(() =>
  Math.max(0, Math.round(props.targetHeight - (imageY.value + cropY.value + cropHeight.value))),
)

// Emit all calculated values to parent component
// This is called explicitly when interactions end or image loads
function emitAllValues() {
  if (!imageLoaded.value) return

  isEmitting.value = true

  const l = computedLeft.value
  const t = computedTop.value
  const r = computedRight.value
  const b = bottom.value
  const scale = scaleBy.value
  const cw = Math.round(cropWidth.value)
  const ch = Math.round(cropHeight.value)
  const cx = Math.round(cropX.value)
  const cy = Math.round(cropY.value)

  emits('update:left', l)
  emits('update:top', t)
  emits('update:right', r)
  emits('update:bottom', b)
  emits('update:scaleBy', scale)
  emits('update:cropWidth', cw)
  emits('update:cropHeight', ch)
  emits('update:cropX', cx)
  emits('update:cropY', cy)

  isEmitting.value = false

  // Emit preview image
  emitPreviewImage()
  emitCompositeForOvmsUpload()
}

/** PNG with alpha: transparent outside the placed image so Comfy/OVMS treat borders as mask. */
function emitCompositeForOvmsUpload() {
  if (!sourceImage.value || !imageLoaded.value) return

  const c = document.createElement('canvas')
  c.width = props.targetWidth
  c.height = props.targetHeight
  const ctx = c.getContext('2d')
  if (!ctx) return

  ctx.clearRect(0, 0, c.width, c.height)

  const sourceCropX = (cropX.value / imageWidth.value) * sourceImageWidth.value
  const sourceCropY = (cropY.value / imageHeight.value) * sourceImageHeight.value
  const sourceCropWidth = (cropWidth.value / imageWidth.value) * sourceImageWidth.value
  const sourceCropHeight = (cropHeight.value / imageHeight.value) * sourceImageHeight.value

  ctx.drawImage(
    sourceImage.value,
    sourceCropX,
    sourceCropY,
    sourceCropWidth,
    sourceCropHeight,
    imageX.value + cropX.value,
    imageY.value + cropY.value,
    cropWidth.value,
    cropHeight.value,
  )

  emits('compositeExport', c.toDataURL('image/png'))
}

// Generate and emit a clean preview image (positioned image without UI elements)
function emitPreviewImage() {
  if (!sourceImage.value || !imageLoaded.value) return

  // Create a preview canvas
  const previewCanvas = document.createElement('canvas')
  previewCanvas.width = props.targetWidth
  previewCanvas.height = props.targetHeight
  const ctx = previewCanvas.getContext('2d')
  if (!ctx) return

  // Draw neutral background
  ctx.fillStyle = '#f5f5f5'
  ctx.fillRect(0, 0, props.targetWidth, props.targetHeight)

  // Draw grid (lighter for preview)
  ctx.strokeStyle = '#e8e8e8'
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

  // Calculate source crop coordinates (in original image pixels)
  const sourceCropX = (cropX.value / imageWidth.value) * sourceImageWidth.value
  const sourceCropY = (cropY.value / imageHeight.value) * sourceImageHeight.value
  const sourceCropWidth = (cropWidth.value / imageWidth.value) * sourceImageWidth.value
  const sourceCropHeight = (cropHeight.value / imageHeight.value) * sourceImageHeight.value

  // Draw the cropped portion of the image
  ctx.drawImage(
    sourceImage.value,
    sourceCropX,
    sourceCropY,
    sourceCropWidth,
    sourceCropHeight,
    imageX.value + cropX.value,
    imageY.value + cropY.value,
    cropWidth.value,
    cropHeight.value,
  )

  // Draw subtle padding indicator (lighter than main canvas)
  ctx.fillStyle = 'rgba(156, 163, 175, 0.15)'

  // Top padding
  if (imageY.value > 0) {
    ctx.fillRect(0, 0, props.targetWidth, imageY.value)
  }
  // Bottom padding
  const imageBottom = imageY.value + imageHeight.value
  if (imageBottom < props.targetHeight) {
    ctx.fillRect(0, imageBottom, props.targetWidth, props.targetHeight - imageBottom)
  }
  // Left padding
  if (imageX.value > 0) {
    ctx.fillRect(0, imageY.value, imageX.value, imageHeight.value)
  }
  // Right padding
  const imageRight = imageX.value + imageWidth.value
  if (imageRight < props.targetWidth) {
    ctx.fillRect(imageRight, imageY.value, props.targetWidth - imageRight, imageHeight.value)
  }

  // Convert to PNG data URI
  const previewDataUri = previewCanvas.toDataURL('image/png')
  emits('update:preview', previewDataUri)
}

// Emit initial values when image loads
watch(imageLoaded, (loaded) => {
  if (loaded) {
    emitAllValues()
    emits('update:feathering', props.feathering)
  }
})

// Watch target resolution changes and recalculate image position
watch([() => props.targetWidth, () => props.targetHeight], () => {
  if (imageLoaded.value) {
    constrainImagePosition()
    // Emit updated values including preview when resolution changes
    emitAllValues()
  }
  drawCanvas()
})

function onImageLoad() {
  if (!sourceImage.value) return

  imageLoaded.value = true
  sourceImageWidth.value = sourceImage.value.naturalWidth
  sourceImageHeight.value = sourceImage.value.naturalHeight

  /** Fit image inside canvas, centered (fallback when preset padding is invalid). */
  const resetCenterFit = () => {
    const scale = Math.min(
      props.targetWidth / sourceImageWidth.value,
      props.targetHeight / sourceImageHeight.value,
      1,
    )
    imageWidth.value = sourceImageWidth.value * scale
    imageHeight.value = sourceImageHeight.value * scale
    imageX.value = (props.targetWidth - imageWidth.value) / 2
    imageY.value = (props.targetHeight - imageHeight.value) / 2
  }

  resetCenterFit()

  // Honor saved padding only when it leaves a usable region (migration / other-resolution presets)
  const hasPaddingHints =
    props.left !== 0 || props.top !== 0 || props.right !== 0 || props.bottom !== 0
  if (hasPaddingHints) {
    const availableWidth = Math.max(0, props.targetWidth - props.left - props.right)
    const availableHeight = Math.max(0, props.targetHeight - props.top - props.bottom)
    if (availableWidth > 0 && availableHeight > 0) {
      imageX.value = props.left
      imageY.value = props.top
      const sizeScale = Math.min(
        availableWidth / sourceImageWidth.value,
        availableHeight / sourceImageHeight.value,
        1,
      )
      imageWidth.value = sourceImageWidth.value * sizeScale
      imageHeight.value = sourceImageHeight.value * sizeScale
    }
  }

  // Initialize crop to full image — must be reapplied after constrain fixes width/height
  cropX.value = 0
  cropY.value = 0
  cropWidth.value = imageWidth.value
  cropHeight.value = imageHeight.value

  constrainImagePosition()
  drawCanvas()
}

function onImageError() {
  imageLoaded.value = false
}

const imageMinSizePx = 64

/** Crop is set before constrain can bump dimensions; align crop whenever image bounds change. */
function syncCropRectangleToImage() {
  const iw = imageWidth.value
  const ih = imageHeight.value
  if (!(iw > 0 && ih > 0)) return

  if (cropWidth.value <= 0 || cropHeight.value <= 0) {
    cropX.value = 0
    cropY.value = 0
    cropWidth.value = iw
    cropHeight.value = ih
    return
  }

  cropX.value = Math.max(0, Math.min(cropX.value, iw - imageMinSizePx))
  cropY.value = Math.max(0, Math.min(cropY.value, ih - imageMinSizePx))
  const maxW = iw - cropX.value
  const maxH = ih - cropY.value
  cropWidth.value = Math.max(imageMinSizePx, Math.min(cropWidth.value, maxW))
  cropHeight.value = Math.max(imageMinSizePx, Math.min(cropHeight.value, maxH))
}

function constrainImagePosition() {
  // Ensure image stays within canvas bounds
  imageX.value = Math.max(0, Math.min(imageX.value, props.targetWidth - imageWidth.value))
  imageY.value = Math.max(0, Math.min(imageY.value, props.targetHeight - imageHeight.value))

  if (imageWidth.value < imageMinSizePx) {
    imageWidth.value = imageMinSizePx
    imageX.value = Math.max(0, Math.min(imageX.value, props.targetWidth - imageMinSizePx))
  }
  if (imageHeight.value < imageMinSizePx) {
    imageHeight.value = imageMinSizePx
    imageY.value = Math.max(0, Math.min(imageY.value, props.targetHeight - imageMinSizePx))
  }

  syncCropRectangleToImage()
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

  // Draw the image if loaded
  if (imageLoaded.value && sourceImage.value) {
    ctx.save()

    // Calculate source crop coordinates (in original image pixels)
    const sourceCropX = (cropX.value / imageWidth.value) * sourceImageWidth.value
    const sourceCropY = (cropY.value / imageHeight.value) * sourceImageHeight.value
    const sourceCropWidth = (cropWidth.value / imageWidth.value) * sourceImageWidth.value
    const sourceCropHeight = (cropHeight.value / imageHeight.value) * sourceImageHeight.value

    // Draw the cropped portion of the image
    ctx.drawImage(
      sourceImage.value,
      sourceCropX,
      sourceCropY,
      sourceCropWidth,
      sourceCropHeight, // Source crop
      imageX.value + cropX.value,
      imageY.value + cropY.value,
      cropWidth.value,
      cropHeight.value, // Destination
    )

    // Grey out the cropped parts
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
    // Top crop
    if (cropY.value > 0) {
      ctx.fillRect(imageX.value, imageY.value, imageWidth.value, cropY.value)
    }
    // Bottom crop
    const cropBottom = cropY.value + cropHeight.value
    if (cropBottom < imageHeight.value) {
      ctx.fillRect(
        imageX.value,
        imageY.value + cropBottom,
        imageWidth.value,
        imageHeight.value - cropBottom,
      )
    }
    // Left crop
    if (cropX.value > 0) {
      ctx.fillRect(imageX.value, imageY.value + cropY.value, cropX.value, cropHeight.value)
    }
    // Right crop
    const cropRight = cropX.value + cropWidth.value
    if (cropRight < imageWidth.value) {
      ctx.fillRect(
        imageX.value + cropRight,
        imageY.value + cropY.value,
        imageWidth.value - cropRight,
        cropHeight.value,
      )
    }

    ctx.restore()
  }

  // Draw padding areas (outpaint regions) - highlight areas outside the image
  ctx.fillStyle = 'rgba(156, 163, 175, 0.3)' // neutral gray with transparency

  if (imageLoaded.value) {
    const primaryStroke = hslFromCssVariable('--primary', '280 98% 50%')

    // Top padding (above the image)
    if (imageY.value > 0) {
      ctx.fillRect(0, 0, props.targetWidth, imageY.value)
    }
    // Bottom padding (below the image)
    const imageBottom = imageY.value + imageHeight.value
    if (imageBottom < props.targetHeight) {
      ctx.fillRect(0, imageBottom, props.targetWidth, props.targetHeight - imageBottom)
    }
    // Left padding (to the left of the image)
    if (imageX.value > 0) {
      ctx.fillRect(0, imageY.value, imageX.value, imageHeight.value)
    }
    // Right padding (to the right of the image)
    const imageRight = imageX.value + imageWidth.value
    if (imageRight < props.targetWidth) {
      ctx.fillRect(imageRight, imageY.value, props.targetWidth - imageRight, imageHeight.value)
    }

    // Draw border around full image
    ctx.strokeStyle = primaryStroke
    ctx.lineWidth = 2
    ctx.strokeRect(imageX.value, imageY.value, imageWidth.value, imageHeight.value)

    // Draw border around crop region
    ctx.strokeStyle = primaryStroke
    ctx.lineWidth = 2
    ctx.setLineDash([4, 4])
    ctx.strokeRect(
      imageX.value + cropX.value,
      imageY.value + cropY.value,
      cropWidth.value,
      cropHeight.value,
    )
    ctx.setLineDash([])

    // Draw resize handle at bottom-right corner (more visible)
    const handleSize = 16
    const handleX = imageX.value + imageWidth.value - handleSize / 2
    const handleY = imageY.value + imageHeight.value - handleSize / 2
    ctx.fillStyle = primaryStroke
    ctx.strokeStyle = 'white'
    ctx.lineWidth = 2
    ctx.fillRect(handleX, handleY, handleSize, handleSize)
    ctx.strokeRect(handleX, handleY, handleSize, handleSize)

    // Draw crop handles (only on edges, not corners)
    const cropHandleSize = 12
    const cropHandles = [
      // Edges only
      {
        x: imageX.value + cropX.value + cropWidth.value / 2,
        y: imageY.value + cropY.value,
        type: 'top',
      },
      {
        x: imageX.value + cropX.value + cropWidth.value / 2,
        y: imageY.value + cropY.value + cropHeight.value,
        type: 'bottom',
      },
      {
        x: imageX.value + cropX.value,
        y: imageY.value + cropY.value + cropHeight.value / 2,
        type: 'left',
      },
      {
        x: imageX.value + cropX.value + cropWidth.value,
        y: imageY.value + cropY.value + cropHeight.value / 2,
        type: 'right',
      },
    ]

    ctx.fillStyle = 'white'
    ctx.strokeStyle = primaryStroke
    ctx.lineWidth = 2
    for (const handle of cropHandles) {
      ctx.fillRect(
        handle.x - cropHandleSize / 2,
        handle.y - cropHandleSize / 2,
        cropHandleSize,
        cropHandleSize,
      )
      ctx.strokeRect(
        handle.x - cropHandleSize / 2,
        handle.y - cropHandleSize / 2,
        cropHandleSize,
        cropHandleSize,
      )
    }
  }
}

function getCanvasCoordinates(e: PointerEvent): { x: number; y: number } | null {
  const el = canvas.value
  if (!el) return null

  const rect = el.getBoundingClientRect()
  if (!rect.width || !rect.height) return null

  const scaleX = props.targetWidth / rect.width
  const scaleY = props.targetHeight / rect.height

  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  }
}

function isPointInImage(x: number, y: number): boolean {
  return (
    x >= imageX.value &&
    x <= imageX.value + imageWidth.value &&
    y >= imageY.value &&
    y <= imageY.value + imageHeight.value
  )
}

function isPointInResizeHandle(x: number, y: number): boolean {
  const handleSize = 16
  const handleX = imageX.value + imageWidth.value - handleSize / 2
  const handleY = imageY.value + imageHeight.value - handleSize / 2

  return x >= handleX && x <= handleX + handleSize && y >= handleY && y <= handleY + handleSize
}

function getCropHandleAt(x: number, y: number): 'left' | 'right' | 'top' | 'bottom' | null {
  const cropHandleSize = 12
  const handles = [
    // Edges only
    {
      x: imageX.value + cropX.value + cropWidth.value / 2,
      y: imageY.value + cropY.value,
      type: 'top' as const,
    },
    {
      x: imageX.value + cropX.value + cropWidth.value / 2,
      y: imageY.value + cropY.value + cropHeight.value,
      type: 'bottom' as const,
    },
    {
      x: imageX.value + cropX.value,
      y: imageY.value + cropY.value + cropHeight.value / 2,
      type: 'left' as const,
    },
    {
      x: imageX.value + cropX.value + cropWidth.value,
      y: imageY.value + cropY.value + cropHeight.value / 2,
      type: 'right' as const,
    },
  ]

  for (const handle of handles) {
    if (
      x >= handle.x - cropHandleSize / 2 &&
      x <= handle.x + cropHandleSize / 2 &&
      y >= handle.y - cropHandleSize / 2 &&
      y <= handle.y + cropHandleSize / 2
    ) {
      return handle.type
    }
  }

  return null
}

function updateCursor(e: PointerEvent) {
  if (!imageLoaded.value || isDragging.value || isResizing.value || isCropping.value) return

  const coords = getCanvasCoordinates(e)
  if (!coords) {
    canvasCursor.value = 'default'
    return
  }

  const cropHandleType = getCropHandleAt(coords.x, coords.y)
  if (cropHandleType) {
    // Set cursor based on crop handle type (edges only)
    if (cropHandleType === 'top' || cropHandleType === 'bottom') {
      canvasCursor.value = 'ns-resize'
    } else if (cropHandleType === 'left' || cropHandleType === 'right') {
      canvasCursor.value = 'ew-resize'
    }
  } else if (isPointInResizeHandle(coords.x, coords.y)) {
    canvasCursor.value = 'nwse-resize'
  } else if (isPointInImage(coords.x, coords.y)) {
    canvasCursor.value = 'move'
  } else {
    canvasCursor.value = 'default'
  }
}

function startDrag(e: PointerEvent) {
  if (!canvas.value || !imageLoaded.value) return

  const coords = getCanvasCoordinates(e)
  if (!coords) return

  // Check if clicking on crop handle
  const cropHandleType = getCropHandleAt(coords.x, coords.y)
  if (cropHandleType) {
    startCrop(e, cropHandleType)
    return
  }

  // Check if clicking on resize handle
  if (isPointInResizeHandle(coords.x, coords.y)) {
    startResize(e)
    return
  }

  // Check if clicking on image
  if (!isPointInImage(coords.x, coords.y)) return

  isDragging.value = true
  dragStartX.value = coords.x
  dragStartY.value = coords.y
  dragStartImageX.value = imageX.value
  dragStartImageY.value = imageY.value

  canvas.value.setPointerCapture(e.pointerId)
  canvas.value.addEventListener('pointermove', onDrag)
  canvas.value.addEventListener('pointerup', finishMoveDrag)
  canvas.value.addEventListener('pointercancel', finishMoveDrag)
}

function onDrag(e: PointerEvent) {
  if (!isDragging.value || !canvas.value) return

  const coords = getCanvasCoordinates(e)
  if (!coords) return

  const deltaX = coords.x - dragStartX.value
  const deltaY = coords.y - dragStartY.value

  imageX.value = dragStartImageX.value + deltaX
  imageY.value = dragStartImageY.value + deltaY

  constrainImagePosition()
  drawCanvas()
}

function finishMoveDrag(e: PointerEvent) {
  if (!isDragging.value) return

  const el = canvas.value
  isDragging.value = false

  if (el) {
    el.removeEventListener('pointermove', onDrag)
    el.removeEventListener('pointerup', finishMoveDrag)
    el.removeEventListener('pointercancel', finishMoveDrag)
    safeReleasePointerCapture(el, e.pointerId)
  }

  emitAllValues()
}

function startResize(e: PointerEvent) {
  if (!canvas.value || !imageLoaded.value) return

  e.stopPropagation()
  isResizing.value = true

  const coords = getCanvasCoordinates(e)
  if (!coords) return

  dragStartX.value = coords.x
  dragStartY.value = coords.y
  resizeStartWidth.value = imageWidth.value
  resizeStartHeight.value = imageHeight.value
  resizeStartX.value = imageX.value
  resizeStartY.value = imageY.value
  // Store crop values at start of resize
  resizeStartCropX.value = cropX.value
  resizeStartCropY.value = cropY.value
  resizeStartCropWidth.value = cropWidth.value
  resizeStartCropHeight.value = cropHeight.value

  canvas.value.setPointerCapture(e.pointerId)
  canvas.value.addEventListener('pointermove', onResize)
  canvas.value.addEventListener('pointerup', finishResize)
  canvas.value.addEventListener('pointercancel', finishResize)
}

function onResize(e: PointerEvent) {
  if (!isResizing.value || !canvas.value) return

  const coords = getCanvasCoordinates(e)
  if (!coords) return

  const deltaX = coords.x - dragStartX.value

  // Calculate new size maintaining aspect ratio
  const aspectRatio = sourceImageWidth.value / sourceImageHeight.value
  const newWidth = Math.max(
    64,
    Math.min(resizeStartWidth.value + deltaX, props.targetWidth - resizeStartX.value),
  )
  const newHeight = newWidth / aspectRatio

  // Calculate scale factors for crop adjustment
  const scaleX = newWidth / resizeStartWidth.value
  const scaleY = newHeight / resizeStartHeight.value

  // Check if height fits
  if (newHeight > props.targetHeight - resizeStartY.value) {
    const constrainedHeight = props.targetHeight - resizeStartY.value
    imageHeight.value = constrainedHeight
    imageWidth.value = constrainedHeight * aspectRatio
    const finalScaleY = constrainedHeight / resizeStartHeight.value
    // Adjust crop values proportionally from start values
    cropX.value = Math.max(0, Math.min(resizeStartCropX.value * scaleX, imageWidth.value - 64))
    cropY.value = Math.max(
      0,
      Math.min(resizeStartCropY.value * finalScaleY, imageHeight.value - 64),
    )
    cropWidth.value = Math.max(
      64,
      Math.min(resizeStartCropWidth.value * scaleX, imageWidth.value - cropX.value),
    )
    cropHeight.value = Math.max(
      64,
      Math.min(resizeStartCropHeight.value * finalScaleY, imageHeight.value - cropY.value),
    )
  } else {
    imageWidth.value = newWidth
    imageHeight.value = newHeight
    // Adjust crop values proportionally from start values
    cropX.value = Math.max(0, Math.min(resizeStartCropX.value * scaleX, imageWidth.value - 64))
    cropY.value = Math.max(0, Math.min(resizeStartCropY.value * scaleY, imageHeight.value - 64))
    cropWidth.value = Math.max(
      64,
      Math.min(resizeStartCropWidth.value * scaleX, imageWidth.value - cropX.value),
    )
    cropHeight.value = Math.max(
      64,
      Math.min(resizeStartCropHeight.value * scaleY, imageHeight.value - cropY.value),
    )
  }

  constrainImagePosition()
  drawCanvas()
}

function finishResize(e: PointerEvent) {
  if (!isResizing.value) return

  const el = canvas.value
  isResizing.value = false

  if (el) {
    el.removeEventListener('pointermove', onResize)
    el.removeEventListener('pointerup', finishResize)
    el.removeEventListener('pointercancel', finishResize)
    safeReleasePointerCapture(el, e.pointerId)
  }

  emitAllValues()
}

function startCrop(e: PointerEvent, handleType: 'left' | 'right' | 'top' | 'bottom') {
  if (!canvas.value || !imageLoaded.value) return

  e.stopPropagation()
  isCropping.value = true
  cropHandle.value = handleType

  const coords = getCanvasCoordinates(e)
  if (!coords) return

  cropStartX.value = cropX.value
  cropStartY.value = cropY.value
  cropStartWidth.value = cropWidth.value
  cropStartHeight.value = cropHeight.value
  dragStartX.value = coords.x
  dragStartY.value = coords.y

  canvas.value.setPointerCapture(e.pointerId)
  canvas.value.addEventListener('pointermove', onCrop)
  canvas.value.addEventListener('pointerup', finishCrop)
  canvas.value.addEventListener('pointercancel', finishCrop)
}

function onCrop(e: PointerEvent) {
  if (!isCropping.value || !canvas.value) return

  const coords = getCanvasCoordinates(e)
  if (!coords) return

  const deltaX = coords.x - dragStartX.value
  const deltaY = coords.y - dragStartY.value

  const handle = cropHandle.value
  if (!handle) return

  // Calculate new crop bounds
  let newCropX = cropStartX.value
  let newCropY = cropStartY.value
  let newCropWidth = cropStartWidth.value
  let newCropHeight = cropStartHeight.value

  // Handle edge adjustments only
  if (handle === 'left') {
    newCropX = Math.max(
      0,
      Math.min(cropStartX.value + deltaX, cropStartX.value + cropStartWidth.value - 64),
    )
    newCropWidth = cropStartWidth.value - (newCropX - cropStartX.value)
  } else if (handle === 'right') {
    newCropWidth = Math.max(
      64,
      Math.min(cropStartWidth.value + deltaX, imageWidth.value - cropStartX.value),
    )
  } else if (handle === 'top') {
    newCropY = Math.max(
      0,
      Math.min(cropStartY.value + deltaY, cropStartY.value + cropStartHeight.value - 64),
    )
    newCropHeight = cropStartHeight.value - (newCropY - cropStartY.value)
  } else if (handle === 'bottom') {
    newCropHeight = Math.max(
      64,
      Math.min(cropStartHeight.value + deltaY, imageHeight.value - cropStartY.value),
    )
  }

  // Ensure crop stays within image bounds
  if (newCropX + newCropWidth > imageWidth.value) {
    newCropWidth = imageWidth.value - newCropX
  }
  if (newCropY + newCropHeight > imageHeight.value) {
    newCropHeight = imageHeight.value - newCropY
  }

  cropX.value = newCropX
  cropY.value = newCropY
  cropWidth.value = newCropWidth
  cropHeight.value = newCropHeight

  drawCanvas()
}

function finishCrop(e: PointerEvent) {
  if (!isCropping.value) return

  const el = canvas.value
  isCropping.value = false
  cropHandle.value = null

  if (el) {
    el.removeEventListener('pointermove', onCrop)
    el.removeEventListener('pointerup', finishCrop)
    el.removeEventListener('pointercancel', finishCrop)
    safeReleasePointerCapture(el, e.pointerId)
  }

  emitAllValues()
}

// Watch for image URL changes
watch(
  () => props.imageUrl,
  (newUrl, oldUrl) => {
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
  },
  { immediate: true },
)

// Watch for padding changes from outside (e.g., when preset loads)
// Only update if padding changed externally (not from our own emits)
watch(
  [() => props.left, () => props.top, () => props.right, () => props.bottom],
  ([l, t, r, b]) => {
    if (!imageLoaded.value || isEmitting.value) return

    // Calculate what the padding should be based on current image position
    const currentLeft = Math.max(0, Math.round(imageX.value + cropX.value))
    const currentTop = Math.max(0, Math.round(imageY.value + cropY.value))
    const currentRight = Math.max(
      0,
      Math.round(props.targetWidth - (imageX.value + cropX.value + cropWidth.value)),
    )
    const currentBottom = Math.max(
      0,
      Math.round(props.targetHeight - (imageY.value + cropY.value + cropHeight.value)),
    )

    // Only update if padding changed externally (not from our own emits)
    // Use a small threshold to account for rounding differences
    const threshold = 1
    const paddingChanged =
      Math.abs(l - currentLeft) > threshold ||
      Math.abs(t - currentTop) > threshold ||
      Math.abs(r - currentRight) > threshold ||
      Math.abs(b - currentBottom) > threshold

    if (paddingChanged) {
      // Update position based on padding
      // Padding is relative to the cropped region
      imageX.value = l - cropX.value
      imageY.value = t - cropY.value
      const availableWidth = Math.max(0, props.targetWidth - l - r)
      const availableHeight = Math.max(0, props.targetHeight - t - b)
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
  },
)

watch([imageX, imageY, imageWidth, imageHeight], () => {
  drawCanvas()
})
</script>

<style scoped>
.outpaint-canvas-container {
  width: 100%;
}
</style>
