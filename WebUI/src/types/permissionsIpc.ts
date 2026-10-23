import { z } from 'zod'

/**
 * Shared types for the kernel permissions surface (architecture-target §4.7,
 * step 13). Named verbs stay (`requestDownload` / `requestVramWarning` /
 * `notify`); grant vocabulary is not this row. The renderer is the dialog
 * adapter; main owns grants and the skip-confirmation decision.
 */

export const PermissionGrantOriginSchema = z.enum(['remember', 'pre-grant'])
export type PermissionGrantOrigin = z.infer<typeof PermissionGrantOriginSchema>

export const PermissionGrantSchema = z.object({
  key: z.string().min(1).max(200),
  origin: PermissionGrantOriginSchema,
  createdAt: z.number(),
})
export type PermissionGrant = z.infer<typeof PermissionGrantSchema>

export const PermissionGrantsFileSchema = z.object({
  schemaVersion: z.literal(1),
  grants: z.record(z.string(), PermissionGrantSchema),
})
export type PermissionGrantsFile = z.infer<typeof PermissionGrantsFileSchema>

export const VRAM_WARNING_GRANT_PREFIX = 'vram-warning:'
export const REMOTE_DOWNLOAD_GRANT = 'download:remote-turns'

export function vramWarningGrantKey(presetName: string): string {
  return VRAM_WARNING_GRANT_PREFIX + presetName
}

export const PermissionsPromptBodySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('is-remote') }),
  z.object({
    kind: z.literal('download'),
    models: z.array(z.unknown()),
    skipConfirmation: z.boolean(),
  }),
  z.object({
    kind: z.literal('vram-warning'),
    presetName: z.string(),
    message: z.string(),
  }),
])
export type PermissionsPromptBody = z.infer<typeof PermissionsPromptBodySchema>

export type PermissionsPromptPayload = PermissionsPromptBody & { requestId: string }

export type PermissionsPromptResponse =
  | { requestId: string; progress: true }
  | { requestId: string; result: unknown }
  // `cancelled` travels with the message because the caller reacts to a
  // declined download by dropping the turn quietly, and an error string cannot
  // carry that across two process hops.
  | { requestId: string; error: string; cancelled?: boolean }
