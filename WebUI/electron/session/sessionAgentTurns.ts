import path from 'node:path'
import { appLoggerInstance } from '../observability/logger'
import { emitSessionChanged } from '../kernel/kernelBus'
import { onGeneratedMedia } from '../agent/generatedMedia'
import type { AgentTurnEnd } from '../agent/agentTurnOutcome'
import { appendHistoryEntry } from './sessionHistory'
import { titleFromPrompt } from './sessionMediaTurn'
import { mutateSession, sessionDocumentOf, sessionPaths } from './sessions'
import type { ArtifactMediaType, HistoryArtifact } from '@/types/sessionIpc'

const MEDIA_TYPES: Record<string, ArtifactMediaType> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.bmp': 'image',
  '.mp4': 'video',
  '.webm': 'video',
  '.mov': 'video',
  '.wav': 'audio',
  '.mp3': 'audio',
  '.ogg': 'audio',
  '.flac': 'audio',
  '.m4a': 'audio',
  '.glb': 'model3d',
  '.gltf': 'model3d',
  '.obj': 'model3d',
}

export type AgentTurnInSession = {
  sessionRef: string
  presetName: string
  workspaceDir: string
  prompt: string
  taskRun?: { taskName: string; stepIndex: number }
}

/** Collects an agent turn's media while it runs; only files inside the Session Folder count. */
export function trackAgentTurnInSession(turn: AgentTurnInSession): {
  settle: (end: AgentTurnEnd) => Promise<void>
} {
  const { root } = sessionPaths(turn.sessionRef)
  const workspace = path.resolve(turn.workspaceDir)
  const artifacts: HistoryArtifact[] = []
  const stop = onGeneratedMedia((workspaceDir, relativePaths, sessionCopies) => {
    if (path.resolve(workspaceDir) !== workspace) return
    const saved =
      sessionCopies.length > 0
        ? sessionCopies
        : relativePaths.map((relativePath) => path.resolve(workspace, relativePath))
    for (const file of saved) {
      const inSession = path.relative(root, path.resolve(file))
      if (inSession.startsWith('..') || path.isAbsolute(inSession)) continue
      const artifactPath = inSession.split(path.sep).join('/')
      const mediaType = MEDIA_TYPES[path.extname(artifactPath).toLowerCase()]
      if (!mediaType || artifacts.some((artifact) => artifact.path === artifactPath)) continue
      artifacts.push({ path: artifactPath, mediaType })
    }
  })
  return {
    settle: async (end) => {
      stop()
      try {
        await appendHistoryEntry(turn.sessionRef, {
          preset: turn.presetName,
          kind: 'agent',
          prompt: turn.prompt,
          status: end.outcome,
          artifacts,
          ...(end.outcome === 'completed' && end.reply ? { response: end.reply } : {}),
          ...(turn.taskRun ? turn.taskRun : {}),
        })
        const file = await mutateSession(turn.sessionRef, (current) => ({
          ...current,
          title: current.renamed || current.title ? current.title : titleFromPrompt(turn.prompt),
          presetsUsed: current.presetsUsed.includes(turn.presetName)
            ? current.presetsUsed
            : [...current.presetsUsed, turn.presetName],
          updatedAt: Math.max(Date.now(), current.updatedAt),
        }))
        emitSessionChanged(sessionDocumentOf(file))
      } catch (error) {
        appLoggerInstance.warn(`agent turn not recorded in its Session: ${error}`, 'sessions')
      }
    },
  }
}
