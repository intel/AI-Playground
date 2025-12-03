import { FilePart, ImagePart, ModelMessage, tool } from 'ai'
import { z } from 'zod'

// Type for detection data
type Detection = {
  label: string
  location: [number, number, number, number] // [x1, y1, x2, y2]
}

/**
 * Converts FilePart data to a data URL string that can be used by Image element
 * Currently only supports data URLs (base64 encoded images)
 */
async function convertFilePartDataToUrl(data: FilePart['data']): Promise<string> {
  if (typeof data === 'string') {
    // Check if it's already a data URL
    if (data.startsWith('data:image/')) {
      return data
    }
    // If it's a regular URL, we can't handle it for now
    throw new Error('Only data URL images are supported. Please ensure the image is provided as a data URL.')
  }

  // For now, only support string data URLs
  throw new Error('Only data URL images (string format) are supported. Received non-string data.')
}

/**
 * Draws bounding boxes and labels on an image
 * @param imageUrl - URL of the source image
 * @param detections - Array of detections with labels and bounding box coordinates
 * @returns Data URL of the annotated image
 */
async function drawDetectionsOnImage(
  imageUrl: string,
  detections: Detection[],
): Promise<string> {
  console.log('[visualizeObjectDetections] drawDetectionsOnImage called', {
    imageUrl,
    imageUrlType: typeof imageUrl,
    detectionsCount: detections.length,
  })

  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'

    img.onload = () => {
      console.log('[visualizeObjectDetections] Image loaded successfully', {
        imageWidth: img.width,
        imageHeight: img.height,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
      })

      // Use natural dimensions to match the original image coordinate system
      // The bounding box coordinates are in the original image's coordinate space
      const imageWidth = img.naturalWidth || img.width
      const imageHeight = img.naturalHeight || img.height

      // Create canvas with same dimensions as original image
      const canvas = document.createElement('canvas')
      canvas.width = imageWidth
      canvas.height = imageHeight
      const ctx = canvas.getContext('2d')

      if (!ctx) {
        console.error('[visualizeObjectDetections] Failed to get canvas context')
        reject(new Error('Failed to get canvas context'))
        return
      }

      console.log('[visualizeObjectDetections] Canvas created', {
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        imageWidth,
        imageHeight,
      })

      // Draw the original image at full natural size
      ctx.drawImage(img, 0, 0, imageWidth, imageHeight)
      console.log('[visualizeObjectDetections] Original image drawn to canvas', {
        drawnWidth: imageWidth,
        drawnHeight: imageHeight,
      })

      // Configure drawing style
      const boxColor = '#00ff00' // Green
      const boxWidth = 2
      const labelBgColor = 'rgba(0, 255, 0, 0.8)' // Semi-transparent green
      const labelTextColor = '#000000' // Black
      const fontSize = Math.max(12, Math.min(imageWidth, imageHeight) / 40) // Responsive font size
      ctx.font = `${fontSize}px Arial`

      console.log('[visualizeObjectDetections] Drawing detections', {
        detectionsCount: detections.length,
        fontSize,
        imageWidth,
        imageHeight,
      })

      // Draw each detection
      detections.forEach((detection, index) => {
        const [x1Relative, y1Relative, x2Relative, y2Relative] = detection.location
        
        // Convert from relative coordinates (0-1000) to pixel coordinates
        // The coordinates are in a 0-1000 range, so we scale them to the actual image dimensions
        const x1 = (x1Relative / 1000) * imageWidth
        const y1 = (y1Relative / 1000) * imageHeight
        const x2 = (x2Relative / 1000) * imageWidth
        const y2 = (y2Relative / 1000) * imageHeight
        
        // Clamp coordinates to ensure they're within image bounds
        const clampedX1 = Math.max(0, Math.min(x1, imageWidth))
        const clampedY1 = Math.max(0, Math.min(y1, imageHeight))
        const clampedX2 = Math.max(0, Math.min(x2, imageWidth))
        const clampedY2 = Math.max(0, Math.min(y2, imageHeight))
        
        console.log(`[visualizeObjectDetections] Drawing detection ${index}`, {
          label: detection.label,
          relativeLocation: [x1Relative, y1Relative, x2Relative, y2Relative],
          pixelLocation: [x1, y1, x2, y2],
          clampedLocation: [clampedX1, clampedY1, clampedX2, clampedY2],
          boxWidth: clampedX2 - clampedX1,
          boxHeight: clampedY2 - clampedY1,
          imageWidth,
          imageHeight,
        })

        // Draw bounding box using clamped pixel coordinates
        ctx.strokeStyle = boxColor
        ctx.lineWidth = boxWidth
        ctx.strokeRect(clampedX1, clampedY1, clampedX2 - clampedX1, clampedY2 - clampedY1)

        // Draw label background
        const labelText = detection.label
        const textMetrics = ctx.measureText(labelText)
        const textWidth = textMetrics.width
        const textHeight = fontSize
        const padding = 4

        // Position label at top-left of bounding box (using clamped coordinates)
        const labelX = clampedX1 + padding * 2
        const labelY = Math.max(0, clampedY1 + textHeight + padding * 2)

        // Draw label background rectangle
        ctx.fillStyle = labelBgColor
        ctx.fillRect(
          labelX - padding,
          labelY - textHeight,
          textWidth + padding * 2,
          textHeight + padding * 2,
        )

        // Draw label text
        ctx.fillStyle = labelTextColor
        ctx.fillText(labelText, labelX, labelY)
      })

      console.log('[visualizeObjectDetections] All detections drawn, converting to data URL')

      // Convert canvas to data URL
      const dataUrl = canvas.toDataURL('image/png')
      console.log('[visualizeObjectDetections] Data URL created', {
        dataUrlLength: dataUrl.length,
        dataUrlPreview: dataUrl.substring(0, 50) + '...',
      })
      resolve(dataUrl)
    }

    img.onerror = (error) => {
      console.error('[visualizeObjectDetections] Image load error', {
        imageUrl,
        error,
        imageSrc: img.src,
      })
      reject(new Error('Failed to load image'))
    }

    console.log('[visualizeObjectDetections] Setting image source', { imageUrl })
    img.src = imageUrl
  })
}

