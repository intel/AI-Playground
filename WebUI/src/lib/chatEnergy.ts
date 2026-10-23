import type { ComputeSnapshot } from '@/types/computeMetrics'
import { pickPrimaryGpu } from '@/lib/computeMetricsWindow'

export const CHAT_ENERGY_ESTIMATES_ENABLED = true
export const ENERGY_PRICE_USD_PER_KWH = 0.35

export type ChatTurnEnergy = {
  wattHours: number
  outputTokens: number
}

type EnergyMessage = {
  role: string
  metadata?: {
    energy?: ChatTurnEnergy
  }
}

export type ConversationEnergyEstimate = {
  measuredTurns: number
  energyWh: number
  outputTokens: number
  costUsd: number
  costPerMillionOutputTokensUsd: number
}

export function integrateGpuEnergyWh(
  snapshots: ComputeSnapshot[],
  startMs: number,
  endMs: number,
  gpuHint?: string,
): number | undefined {
  if (endMs <= startMs) return undefined
  const ordered = [...snapshots].sort((a, b) => a.ts - b.ts)
  let cursorMs = startMs
  let heldPowerW: number | undefined
  let energyWattMs = 0
  let measuredMs = 0

  for (const snapshot of ordered) {
    if (snapshot.ts > endMs) break
    const powerW = pickPrimaryGpu(snapshot.gpus, gpuHint)?.powerW
    if (snapshot.ts <= startMs) {
      heldPowerW = validPower(powerW)
      continue
    }
    if (heldPowerW !== undefined) {
      const durationMs = snapshot.ts - cursorMs
      energyWattMs += heldPowerW * durationMs
      measuredMs += durationMs
    }
    cursorMs = snapshot.ts
    heldPowerW = validPower(powerW)
  }

  if (heldPowerW !== undefined && cursorMs < endMs) {
    const durationMs = endMs - cursorMs
    energyWattMs += heldPowerW * durationMs
    measuredMs += durationMs
  }
  return measuredMs > 0 ? energyWattMs / 3_600_000 : undefined
}

export function estimateConversationEnergy(
  messages: EnergyMessage[],
): ConversationEnergyEstimate | undefined {
  let measuredTurns = 0
  let energyWh = 0
  let outputTokens = 0
  for (const message of messages) {
    const turnEnergyWh = message.metadata?.energy?.wattHours
    const turnOutputTokens = message.metadata?.energy?.outputTokens
    if (
      message.role !== 'assistant' ||
      turnEnergyWh === undefined ||
      turnOutputTokens === undefined ||
      turnOutputTokens <= 0
    ) {
      continue
    }
    measuredTurns++
    energyWh += Math.max(0, turnEnergyWh)
    outputTokens += turnOutputTokens
  }
  if (measuredTurns === 0 || outputTokens === 0) return undefined
  const costUsd = (energyWh / 1000) * ENERGY_PRICE_USD_PER_KWH
  return {
    measuredTurns,
    energyWh,
    outputTokens,
    costUsd,
    costPerMillionOutputTokensUsd: (costUsd / outputTokens) * 1_000_000,
  }
}

function validPower(powerW: number | undefined): number | undefined {
  return powerW !== undefined && Number.isFinite(powerW) && powerW >= 0 ? powerW : undefined
}
