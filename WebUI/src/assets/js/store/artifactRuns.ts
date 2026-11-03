import { acceptHMRUpdate, defineStore } from 'pinia'
import { shallowRef } from 'vue'
import { connectKernelEventStream } from '@/assets/js/projection/kernelProjection'
import {
  applyArtifactEvent,
  applyArtifactSnapshot,
  artifactPhaseLabel,
  emptyArtifactRuns,
  runsOwnedBy,
  toolMediaView,
  type ArtifactRunView,
  type ToolMediaView,
} from '@/lib/artifactRunProjection'
import { useI18N } from './i18n'

// Live artifact runs by run id, owner-stamped by main. Tool cards (Chat, Agent
// Mode, the media specialist timeline) read their own runs from here.

export const useArtifactRuns = defineStore('artifactRuns', () => {
  const i18nState = useI18N().state

  const state = shallowRef(emptyArtifactRuns())
  const queuePositions = shallowRef<Record<string, number>>({})

  const projection = connectKernelEventStream(
    (event) => {
      if (
        event.type === 'artifact-phase' ||
        event.type === 'artifact-item' ||
        event.type === 'artifact-done'
      ) {
        state.value = applyArtifactEvent(state.value, event)
      } else if (event.type === 'queue-event' && event.kind === 'artifact') {
        const { [event.runKey]: _left, ...rest } = queuePositions.value
        queuePositions.value =
          event.position === undefined ? rest : { ...rest, [event.runKey]: event.position }
      }
    },
    (snapshot) => {
      state.value = applyArtifactSnapshot(state.value, snapshot.state.activeArtifactRun)
    },
  )
  projection.ready.catch((reason: unknown) => {
    console.warn('artifact run snapshot unavailable; waiting on stream events instead', reason)
  })
  if (import.meta.hot) {
    import.meta.hot.dispose(() => projection.dispose())
  }

  function ownedBy(toolCallId: string | undefined): ArtifactRunView[] {
    return toolCallId ? runsOwnedBy(state.value, toolCallId) : []
  }

  function viewFor(toolCallId: string | undefined): ToolMediaView {
    return toolMediaView(ownedBy(toolCallId))
  }

  function labelFor(view: Pick<ToolMediaView, 'phase' | 'progress'>): string | undefined {
    return artifactPhaseLabel(view.phase, view.progress, i18nState)
  }

  return { state, queuePositions, ownedBy, viewFor, labelFor }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useArtifactRuns, import.meta.hot))
}
