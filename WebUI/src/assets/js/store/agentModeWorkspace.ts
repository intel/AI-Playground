import { computed, ref, type Ref } from 'vue'
import type { GameLibraryEntry } from '@/types/agentIpc'

export type WorkspaceAttachment = { name: string; bytes: ArrayBuffer }

export function createWorkspaceAttachments(errors: {
  report: (error: unknown, overrides: Record<string, unknown>) => void
}) {
  /**
   * Files the user attached for the next turn, still in memory.
   *
   * They are held rather than saved on sight because the folder they belong in
   * may not exist yet: Game Agent mints a game folder from the first prompt, so
   * attaching before sending has nowhere to write to. `importAttachments` puts
   * them in the workspace once `generate` has one.
   */
  const attachments = ref<WorkspaceAttachment[]>([])

  async function attachFiles(files: File[]): Promise<void> {
    const read = await Promise.all(
      files.map(async (file) => ({ name: file.name, bytes: await file.arrayBuffer() })),
    )
    attachments.value = [...attachments.value, ...read]
  }

  function removeAttachment(index: number): void {
    attachments.value = attachments.value.filter((_, i) => i !== index)
  }

  function clearAttachments(): void {
    attachments.value = []
  }

  /**
   * Save the pending attachments into the workspace and return the sentence that
   * tells the agent about them.
   *
   * The agent gets a path, not the bytes: it reads, references and ships
   * workspace files with the tools it already has. Paths go into the prompt as
   * `@`-prefixed workspace-relative paths, which is how a file is referenced in
   * a prompt throughout Pi.
   */
  async function importAttachments(workspaceDir: string): Promise<string> {
    if (attachments.value.length === 0) return ''
    const saved: string[] = []
    for (const attachment of attachments.value) {
      const result = await window.electronAPI.agentMode.importAttachment(
        workspaceDir,
        attachment.name,
        new Uint8Array(attachment.bytes),
      )
      if (result.success && result.path) saved.push(result.path)
      else {
        errors.report(new Error(result.error ?? `Failed to attach ${attachment.name}.`), {
          category: 'unknown',
          code: 'agent/attachment-failed',
          userMessage: `Could not attach ${attachment.name}.`,
          surface: 'toast',
        })
      }
    }
    clearAttachments()
    if (saved.length === 0) return ''
    const references = saved.map((file) => (/\s/.test(file) ? `@"${file}"` : `@${file}`))
    return `\n\nAttached files, saved in the workspace: ${references.join(' ')}`
  }

  return { attachments, attachFiles, removeAttachment, clearAttachments, importAttachments }
}

export async function isGameFolder(dir: string): Promise<boolean> {
  return !!dir && !!(await window.electronAPI.games.read(dir))
}

export function createUnsandboxedWorkspaces(workspaceDir: Ref<string>) {
  const unsandboxedWorkspaces = ref<string[]>([])
  const unsandboxed = computed(
    () => !!workspaceDir.value && unsandboxedWorkspaces.value.includes(workspaceDir.value),
  )

  function setUnsandboxed(enabled: boolean): void {
    const folder = workspaceDir.value
    if (!folder) return
    const others = unsandboxedWorkspaces.value.filter((entry) => entry !== folder)
    unsandboxedWorkspaces.value = enabled ? [...others, folder] : others
  }

  return { unsandboxedWorkspaces, unsandboxed, setUnsandboxed }
}

/**
 * Hand a workspace that is not a game back to the Agent preset it came from,
 * whenever Game Agent is the one holding it.
 */
export async function reconcileGamesWorkspace(options: {
  kind: 'pick' | 'games'
  workspaceDir: string
  lastGamesDir: string
}): Promise<{ workspaceDir: string; pickDir?: string } | null> {
  if (options.kind !== 'games') return null
  if (!options.workspaceDir) return null
  if (await isGameFolder(options.workspaceDir)) return null
  return {
    workspaceDir: options.lastGamesDir ?? '',
    pickDir: options.workspaceDir,
  }
}

export type { GameLibraryEntry }
