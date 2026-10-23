import type { ModelMessage } from 'ai'
import { filePartToDataUri, findLatestAttachment, type MediaReader } from './chatFileParts'
import { trackChatToolActivity } from './chatToolActivity'
import { drawDetections, type Detection } from './detectionOverlay'

/**
 * Main-side body for `visualizeObjectDetections`: take the turn's most recent
 * image, draw the model's boxes on it, hand back a PNG data URL.
 */

export function validateDetections(input: unknown): Detection[] {
  const detections = (input as { detections?: unknown })?.detections
  if (!Array.isArray(detections) || detections.length === 0) {
    throw new Error('At least one detection is required')
  }
  return detections.map((raw, index) => {
    const detection = raw as Partial<Detection>
    if (!detection.label || typeof detection.label !== 'string') {
      throw new Error(`Detection ${index} must have a valid label string`)
    }
    if (
      !Array.isArray(detection.location) ||
      detection.location.length !== 4 ||
      !detection.location.every((coord) => typeof coord === 'number')
    ) {
      throw new Error(
        `Detection ${index} must have a location array with 4 numbers [x1, y1, x2, y2]`,
      )
    }
    return { label: detection.label, location: detection.location }
  })
}

export async function executeChatDetectionsTool(options: {
  input: unknown
  conversationKey: string
  messages?: ModelMessage[]
  readMediaAsDataUri: MediaReader
}): Promise<{ annotatedImageUrl: string }> {
  return await trackChatToolActivity(
    {
      category: 'tools',
      label: 'Drawing detections…',
      conversationKey: options.conversationKey,
    },
    async () => {
      const detections = validateDetections(options.input)
      const imagePart = findLatestAttachment(options.messages, 'image/')
      if (!imagePart?.data) {
        throw new Error('Image is required - no image found in conversation')
      }
      const imageDataUri = await filePartToDataUri(
        imagePart.data,
        imagePart.mediaType,
        options.readMediaAsDataUri,
      )
      return { annotatedImageUrl: drawDetections(imageDataUri, detections) }
    },
  )
}
