import z from 'zod'
import fs from 'node:fs'
import path from 'node:path'

const SamplePromptSchema = z.object({
  title: z.string(),
  description: z.string(),
  prompt: z.string(),
  mode: z.enum(['chat', 'imageGen', 'imageEdit', 'video']),
  presetName: z.string().optional(),
})

export const DemoProfileSchema = z.object({
  defaults: z.object({
    chatPreset: z.string(),
    chatModel: z.string(),
    imageGenPreset: z.string().optional(),
    imageEditPreset: z.string().optional(),
  }),
  inputImage: z.string().nullable().default(null),
  samplePrompts: z.array(SamplePromptSchema).default([]),
  enabledModes: z
    .array(z.enum(['chat', 'imageGen', 'imageEdit', 'video']))
    .default(['chat', 'imageGen', 'imageEdit', 'video']),
  notificationDotButtons: z.array(z.string()).default([]),
})

export type DemoProfile = z.infer<typeof DemoProfileSchema>

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * Loads and validates _profile.json from the given presets directory.
 * If `inputImage` is specified, reads the file and converts to a data URI.
 * Returns null if the file doesn't exist (logs a warning).
 * Throws on malformed JSON or schema validation failure.
 */
export function loadDemoProfile(
  presetsDir: string,
  logger?: { warn: (msg: string, tag: string) => void },
): DemoProfile | null {
  const profilePath = path.join(presetsDir, '_profile.json')

  if (!fs.existsSync(profilePath)) {
    logger?.warn(`Demo mode enabled but no _profile.json found at ${profilePath}`, 'demo-profile')
    return null
  }

  const raw = JSON.parse(fs.readFileSync(profilePath, { encoding: 'utf-8' }))
  const profile = DemoProfileSchema.parse(raw)

  if (profile.inputImage) {
    const imagePath = path.join(presetsDir, profile.inputImage)
    if (!fs.existsSync(imagePath)) {
      throw new Error(
        `Demo profile references inputImage "${profile.inputImage}" but file not found at ${imagePath}`,
      )
    }
    const ext = path.extname(imagePath).toLowerCase()
    const mime = MIME_TYPES[ext]
    if (!mime) {
      throw new Error(
        `Demo profile inputImage "${profile.inputImage}" has unsupported extension "${ext}"`,
      )
    }
    const data = fs.readFileSync(imagePath)
    profile.inputImage = `data:${mime};base64,${data.toString('base64')}`
  }

  return profile
}