/**
 * Executes the object detection visualization
 */
export async function executeVisualizeObjectDetections(args: {
  detections: Detection[]
}, messages: ModelMessage[]): Promise<{ annotatedImageUrl: string }> {
  console.log('[visualizeObjectDetections] Tool execution started', {
    detectionsCount: args.detections?.length ?? 0,
    messagesCount: messages?.length ?? 0,
    detections: args.detections,
  })

  try {
    // find latest image url from messages
    console.log('[visualizeObjectDetections] Searching for image in messages', {
      messagesLength: messages.length,
      messages: messages.map((msg) => ({
        role: msg.role,
        contentType: typeof msg.content,
        contentLength: Array.isArray(msg.content) ? msg.content.length : 'N/A',
      })),
    })

    const lastUserMessage = messages.findLast((message) => message.role === 'user')
    console.log('[visualizeObjectDetections] Last user message found', {
      found: !!lastUserMessage,
      contentType: typeof lastUserMessage?.content,
      isArray: Array.isArray(lastUserMessage?.content),
      content: lastUserMessage?.content,
    })

    if (typeof lastUserMessage?.content === 'string') {
      console.error('[visualizeObjectDetections] Last user message content is a string, expected array')
      throw new Error('Image is required')
    }

    if (!lastUserMessage || !lastUserMessage.content.some((part) => part.type === 'file' && part.mediaType?.startsWith('image/'))) {
      console.error('[visualizeObjectDetections] No image found in last user message', {
        hasLastUserMessage: !!lastUserMessage,
        contentParts: lastUserMessage?.content?.map((part) => ({
          type: part.type,
          mediaType: 'mediaType' in part ? part.mediaType : 'N/A',
        })),
      })
      throw new Error('Image is required')
    }

    const imagePart = lastUserMessage.content.find(
      (part) => part.type === 'file' && 'mediaType' in part && part.mediaType?.startsWith('image/'),
    ) as FilePart | undefined

    if (!imagePart || !imagePart.data) {
      console.error('[visualizeObjectDetections] Image part or data not found', {
        imagePart,
        hasData: !!imagePart?.data,
      })
      throw new Error('Image data not found')
    }

    console.log('[visualizeObjectDetections] Image part found', {
      imagePart,
      dataType: typeof imagePart.data,
      isUint8Array: imagePart.data instanceof Uint8Array,
      isURL: imagePart.data instanceof URL,
      isString: typeof imagePart.data === 'string',
      isDataUrl: typeof imagePart.data === 'string' && imagePart.data.startsWith('data:image/'),
    })

    const imageUrl = await convertFilePartDataToUrl(imagePart.data)
    console.log('[visualizeObjectDetections] Image URL converted', {
      imageUrl,
      imageUrlType: typeof imageUrl,
      imageUrlLength: imageUrl.length,
      imageUrlPreview: imageUrl.substring(0, 100),
      isDataUrl: imageUrl.startsWith('data:image/'),
    })

    if (!imageUrl || typeof imageUrl !== 'string') {
      console.error('[visualizeObjectDetections] Image URL is invalid', {
        imageUrl,
        imageUrlType: typeof imageUrl,
      })
      throw new Error('Image URL not found')
    }

    // Validate detections
    if (!args.detections || args.detections.length === 0) {
      console.error('[visualizeObjectDetections] No detections provided')
      throw new Error('At least one detection is required')
    }

    console.log('[visualizeObjectDetections] Validating detections', {
      detectionsCount: args.detections.length,
    })

    for (let i = 0; i < args.detections.length; i++) {
      const detection = args.detections[i]
      console.log(`[visualizeObjectDetections] Validating detection ${i}`, {
        detection,
        hasLabel: !!detection.label,
        labelType: typeof detection.label,
        hasLocation: !!detection.location,
        locationType: Array.isArray(detection.location),
        locationLength: Array.isArray(detection.location) ? detection.location.length : 0,
      })

      if (!detection.label || typeof detection.label !== 'string') {
        console.error(`[visualizeObjectDetections] Detection ${i} has invalid label`, { detection })
        throw new Error(`Detection ${i} must have a valid label string`)
      }
      if (
        !Array.isArray(detection.location) ||
        detection.location.length !== 4 ||
        !detection.location.every((coord) => typeof coord === 'number')
      ) {
        console.error(`[visualizeObjectDetections] Detection ${i} has invalid location`, { detection })
        throw new Error(
          `Detection ${i} must have a location array with 4 numbers [x1, y1, x2, y2]`,
        )
      }
    }

    console.log('[visualizeObjectDetections] Starting image annotation', {
      imageUrl,
      detectionsCount: args.detections.length,
    })

    const annotatedImageUrl = await drawDetectionsOnImage(
      imageUrl,
      args.detections,
    )

    console.log('[visualizeObjectDetections] Image annotation completed', {
      annotatedImageUrlLength: annotatedImageUrl?.length ?? 0,
      annotatedImageUrlPreview: annotatedImageUrl?.substring(0, 50) + '...',
    })

    return { annotatedImageUrl }
  } catch (error) {
    console.error('[visualizeObjectDetections] Error during execution', {
      error,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      errorStack: error instanceof Error ? error.stack : undefined,
    })
    throw new Error(
      `Failed to visualize object detections: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}

// Tool definition for AI SDK
export const visualizeObjectDetections = tool({
  description:
    'Use this tool to visualize object detections on an image. When you detect objects in an image and have their labels and bounding box locations (e.g., from a vision model that returns JSON with labels and locations), use this tool to draw bounding boxes and labels on the image for the user to see. The detections should be provided as an array of objects with "label" (string) and "location" ([x1, y1, x2, y2] array of numbers) properties. The location array represents bounding box coordinates where (x1, y1) is the top-left corner and (x2, y2) is the bottom-right corner.',
  inputSchema: z.object({
    detections: z
      .array(
        z.object({
          label: z.string().describe('Label/name of the detected object'),
          location: z
            .tuple([z.number(), z.number(), z.number(), z.number()])
            .describe(
              'Bounding box coordinates as [x1, y1, x2, y2] where (x1, y1) is top-left and (x2, y2) is bottom-right',
            ),
        }),
      )
      .describe(
        'Array of detected objects with their labels and bounding box locations',
      ),
  }),
  execute: async (args: {
    detections: Detection[]
  }, {messages}) => {
    console.log('[visualizeObjectDetections] Tool execute called from AI SDK', {
      args,
      messagesCount: messages?.length ?? 0,
      messagesRoles: messages?.map((m) => m.role) ?? [],
    })
    return await executeVisualizeObjectDetections(args, messages)
  },
})

