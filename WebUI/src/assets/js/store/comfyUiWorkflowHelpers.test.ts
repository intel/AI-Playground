import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComfyUIApiWorkflow } from './presets'
import { isNodeLink, modifySettingInWorkflow } from './comfyUiWorkflowHelpers'

describe('isNodeLink', () => {
  it('recognizes [nodeId, slot] tuples', () => {
    expect(isNodeLink(['128', 0])).toBe(true)
    expect(isNodeLink(['85', 3])).toBe(true)
  })

  it('rejects scalars and malformed arrays', () => {
    expect(isNodeLink(4)).toBe(false)
    expect(isNodeLink('128')).toBe(false)
    expect(isNodeLink(null)).toBe(false)
    expect(isNodeLink([])).toBe(false)
    expect(isNodeLink(['128'])).toBe(false)
    expect(isNodeLink(['128', 0, 0])).toBe(false)
    expect(isNodeLink([128, 0])).toBe(false)
    expect(isNodeLink(['128', '0'])).toBe(false)
  })
})

describe('modifySettingInWorkflow', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let debugSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    debugSpy.mockRestore()
  })

  it('overwrites a scalar input value', () => {
    const workflow: ComfyUIApiWorkflow = {
      '1': {
        class_type: 'KSampler',
        inputs: { steps: 10 },
        _meta: { title: 'KSampler' },
      },
    }
    modifySettingInWorkflow(workflow, 'inferenceSteps', 25)
    expect(workflow['1'].inputs?.steps).toBe(25)
  })

  it('does NOT overwrite an input that holds a graph link (Wan 2.2 Quality bug)', () => {
    // Mirrors the Wan2.2-14B-i2v.json Quality variant shape:
    //   PrimitiveInt 128 "Steps" feeds both KSampler.steps via the link ["128", 0].
    // Pre-fix, `modifySettingInWorkflow('inferenceSteps', 4)` would stomp the link
    // on the first matching KSampler, silently disconnecting the PrimitiveInt.
    const workflow: ComfyUIApiWorkflow = {
      '85': {
        class_type: 'KSamplerAdvanced',
        inputs: { steps: ['128', 0] as unknown as number },
        _meta: { title: 'KSampler (Low Noise)' },
      },
      '86': {
        class_type: 'KSamplerAdvanced',
        inputs: { steps: ['128', 0] as unknown as number },
        _meta: { title: 'KSampler (High Noise)' },
      },
      '128': {
        class_type: 'PrimitiveInt',
        inputs: { value: 20 },
        _meta: { title: 'Steps' },
      },
    }
    modifySettingInWorkflow(workflow, 'inferenceSteps', 4)
    expect(workflow['85'].inputs?.steps).toEqual(['128', 0])
    expect(workflow['86'].inputs?.steps).toEqual(['128', 0])
    expect(workflow['128'].inputs?.value).toBe(20)
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipping write for setting 'inferenceSteps'"),
    )
  })

  it('writes a scalar when the title matches the setting name', () => {
    const workflow: ComfyUIApiWorkflow = {
      '1': {
        class_type: 'KSampler',
        inputs: { steps: 10 },
        _meta: { title: 'inferenceSteps' },
      },
    }
    modifySettingInWorkflow(workflow, 'inferenceSteps', 30)
    expect(workflow['1'].inputs?.steps).toBe(30)
  })

  it('logs a warning when multiple matching scalar nodes exist and writes the first', () => {
    const workflow: ComfyUIApiWorkflow = {
      '1': {
        class_type: 'KSampler',
        inputs: { steps: 10 },
        _meta: { title: 'KSampler A' },
      },
      '2': {
        class_type: 'KSampler',
        inputs: { steps: 10 },
        _meta: { title: 'KSampler B' },
      },
    }
    modifySettingInWorkflow(workflow, 'inferenceSteps', 7)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Multiple keys found for setting inferenceSteps'),
    )
    expect(workflow['1'].inputs?.steps).toBe(7)
    expect(workflow['2'].inputs?.steps).toBe(10)
  })

  it('warns and no-ops when no matching node exists', () => {
    const workflow: ComfyUIApiWorkflow = {
      '1': {
        class_type: 'CLIPLoader',
        inputs: { clip_name: 'foo' },
        _meta: { title: 'Load CLIP' },
      },
    }
    modifySettingInWorkflow(workflow, 'inferenceSteps', 7)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('No key found for setting inferenceSteps'),
    )
    expect(workflow['1'].inputs?.clip_name).toBe('foo')
  })

  it('falls back to inputs.a when the targeted scalar input is absent', () => {
    const workflow: ComfyUIApiWorkflow = {
      '1': {
        class_type: 'IntAddition',
        inputs: { a: 5, b: 3 },
        _meta: { title: 'inferenceSteps' },
      },
    }
    modifySettingInWorkflow(workflow, 'inferenceSteps', 9)
    expect(workflow['1'].inputs?.a).toBe(9)
    expect(workflow['1'].inputs?.b).toBe(3)
  })

  it('prefers a title match over an inputs-name match (flux width/height pattern)', () => {
    // Mirrors flux.json: an `IntMathOperation` titled "width" holds the scalar value
    // that drives EmptyLatentImage.width via a link. The static write must land on
    // the title-matched scalar, not on the linked EmptyLatentImage.
    const workflow: ComfyUIApiWorkflow = {
      '8': {
        class_type: 'EmptyFlux2LatentImage',
        inputs: { width: ['16', 0] as unknown as number, batch_size: 1 },
        _meta: { title: 'EmptyFlux2LatentImage' },
      },
      '16': {
        class_type: 'IntMathOperation',
        inputs: { a: 1248, b: 0, operation: 'add' },
        _meta: { title: 'width' },
      },
    }
    modifySettingInWorkflow(workflow, 'width', 768)
    expect(workflow['16'].inputs?.a).toBe(768)
    expect(workflow['8'].inputs?.width).toEqual(['16', 0])
  })

  it('does NOT overwrite inputs.a when it holds a graph link', () => {
    const workflow: ComfyUIApiWorkflow = {
      '1': {
        class_type: 'IntAddition',
        inputs: { a: ['2', 0] as unknown as number, b: 3 },
        _meta: { title: 'inferenceSteps' },
      },
      '2': {
        class_type: 'PrimitiveInt',
        inputs: { value: 12 },
        _meta: { title: 'Source' },
      },
    }
    modifySettingInWorkflow(workflow, 'inferenceSteps', 9)
    expect(workflow['1'].inputs?.a).toEqual(['2', 0])
  })
})
