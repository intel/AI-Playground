import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import z from 'zod'
import {
  chatTemplateKwargs,
  isAdoptable,
  recommendedReasoningEffort,
  resolveSampling,
  toRequestBody,
} from '@/lib/samplingDefaults'
import {
  ModelSchema,
  reasoningEfforts,
  type InferenceDefaults,
  type ReasoningEffort,
} from '@/types/shared'

// Hybrid-thinking models publish two sets of numbers (Qwen3.8: temp 1.0/top_p
// 0.95 while thinking, 0.7/0.80 plus a presence penalty when not), so the
// resolver has to pick a mode, not just read a flat record.
const QWEN38: InferenceDefaults = {
  topK: 20,
  minP: 0,
  repetitionPenalty: 1,
  thinking: { temperature: 1, topP: 0.95, presencePenalty: 0 },
  instruct: { temperature: 0.7, topP: 0.8, presencePenalty: 1.5 },
  reasoningEffort: 'low',
}

describe('resolveSampling', () => {
  it('merges the thinking profile over the shared base', () => {
    expect(resolveSampling(QWEN38, true)).toEqual({
      topK: 20,
      minP: 0,
      repetitionPenalty: 1,
      temperature: 1,
      topP: 0.95,
      presencePenalty: 0,
    })
  })

  it('merges the instruct profile when the turn does not think', () => {
    expect(resolveSampling(QWEN38, false)).toEqual({
      topK: 20,
      minP: 0,
      repetitionPenalty: 1,
      temperature: 0.7,
      topP: 0.8,
      presencePenalty: 1.5,
    })
  })

  it('keeps the base for a model that declares no per-mode profiles', () => {
    expect(resolveSampling({ temperature: 0.6, topP: 0.9 }, true)).toEqual({
      temperature: 0.6,
      topP: 0.9,
    })
  })

  it('resolves to nothing for a model without recommendations', () => {
    expect(resolveSampling(undefined, true)).toEqual({})
  })

  it('never leaks reasoningEffort into the sampling fields', () => {
    expect(resolveSampling(QWEN38, true)).not.toHaveProperty('reasoningEffort')
    expect(recommendedReasoningEffort(QWEN38)).toBe('low')
    expect(recommendedReasoningEffort({ temperature: 0.7 })).toBeUndefined()
  })
})

describe('toRequestBody', () => {
  it('maps the profile onto llama.cpp parameter names', () => {
    expect(toRequestBody(resolveSampling(QWEN38, true))).toEqual({
      top_p: 0.95,
      top_k: 20,
      min_p: 0,
      presence_penalty: 0,
      repeat_penalty: 1,
    })
  })

  it('uses the names OVMS understands and drops the ones it rejects', () => {
    expect(toRequestBody(resolveSampling(QWEN38, false), 'openVINO')).toEqual({
      top_p: 0.8,
      top_k: 20,
      presence_penalty: 1.5,
      repetition_penalty: 1,
    })
  })

  it('omits temperature so the user-facing setting stays authoritative', () => {
    expect(toRequestBody({ temperature: 1, topP: 0.95 })).toEqual({ top_p: 0.95 })
  })

  it('omits fields the model does not recommend', () => {
    expect(toRequestBody({})).toEqual({})
  })
})

// Chat and agent turns both build their kwargs here. They did not always: agent
// turns sent the effort and never the toggle, so a Game Agent run thought no
// matter what the thinking switch said, because Qwen3's template thinks unless
// told otherwise.
describe('chatTemplateKwargs', () => {
  const qwen = { supportsThinkingToggle: true, reasoningEffort: 'low' as const }

  it('states the toggle explicitly rather than relying on the template default', () => {
    expect(chatTemplateKwargs({ ...qwen, thinkingEnabled: true, thinkingActive: true })).toEqual({
      enable_thinking: true,
      reasoning_effort: 'low',
    })
  })

  it('says thinking is off and then has no trace to size', () => {
    expect(chatTemplateKwargs({ ...qwen, thinkingEnabled: false, thinkingActive: false })).toEqual({
      enable_thinking: false,
    })
  })

  it('sends the effort alone for a model that reasons without a toggle', () => {
    expect(
      chatTemplateKwargs({
        supportsThinkingToggle: false,
        thinkingEnabled: true,
        thinkingActive: true,
        reasoningEffort: 'xhigh',
      }),
    ).toEqual({ reasoning_effort: 'xhigh' })
  })

  it('sends nothing for a model that reads neither', () => {
    expect(
      chatTemplateKwargs({
        supportsThinkingToggle: false,
        thinkingEnabled: true,
        thinkingActive: true,
      }),
    ).toEqual({})
  })
})

describe('isAdoptable', () => {
  // The rule behind "model values are defaults": a setting is replaced by a new
  // recommendation only while it still holds the one we wrote.
  it('adopts a setting that still holds the value we applied', () => {
    expect(isAdoptable(1, 1, 0.7)).toBe(true)
    expect(isAdoptable(0.4, 1, 0.7)).toBe(false)
  })

  it('adopts an untouched setting that predates any recommendation', () => {
    expect(isAdoptable(0.7, undefined, 0.7)).toBe(true)
    expect(isAdoptable(1.4, undefined, 0.7)).toBe(false)
  })

  it('treats a setting with no app default as adoptable while unset', () => {
    expect(isAdoptable<ReasoningEffort | undefined>(undefined, undefined)).toBe(true)
    expect(isAdoptable<ReasoningEffort | undefined>('xhigh', 'medium')).toBe(false)
    expect(isAdoptable<ReasoningEffort | undefined>('medium', 'medium')).toBe(true)
  })
})

