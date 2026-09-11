import fs from 'node:fs'
import path from 'node:path'

// ── Workspace attachments ────────────────────────────────────────────────────
//
// What "attach a file" means for an agent, as opposed to a chat: the file is
// copied into the workspace and the agent is told the path. It then reads,
// references or ships the file with the tools it already has — a PNG becomes a
// sprite the game loads, a text file becomes something it can read — and this
// works whatever the model is, where sending the bytes to the model would need
// a vision-capable one and still leave the file out of the workspace.

/** Folder inside the workspace that user-supplied files land in. */
export const ATTACHMENTS_DIR = 'attachments'

/**
 * Reduce a client-supplied filename to a bare, safe basename.
 *
 * The name comes from the renderer, so it is untrusted: anything that could walk
 * out of the folder (separators, `..`, a drive letter) has to go before it is
 * joined onto the workspace path.
 */
function safeBasename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  const cleaned = base.replace(/[\0-\x1f<>:"|?*]/g, '').replace(/^\.+/, '')
  return cleaned || 'attachment'
}

/** `sprite.png` → `sprite-2.png`, so a second attachment cannot overwrite the first. */
function uniquePath(dir: string, filename: string): string {
  const extension = path.extname(filename)
  const stem = path.basename(filename, extension)
  let candidate = filename
  for (let n = 2; fs.existsSync(path.join(dir, candidate)); n++) {
    candidate = `${stem}-${n}${extension}`
  }
  return path.join(dir, candidate)
}

/**
 * Save one attachment into the workspace and return its workspace-relative path
 * (POSIX separators, which is how every tool and the preview server address
 * workspace files).
 */
export function importAttachment(
  workspaceDir: string,
  name: string,
  bytes: Uint8Array,
): { path: string } {
  const root = fs.realpathSync(path.resolve(workspaceDir))
  const dir = path.join(root, ATTACHMENTS_DIR)
  fs.mkdirSync(dir, { recursive: true })

  const target = uniquePath(dir, safeBasename(name))
  // Belt and braces: `safeBasename` already removed the ways out of the folder,
  // so a target outside it means that sanitizing has a hole rather than that the
  // caller asked for something reasonable.
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write an attachment outside the workspace: ${name}`)
  }

  fs.writeFileSync(target, bytes)
  return { path: relative.split(path.sep).join('/') }
}
