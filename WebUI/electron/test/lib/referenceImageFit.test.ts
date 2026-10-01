import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  fittedReferenceSize,
  kontextReferenceSize,
  referencePixelBudget,
  referenceSlotToFill,
  scaleToTotalPixels,
} from '@/lib/referenceImageFit'

const here = dirname(fileURLToPath(import.meta.url))

function presetWorkflow(name: string, folder = 'presets'): unknown {
  const path = join(here, '../../../../modes/base', folder, name)
  return JSON.parse(readFileSync(path, 'utf8')).comfyUiApiWorkflow
}

describe('scaleToTotalPixels', () => {
  it('shrinks a camera-sized photo to about 1MP on a 16-pixel grid', () => {
    const fitted = scaleToTotalPixels(4032, 3024, 1, 16)
    expect(fitted.width % 16).toBe(0)
    expect(fitted.height % 16).toBe(0)
    expect(fitted.width * fitted.height).toBeLessThan(1_200_000)
    expect(fitted.width * fitted.height).toBeGreaterThan(900_000)
    expect(fitted).not.toEqual({ width: 4032, height: 3024 })
  })

  it('keeps aspect ratio while rounding to the step', () => {
    const fitted = scaleToTotalPixels(1920, 1080, 1, 16)
    expect(fitted.width / fitted.height).toBeCloseTo(1920 / 1080, 1)
  })
})

describe('kontextReferenceSize', () => {
  it('picks the square bucket for a square image', () => {
    expect(kontextReferenceSize(4000, 4000)).toEqual({ width: 1024, height: 1024 })
  })

  it('picks a wide bucket for a landscape image', () => {
    const fitted = kontextReferenceSize(4032, 2268)
    expect(fitted.width).toBeGreaterThan(fitted.height)
    expect(fitted.width % 16).toBe(0)
    expect(fitted.height % 16).toBe(0)
  })
})

describe('fittedReferenceSize', () => {
  it('uses the Flux2 Klein scale node, not the raw photo', () => {
    const fitted = fittedReferenceSize(4032, 3024, presetWorkflow('flux2-klein-edit.json'))
    expect(fitted).toEqual(scaleToTotalPixels(4032, 3024, 1, 16))
  })

  it('uses Flux Kontext preferred resolutions once the scale node is in the graph', () => {
    const fitted = fittedReferenceSize(3000, 3000, presetWorkflow('flux-kontext.json'))
    expect(fitted).toEqual({ width: 1024, height: 1024 })
  })

  it('leaves presets without a model scale node alone', () => {
    expect(fittedReferenceSize(4000, 3000, { '1': { class_type: 'LoadImage' } })).toBeNull()
  })

  it('only shrinks a video reference that is larger than the generation budget', () => {
    const budget = referencePixelBudget('create-videos', 512, 512)
    expect(fittedReferenceSize(256, 256, undefined, budget)).toBeNull()
    const fitted = fittedReferenceSize(4000, 3000, undefined, budget)
    expect(fitted).not.toBeNull()
    expect(fitted!.width * fitted!.height).toBeLessThan(4000 * 3000)
    expect(referencePixelBudget('edit-images', 512, 512)).toBeUndefined()
  })
})

describe('referenceSlotToFill', () => {
  const slots = [
    { optional: false, value: '' },
    { optional: true, value: '' },
  ]

  it('fills the first required slot when the image is not already bound', () => {
    expect(referenceSlotToFill(slots, 'aipg-media://input/photo.png')).toBe(0)
  })

  it('does not copy a slot-2 load back onto slot 1', () => {
    expect(
      referenceSlotToFill(
        [
          { optional: false, value: 'aipg-media://input/first.png' },
          { optional: true, value: 'aipg-media://input/second.png' },
        ],
        'aipg-media://input/second.png',
      ),
    ).toBeNull()
  })

  it('uses the first slot when every input is optional', () => {
    expect(
      referenceSlotToFill([{ optional: true, value: '' }], 'aipg-media://input/photo.png'),
    ).toBe(0)
  })
})

describe('edit preset workflows', () => {
  it('sizes Edit by Prompt 2 from the scaled reference, on a 16-pixel grid', () => {
    const workflow = presetWorkflow('flux2-klein-edit.json') as Record<
      string,
      { class_type?: string; inputs?: Record<string, unknown> }
    >
    expect(workflow['33'].inputs?.image).toEqual(['12', 0])
    const demo = presetWorkflow('flux2-klein-edit.json', 'demo') as typeof workflow
    expect(demo['33'].inputs?.image).toEqual(['12', 0])
    expect(workflow['12'].class_type).toBe('ImageScaleToTotalPixels')
    for (const graph of [workflow, demo]) {
      for (const node of Object.values(graph)) {
        if (node.class_type === 'ImageScaleToTotalPixels') {
          expect(node.inputs?.resolution_steps).toBe(16)
        }
      }
    }
  })

  it('sizes Edit By Prompt from FluxKontextImageScale', () => {
    const workflow = presetWorkflow('flux-kontext.json') as Record<
      string,
      { class_type?: string; inputs?: Record<string, unknown> }
    >
    expect(workflow['26'].class_type).toBe('FluxKontextImageScale')
    expect(workflow['9'].inputs?.pixels).toEqual(['26', 0])
    expect(workflow['38'].inputs?.image).toEqual(['26', 0])
  })
})
