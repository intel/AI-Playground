This folder contains the presets to be used during demo mode.
Demo mode can be activated by `isDemoModeEnabled: true` in `settings.json`.

The demo presets folder can be configured via `demoModePresetsDir` (defaults to `presets_demo`).

The logic is intentionally kept simple, no deepmerging from multiple places or similar:

- When in demo mode, all presets are taken from this folder
- If a preset should appear during demo, the json must exist here

To disable only sliders/checkboxes/features during demo mode:

- generally: manually copy files + replace `modifyable: true` with `false`
- there is a `"settings":` block for all available inputs
- there is a `"variants":` block with overrides for "Fast" or "Standard" presets

To change defaults during demo:

- set `"defaultValue":` to the desired default value

Typical things to change for demo mode:

- "Safety Checker Strength" slider to `defaultValue: 0` and `modifyable: false`
- "Show Preview" checkbox to `defaultValue: false` and `modifyable: false`
- "Input Image" image picker to `modifyable: false`

## `_profile.json` — Demo Profile Descriptor

Each demo presets folder can contain a `_profile.json` file that configures the demo
mode identity for that product variant (trade show, essentials, etc.).

If `_profile.json` is missing, the app falls back to hardcoded defaults built into the
source code. Existing deployments without the file continue to work identically.

### Fields

| Field                      | Type           | Required | Description                                                                                                                                                                      |
| -------------------------- | -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaults.chatPreset`      | string         | yes      | Preset name to select for chat mode                                                                                                                                              |
| `defaults.chatModel`       | string         | yes      | Model ID to select for chat (e.g. GGUF path)                                                                                                                                     |
| `defaults.imageGenPreset`  | string         | no       | Preset name for image generation mode                                                                                                                                            |
| `defaults.imageEditPreset` | string         | no       | Preset name for image editing mode                                                                                                                                               |
| `inputImage`               | string \| null | no       | Filename of an image in this folder to preload for image editing. Electron reads the file and embeds it as a `data:image/*;base64,...` URI. Set to `null` or omit if not needed. |
| `samplePrompts`            | array          | no       | Sample prompts shown in the prompt area. Each entry has `title`, `description`, `prompt`, and `mode` (`chat`, `imageGen`, `imageEdit`, or `video`).                              |
| `enabledModes`             | array          | no       | Which modes are active: `["chat", "imageGen", "imageEdit", "video"]`. Tour steps and notification dots for disabled modes are hidden. Defaults to all four modes.                |
| `notificationDotButtons`   | array          | no       | Button IDs that show notification dots on first visit. Defaults to an empty array (falls back to hardcoded list).                                                                |

### Creating a new profile for a different product variant

1. Create a new presets folder (e.g. `external/presets_essentials/`)
2. Copy or create the preset JSON files you want available in that variant
3. Create a `_profile.json` with the fields above, referencing only the presets and
   modes that apply to your variant
4. If your variant uses an input image, place it in the same folder and reference it
   by filename in `inputImage`
5. Set `demoModePresetsDir` in `settings.json` to your folder name (e.g. `"presets_essentials"`)

Example for a chat-only "essentials" variant:

```json
{
  "defaults": {
    "chatPreset": "Basic",
    "chatModel": "unsloth/SmolLM2-1.7B-Instruct-GGUF/SmolLM2-1.7B-Instruct-Q5_K_S.gguf"
  },
  "inputImage": null,
  "samplePrompts": [
    {
      "title": "Chat Example",
      "description": "Ask anything:",
      "prompt": "What is machine learning?",
      "mode": "chat"
    }
  ],
  "enabledModes": ["chat"],
  "notificationDotButtons": ["mode-button-chat", "app-settings-button", "plus-icon"]
}
```
