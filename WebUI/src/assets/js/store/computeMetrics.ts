import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ComputeSnapshot, ComputeWindowStats } from '@/types/computeMetrics'
import { pickPrimaryGpu, summarizeWindow } from '@/lib/computeMetricsWindow'
import { integrateGpuEnergyWh } from '@/lib/chatEnergy'

export const useComputeMetrics = defineStore('computeMetrics', () => {
  const latest = ref<ComputeSnapshot | null>(null)
  const turnStartedAt = ref<number | null>(null)
  const turnSamples = ref<ComputeSnapshot[]>([])

  function applySnapshot(snapshot: ComputeSnapshot) {
    latest.value = snapshot
    if (turnStartedAt.value != null) {
      turnSamples.value = [...turnSamples.value, snapshot]
    }
  }

  function beginTurn() {
    turnStartedAt.value = Date.now()
    turnSamples.value = latest.value ? [latest.value] : []
  }

  function endTurn(hint?: string): ComputeWindowStats | null {
    const stats = turnSamples.value.length > 0 ? summarizeWindow(turnSamples.value, hint) : null
    turnStartedAt.value = null
    turnSamples.value = []
    return stats
  }

  function currentStats(hint?: string): ComputeWindowStats | null {
    if (turnSamples.value.length > 0) return summarizeWindow(turnSamples.value, hint)
    if (latest.value) return summarizeWindow([latest.value], hint)
    return null
  }

  function currentTurnEnergyWh(hint?: string): number | undefined {
    if (turnStartedAt.value === null) return undefined
    return integrateGpuEnergyWh(turnSamples.value, turnStartedAt.value, Date.now(), hint)
  }

  const primaryGpu = computed(() => (latest.value ? pickPrimaryGpu(latest.value.gpus) : undefined))

  /**
   * The sampled GPU a named inference device resolves to — the one a backend was
   * actually pointed at, rather than the card we would have guessed. Falls back to
   * `primaryGpu` when the name matches nothing sampled, or when the selection is a
   * CPU / NPU and so names no GPU at all.
   */
  function gpuFor(deviceName?: string | null) {
    if (!latest.value) return undefined
    return pickPrimaryGpu(latest.value.gpus, deviceName ?? undefined)
  }

  void window.electronAPI.getComputeMetrics().then((snapshot) => {
    if (snapshot) applySnapshot(snapshot)
  })
  window.electronAPI.onComputeMetricsUpdate(applySnapshot)

  return {
    latest,
    primaryGpu,
    gpuFor,
    applySnapshot,
    beginTurn,
    endTurn,
    currentStats,
    currentTurnEnergyWh,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useComputeMetrics, import.meta.hot))
}
