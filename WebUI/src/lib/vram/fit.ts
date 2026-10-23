import type { VramBudget, VramFit, VramFitBars, VramFitLevel } from './types.ts'
import { GIB } from './units.ts'

/** Fraction of card size treated as usable. The rest covers Vulkan/driver fragmentation. See docs/vram-fit.md. */
export const VRAM_USABLE_FRACTION = 0.9

/** Host RAM to leave for the OS when GPU memory is shared (iGPU). */
export const HOST_RESERVE_BYTES = 4 * GIB

export function emptyCardBudgetBytes(
  memTotalBytes: number,
  fraction = VRAM_USABLE_FRACTION,
): number {
  return Math.max(0, memTotalBytes * fraction)
}

export function liveBudgetBytes(budget: VramBudget, fraction = VRAM_USABLE_FRACTION): number {
  const used = budget.memUsedBytes ?? 0
  const resident = budget.residentEstimateBytes ?? 0
  const freePlusOurs = budget.memTotalBytes - used + resident
  return Math.max(0, Math.min(emptyCardBudgetBytes(budget.memTotalBytes, fraction), freePlusOurs))
}

export function fitVram(requiredBytes: number, budget: VramBudget): VramFit {
  const empty = emptyCardBudgetBytes(budget.memTotalBytes)
  const live = liveBudgetBytes(budget)
  const fit: VramFit = {
    requiredBytes,
    emptyCardBudgetBytes: empty,
    liveBudgetBytes: live,
    fitsEmptyCard: requiredBytes <= empty,
    fitsLive: requiredBytes <= live,
  }
  if (budget.hostFreeBytes !== undefined) {
    const hostUsable = Math.max(0, budget.hostFreeBytes - HOST_RESERVE_BYTES)
    fit.fitsHost = requiredBytes <= hostUsable
  }
  return fit
}

/** Headroom below which a model is called a comfortable fit. First-pass guess, see docs/vram-fit.md. */
export const VRAM_EASY_FRACTION = 0.7

/**
 * Verdict for the model-size chip: `easy` leaves room for the
 * sidecars a turn may pull in, `tight` still loads, `over` does not.
 */
export function vramFitLevel(
  requiredBytes: number,
  usableBytes: number,
  easyFraction = VRAM_EASY_FRACTION,
): VramFitLevel {
  if (usableBytes <= 0 || requiredBytes > usableBytes) return 'over'
  return requiredBytes <= usableBytes * easyFraction ? 'easy' : 'tight'
}

/**
 * How full the chip icon's gauge is: tight fills it, and an easy fit splits at half
 * its threshold so a small model reads as roomier than one that is merely easy.
 */
export function vramFitBars(
  requiredBytes: number,
  usableBytes: number,
  easyFraction = VRAM_EASY_FRACTION,
): VramFitBars {
  const level = vramFitLevel(requiredBytes, usableBytes, easyFraction)
  if (level !== 'easy') return 3
  return requiredBytes <= (usableBytes * easyFraction) / 2 ? 1 : 2
}

/** Whether two resident footprints can share the GPU under the same budget. */
export function bothFit(aBytes: number, bBytes: number, budget: VramBudget): boolean {
  return fitVram(aBytes + bBytes, budget).fitsLive
}
