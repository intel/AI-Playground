import { describe, expect, it } from 'vitest'
import {
  ENERGY_PRICE_USD_PER_KWH,
  estimateConversationEnergy,
  integrateGpuEnergyWh,
} from '@/lib/chatEnergy'
import type { ComputeSnapshot } from '@/types/computeMetrics'

function snapshot(ts: number, powerW?: number): ComputeSnapshot {
  return {
    ts,
    source: 'xpu-smi',
    host: { memUsedMiB: 1, memTotalMiB: 2 },
    gpus: [
      {
        id: '0',
        name: 'Intel Arc',
        vendor: 'intel',
        powerW,
      },
    ],
  }
}

describe('integrateGpuEnergyWh', () => {
  it('integrates held board power across a turn', () => {
    expect(integrateGpuEnergyWh([snapshot(0, 100), snapshot(1800, 200)], 0, 3600)).toBeCloseTo(0.15)
  })

  it('clips a sample from before the turn to the turn boundary', () => {
    expect(integrateGpuEnergyWh([snapshot(0, 50)], 1000, 4600)).toBeCloseTo(0.05)
  })

  it('does not invent energy for intervals without power readings', () => {
    expect(
      integrateGpuEnergyWh(
        [snapshot(0), snapshot(1000, 100), snapshot(2000), snapshot(3000, 100)],
        0,
        4000,
      ),
    ).toBeCloseTo(200 / 3600)
    expect(integrateGpuEnergyWh([snapshot(0), snapshot(1000)], 0, 2000)).toBeUndefined()
  })

  it('uses the selected GPU when several adapters are sampled', () => {
    const sample = snapshot(0, 20)
    sample.gpus.push({
      id: '1',
      name: 'Intel Arc B390',
      vendor: 'intel',
      powerW: 80,
    })
    expect(integrateGpuEnergyWh([sample], 0, 3600, 'Arc B390')).toBeCloseTo(0.08)
  })
})

describe('estimateConversationEnergy', () => {
  it('calculates conversation cost per million measured output tokens', () => {
    const result = estimateConversationEnergy([
      {
        role: 'assistant',
        metadata: { energy: { wattHours: 600, outputTokens: 600_000 } },
      },
      {
        role: 'assistant',
        metadata: { energy: { wattHours: 400, outputTokens: 400_000 } },
      },
    ])
    expect(result).toEqual({
      measuredTurns: 2,
      energyWh: 1000,
      outputTokens: 1_000_000,
      costUsd: ENERGY_PRICE_USD_PER_KWH,
      costPerMillionOutputTokensUsd: ENERGY_PRICE_USD_PER_KWH,
    })
  })

  it('excludes turns whose energy or output-token count was unavailable', () => {
    const result = estimateConversationEnergy([
      {
        role: 'assistant',
        metadata: { energy: { wattHours: 2, outputTokens: 100 } },
      },
      {
        role: 'assistant',
        metadata: {},
      },
      {
        role: 'user',
        metadata: { energy: { wattHours: 20, outputTokens: 1000 } },
      },
    ])
    expect(result?.measuredTurns).toBe(1)
    expect(result?.energyWh).toBe(2)
    expect(result?.outputTokens).toBe(100)
    expect(result?.costPerMillionOutputTokensUsd).toBeCloseTo(7)
  })
})
