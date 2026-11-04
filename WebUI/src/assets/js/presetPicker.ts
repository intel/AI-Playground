import { useErrors } from '@/assets/js/store/errors'
import { useI18N } from '@/assets/js/store/i18n'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching'
import { createAppError } from '@/assets/js/errors/appError'
import * as toast from '@/assets/js/toast'

type PresetPickerOptions = {
  /** Stay in the current mode; otherwise the mode follows the picked preset. */
  skipModeSwitch?: boolean
  /** Toast the switch once it succeeded. */
  announce?: boolean
}

/** The settings tabs' preset and variant pickers: switch, then announce or report the failure. */
export function usePresetPicker({ skipModeSwitch = false, announce = true }: PresetPickerOptions) {
  const presetSwitching = usePresetSwitching()
  const errors = useErrors()
  const oemBranding = useOemBranding()
  const languages = useI18N().state

  function reportFailure(code: string, template: string, error: string) {
    errors.report(
      createAppError({
        category: 'validation',
        code,
        severity: 'error',
        surface: 'toast',
        userMessage: template.replace('{error}', error),
      }),
    )
  }

  async function changePreset(presetName: string): Promise<boolean> {
    const result = await presetSwitching.switchPreset(
      presetName,
      skipModeSwitch ? { skipModeSwitch } : {},
    )
    if (result.success) {
      if (announce) {
        toast.success(
          languages.PRESET_SWITCHED.replace('{preset}', oemBranding.presetLabel(presetName)),
        )
      }
      return true
    }
    if (result.error) {
      reportFailure('presets/switch-failed', languages.PRESET_SWITCH_FAILED, result.error)
    }
    return false
  }

  async function changeVariant(presetName: string, variantName: string | null): Promise<void> {
    if (!variantName) return
    const result = await presetSwitching.switchPreset(presetName, {
      variant: variantName,
      skipModeSwitch: true,
    })
    if (!result.success && result.error) {
      reportFailure(
        'presets/variant-switch-failed',
        languages.PRESET_VARIANT_SWITCH_FAILED,
        result.error,
      )
    }
  }

  return { changePreset, changeVariant }
}
