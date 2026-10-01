import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import z from 'zod'
import {
  OVMS_MTP_ASSISTANT_TOKENS,
  OVMS_MTP_DRAFT_PATH,
  claimOvmsMtpStaleNotice,
  ovmsMtpLaunchArgs,
  ovmsMtpRequestFields,
  resolveOvmsMtpLaunch,
} from '@/lib/ovmsMtp'
import { ModelSchema } from '@/types/shared'

describe('resolveOvmsMtpLaunch', () => {
  it('passes `.` when the MTP graph is already there', () => {
    expect(
      resolveOvmsMtpLaunch({
        enableMtp: true,
        deviceId: 'GPU.0',
        folderExists: true,
        mtpGraphExists: true,
      }),
    ).toEqual({ draftModelPath: '.', stale: false })
    expect(OVMS_MTP_DRAFT_PATH).toBe('.')
  })

  it('passes `.` on a first download, before the folder exists', () => {
    expect(
      resolveOvmsMtpLaunch({
        enableMtp: true,
        deviceId: 'GPU',
        folderExists: false,
        mtpGraphExists: false,
      }),
    ).toEqual({ draftModelPath: '.', stale: false })
  })

  it('starts without MTP and asks for a re-download when the snapshot has no graph', () => {
    expect(
      resolveOvmsMtpLaunch({
        enableMtp: true,
        deviceId: 'CPU',
        folderExists: true,
        mtpGraphExists: false,
      }),
    ).toEqual({ draftModelPath: null, stale: true })
  })

  it('leaves MTP off on NPU even when the graph is missing', () => {
    expect(
      resolveOvmsMtpLaunch({
        enableMtp: true,
        deviceId: 'NPU',
        folderExists: true,
        mtpGraphExists: false,
      }),
    ).toEqual({ draftModelPath: null, stale: false })
  })

  it('leaves MTP off for a model that does not ship the graph', () => {
    expect(
      resolveOvmsMtpLaunch({
        enableMtp: false,
        deviceId: 'GPU.0',
        folderExists: true,
        mtpGraphExists: false,
      }),
    ).toEqual({ draftModelPath: null, stale: false })
  })
})

describe('ovmsMtpLaunchArgs', () => {
  it('passes the demo draft path and turns prefix caching off', () => {
    expect(ovmsMtpLaunchArgs('.')).toEqual([
      '--draft_model_path',
      '.',
      '--enable_prefix_caching',
      'false',
    ])
  })

  it('adds nothing when MTP is not armed, so prefix caching stays at the server default', () => {
    expect(ovmsMtpLaunchArgs(null)).toEqual([])
  })
})

describe('ovmsMtpRequestFields', () => {
  it('asks for 2 drafted tokens only when that launch armed MTP', () => {
    expect(ovmsMtpRequestFields(true)).toEqual({
      num_assistant_tokens: OVMS_MTP_ASSISTANT_TOKENS,
    })
    expect(OVMS_MTP_ASSISTANT_TOKENS).toBe(2)
    expect(ovmsMtpRequestFields(false)).toEqual({})
    expect(ovmsMtpRequestFields(true).num_assistant_tokens).not.toBe(5)
  })
})

describe('claimOvmsMtpStaleNotice', () => {
  function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { values: Map<string, string> } {
    const values = new Map<string, string>()
    return {
      values,
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value)
      },
    }
  }

  it('shows the warning once per model repo', () => {
    const storage = memoryStorage()
    expect(claimOvmsMtpStaleNotice('OpenVINO/Qwen3.5-9B-int4-ov', storage)).toBe(true)
    expect(claimOvmsMtpStaleNotice('OpenVINO/Qwen3.5-9B-int4-ov', storage)).toBe(false)
    expect(claimOvmsMtpStaleNotice('OpenVINO/Qwen3.8-27B-int4-ov', storage)).toBe(true)
    expect(claimOvmsMtpStaleNotice(undefined, storage)).toBe(false)
  })
})

describe('OpenVINO catalog MTP', () => {
  const models = z
    .array(ModelSchema)
    .parse(
      JSON.parse(readFileSync(path.resolve(__dirname, '../../../external/models.json'), 'utf-8')),
    )

  it('enables MTP on the Qwen OpenVINO repos that ship the graph', () => {
    const repos = [
      'OpenVINO/Qwen3.5-4B-int4-ov',
      'OpenVINO/Qwen3.5-9B-int4-ov',
      'OpenVINO/Qwen3.8-27B-int4-ov',
      'OpenVINO/Qwen3.6-35B-A3B-int4-ov',
    ]
    for (const name of repos) {
      const model = models.find((entry) => entry.name === name)
      expect(model?.enableMtp, name).toBe(true)
    }
  })

  it('adds Gemma 4 without MTP and with gemma4 parsers', () => {
    const gemma = models.filter((entry) => entry.name.startsWith('OpenVINO/gemma-4-'))
    expect(gemma.map((entry) => entry.name).sort()).toEqual([
      'OpenVINO/gemma-4-26b-a4b-it-int4-ov',
      'OpenVINO/gemma-4-E4B-it-int4-ov',
    ])
    for (const model of gemma) {
      expect(model.enableMtp).toBeUndefined()
      expect(model.toolParser).toBe('gemma4')
      expect(model.reasoningParser).toBe('gemma4')
    }
    const large = gemma.find((entry) => entry.name.includes('26b'))
    expect(large?.largeMoe).toBe(false)
    expect(large?.supportsVision).toBe(true)
  })
})
