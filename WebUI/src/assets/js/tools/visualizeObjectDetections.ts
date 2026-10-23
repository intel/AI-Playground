import { tool } from 'ai'
import { z } from 'zod'

// Schema + description only: the boxes are drawn in main
// (`chat/detectionOverlay.ts`), which decodes the turn's image to a raw bitmap
// rather than using a DOM canvas.

export const visualizeObjectDetections = tool({
  description:
    'Use this tool to visualize object detections on an image. When you detect objects in an image and have their labels and bounding box locations (e.g., from a vision model that returns JSON with labels and locations), use this tool to draw bounding boxes and labels on the image for the user to see. The detections should be provided as an array of objects with "label" (string) and "location" ([x1, y1, x2, y2] array of numbers) properties. The location array represents bounding box coordinates where (x1, y1) is the top-left corner and (x2, y2) is the bottom-right corner.',
  inputSchema: z.object({
    detections: z
      .array(
        z.object({
          label: z.string().describe('Label/name of the detected object'),
          location: z
            // A fixed-length array (not z.tuple): tuples compile to JSON Schema
            // with `items` as an array of per-position schemas, which strict
            // validators (Google Gemini's OpenAI-compatible endpoint) reject with
            // "items must be a boolean or an object". `.length(4)` emits a single
            // `items` schema plus min/maxItems, which every provider accepts.
            .array(z.number())
            .length(4)
            .describe(
              'Bounding box coordinates as [x1, y1, x2, y2] where (x1, y1) is top-left and (x2, y2) is bottom-right',
            ),
        }),
      )
      .describe('Array of detected objects with their labels and bounding box locations'),
  }),
  outputSchema: z.object({
    annotatedImageUrl: z.string().describe('PNG data URL of the annotated image'),
  }),
})
