import { acceptHMRUpdate, defineStore } from 'pinia'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useArtifactRuns } from '@/assets/js/store/artifactRuns'
import { usePresets } from '@/assets/js/store/presets'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching'
import { useSessions } from '@/assets/js/store/sessions'
import { useSessionSettings } from '@/assets/js/store/sessionSettings'
import { useSessionTabs } from '@/assets/js/store/sessionTabs'
import { modelDownloads } from '@/assets/js/models/modelDownloadQueue'
import { downloadPercent } from '@/lib/downloadPercent'
import { sessionRowStatus, type SessionRowStatus } from '@/lib/sessionRowStatus'
import type { SessionTabLanding } from '@/lib/sessionTabs'
import type { SessionDownload } from '@/assets/js/store/recordRows'

/**
 * What happens around a Session's turns: opening one brings back the preset and
 * variant of its last turn, each row shows where its turn stands, and Stop reaches
 * the open Session's turn whichever mode is on screen.
 */
export const useSessionLifecycle = defineStore('sessionLifecycle', () => {
  const sessions = useSessions()
  const sessionSettings = useSessionSettings()
  const presets = usePresets()
  const presetSwitching = usePresetSwitching()
  const agentMode = useAgentMode()
  const artifactRuns = useArtifactRuns()
  const sessionTabs = useSessionTabs()

  async function openSession(
    id: string,
    landing: SessionTabLanding = 'open-session',
  ): Promise<void> {
    if (id === sessions.openSessionId) return sessionTabs.land(landing)
    const last = await sessions.open(id)
    if (sessions.openSessionId === id) sessionTabs.land(landing)
    if (!last || sessions.openSessionId !== id) return
    if (!presets.presets.some((preset) => preset.name === last.preset)) return
    await sessionSettings.whenLoaded()
    const sameVariant = !last.variant || presets.activeVariantName[last.preset] === last.variant
    if (presets.activePresetName === last.preset && sameVariant) return
    await presetSwitching.switchPreset(last.preset, {
      variant: last.variant,
      skipMemoryAlert: true,
    })
  }

  /** A new Session keeps whatever preset is active. */
  async function newSession(groupId?: string): Promise<void> {
    await sessions.create(groupId)
  }

  function downloadOf(group: string | undefined): SessionDownload | null {
    const wait = group ? modelDownloads().snapshot(group) : null
    if (!wait) return null
    return { percent: Math.floor(downloadPercent(wait.progress)), queued: wait.status === 'queued' }
  }

  function agentUnseenFailed(sessionId: string): boolean {
    return Object.values(agentMode.sessions).some(
      (record) => record.sessionRef === sessionId && agentMode.unseenTurns[record.id] === 'failed',
    )
  }

  function rowStatus(sessionId: string): SessionRowStatus {
    const turn = sessions.turns[sessionId]
    const harness = turn?.kind === 'agent' ? turn.harnessSessionId : undefined
    return sessionRowStatus({
      turn,
      agentTurn: harness ? agentMode.sessionTurns[harness] : undefined,
      mediaQueued:
        turn?.kind === 'media' && artifactRuns.state.runs[turn.turnId]?.phase === 'queued',
      mediaQueuePosition:
        turn?.kind === 'media' ? artifactRuns.queuePositions[turn.turnId] : undefined,
      download: downloadOf(harness),
      unseen: sessions.unseen[sessionId]
        ? agentUnseenFailed(sessionId)
          ? 'failed'
          : 'done'
        : undefined,
    })
  }

  /** Stops the open Session's turn by the engine that runs it; false when there is none. */
  async function stopOpenTurn(): Promise<boolean> {
    const turn = sessions.openTurn
    if (!turn) return false
    if (turn.kind === 'agent' && turn.harnessSessionId) {
      await agentMode.stopSession(turn.harnessSessionId)
      return true
    }
    if (turn.kind === 'media') {
      await window.electronAPI.artifact.cancel(turn.turnId)
      return true
    }
    if (turn.kind === 'chat' && turn.conversationKey) {
      await window.electronAPI.chat.cancelTurn(turn.conversationKey, turn.turnId)
      return true
    }
    return false
  }

  return { openSession, newSession, rowStatus, stopOpenTurn }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSessionLifecycle, import.meta.hot))
}
