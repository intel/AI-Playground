import type { Preset } from '@/assets/js/store/presets'
import type { HelpTopic } from '@/assets/js/help/helpTopics'

/**
 * The preset's how-to text. `extendedDescription` is either a single string or a
 * map keyed by *internal* variant name; when the requested variant has no entry we
 * fall back to the first one so there is always something to show.
 */
export function extendedDescriptionText(
  preset: Preset | null | undefined,
  variantName?: string | null,
): string | undefined {
  const raw = preset?.extendedDescription
  if (raw == null) return undefined
  if (typeof raw === 'string') return raw
  if (variantName && variantName in raw) return raw[variantName]
  const first = Object.values(raw)[0]
  return typeof first === 'string' ? first : undefined
}

export function helpTopicFromPreset(
  preset: Preset | null | undefined,
  presetName: string,
): HelpTopic {
  if (!preset) {
    return {
      title: presetName,
      body: 'Preset for the current mode. Click to select it, then adjust model and workflow options in the panel below.',
    }
  }

  const parts: string[] = []
  if (preset.description) parts.push(preset.description)
  const extended = extendedDescriptionText(preset)
  if (extended && extended !== preset.description) parts.push(extended)
  if (preset.tags.length > 0) {
    parts.push(`Tags: ${preset.tags.join(', ')}`)
  }

  return {
    title: preset.name,
    body:
      parts.join('\n\n') ||
      `Use the ${preset.name} preset for this workflow. Select it to load its default settings.`,
  }
}

/**
 * Presets are addressed by name in the DOM, and a chat preset can share a name with
 * a comfy one, so prefer the type that matches the mode the user is looking at.
 */
export function findPresetByName(
  presets: Preset[],
  name: string,
  preferredType?: 'chat' | 'comfy',
): Preset | null {
  const matches = presets.filter((p) => p.name === name)
  if (matches.length === 0) return null
  return matches.find((p) => p.type === preferredType) ?? matches[0]
}

export function helpTopicFromPresetVariant(
  preset: Preset | null | undefined,
  presetName: string,
  variantName: string,
): HelpTopic {
  if (!preset) {
    return {
      title: variantName,
      body: `Variant of ${presetName}. Select to apply this configuration.`,
    }
  }

  const variant = preset.variants?.find((v) => v.name === variantName)
  const parts: string[] = [`Variant of ${preset.name}.`]
  const extended = extendedDescriptionText(preset, variantName)
  if (extended) parts.push(extended)
  else if (preset.description) parts.push(preset.description)

  return {
    title: variant ? `${preset.name} — ${variant.name}` : variantName,
    body: parts.join('\n\n'),
  }
}