describe('reasoningEfforts', () => {
  // Qwen3.8's template raises a Jinja exception ("Unexpected reasoning effort
  // …. Supported types are xhigh (default), medium, and low"), which fails the
  // whole turn, so offering a level it does not know is not a soft error.
  it('offers only the levels the template accepts', () => {
    expect([...reasoningEfforts]).toEqual(['low', 'medium', 'xhigh'])
  })
})

describe('models.json', () => {
  it('carries recommendations that survive the schema and resolve per mode', () => {
    const models = z
      .array(ModelSchema)
      .parse(
        JSON.parse(readFileSync(path.resolve(__dirname, '../../../external/models.json'), 'utf-8')),
      )
    const qwen38 = models.filter((model) => model.name.includes('Qwen3.8-27B'))
    expect(qwen38).not.toHaveLength(0)
    for (const model of qwen38) {
      expect(model.inferenceDefaults).toBeDefined()
      expect(resolveSampling(model.inferenceDefaults, true).temperature).toBe(1)
      expect(resolveSampling(model.inferenceDefaults, false).temperature).toBe(0.7)
    }
  })

  // An agent turn pays for thinking once per step, and a Game Agent run is
  // dozens of steps: at `medium` this model spent 15 minutes on three file
  // reads. A chat reply pays it once, which is why the level lives with the
  // model rather than being talked up per preset. OVMS has no reasoning-budget
  // flag, so the effort level is the only cap the OpenVINO build gets.
  it('asks Qwen3.8 to think at the depth an agent run can afford', () => {
    const models = z
      .array(ModelSchema)
      .parse(
        JSON.parse(readFileSync(path.resolve(__dirname, '../../../external/models.json'), 'utf-8')),
      )
    const qwen38 = models.filter((model) => model.name.includes('Qwen3.8-27B'))
    expect(qwen38).not.toHaveLength(0)
    for (const model of qwen38) {
      expect(recommendedReasoningEffort(model.inferenceDefaults)).toBe('low')
    }
  })

  // Both Qwen3.8 GGUFs carry MTP layers that llama-server otherwise loads and
  // discards ("unused tensor blk.64.nextn.*"). Drafting off them measured 5.9 →
  // 12.5 tok/s on Arc B390 at ~65% acceptance, with no second model to download.
  it('turns on the speculative decoding Qwen3.8 ships the weights for', () => {
    const models = z
      .array(ModelSchema)
      .parse(
        JSON.parse(readFileSync(path.resolve(__dirname, '../../../external/models.json'), 'utf-8')),
      )
    const qwen38 = models.filter((model) => model.name.includes('Qwen3.8-27B-GGUF'))
    expect(qwen38).not.toHaveLength(0)
    for (const model of qwen38) {
      expect(model.llamaCppArgs).toContain('--spec-type draft-mtp')
    }
  })

  // `low` was not enough on its own: a Game Agent run spent 20 minutes writing
  // the whole game inside one thinking block and never reached its first edit.
  // The budget is a hard stop the model cannot talk itself out of, and it is
  // per-model precisely so capping this one does not cap anybody's chat.
  it('caps how long Qwen3.8 may think before it has to act', () => {
    const models = z
      .array(ModelSchema)
      .parse(
        JSON.parse(readFileSync(path.resolve(__dirname, '../../../external/models.json'), 'utf-8')),
      )
    const qwen38 = models.filter((model) => model.name.includes('Qwen3.8-27B-GGUF'))
    expect(qwen38).not.toHaveLength(0)
    for (const model of qwen38) {
      expect(model.llamaCppArgs).toMatch(/--reasoning-budget \d+/)
      expect(model.llamaCppArgs).toContain('--reasoning-budget-message "')
    }
  })

  // `--reasoning-preserve` looks like the fix for an agent re-deriving its own
  // plan, but Qwen3.8's template preserves unless told otherwise and keeps the
  // current turn's thinking either way, so passing it buys nothing and only
  // suggests it does. See AGENTS.md for the rendered-prompt evidence.
  it('does not pass Qwen3.8 llama.cpp flags that its template already implies', () => {
    const models = z
      .array(ModelSchema)
      .parse(
        JSON.parse(readFileSync(path.resolve(__dirname, '../../../external/models.json'), 'utf-8')),
      )
    const qwen38 = models.filter((model) => model.name.includes('Qwen3.8-27B-GGUF'))
    expect(qwen38).not.toHaveLength(0)
    for (const model of qwen38) {
      expect(model.llamaCppArgs).not.toContain('reasoning-preserve')
    }
  })

  // An `-MTP-` repo is a separate download whose only reason to exist is the
  // draft head, so an entry that lost its flags would cost the user the whole
  // download and give back nothing. How far to draft is per model — Unsloth
  // raised the 9B to 6 and keeps the bigger two at 2 — so it is pinned per repo
  // rather than as one shared number.
  it('drafts off the head each MTP repo was downloaded for', () => {
    const models = z
      .array(ModelSchema)
      .parse(
        JSON.parse(readFileSync(path.resolve(__dirname, '../../../external/models.json'), 'utf-8')),
      )
    const draftLengths = [
      { repo: 'Qwen3.5-9B-MTP-GGUF', nMax: 6 },
      { repo: 'Qwen3.6-27B-MTP-GGUF', nMax: 2 },
      { repo: 'Qwen3.6-35B-A3B-MTP-GGUF', nMax: 2 },
    ]
    for (const { repo, nMax } of draftLengths) {
      const mtp = models.filter((model) => model.name.includes(repo))
      expect(mtp).not.toHaveLength(0)
      for (const model of mtp) {
        expect(model.llamaCppArgs).toContain('--spec-type draft-mtp')
        expect(model.llamaCppArgs).toContain(`--spec-draft-n-max ${nMax}`)
      }
    }
  })
})
