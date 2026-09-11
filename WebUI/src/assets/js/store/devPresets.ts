/**
 * Dev-only ComfyUI presets that complete in well under a second because they run
 * no model at all — they only touch core ComfyUI nodes (`EmptyImage`,
 * `ImageInvert`, `CreateVideo`, `Load3D`). They exist so the surrounding plumbing
 * (tool catalogs, the media specialist agent, workflow input substitution, media
 * item typing, workspace saving, UI rendering) can be exercised end to end
 * without waiting minutes for a real diffusion run on a dev laptop.
 *
 * Injected into the preset list when `debugToolsEnabled` is set (i.e. `npm run
 * dev`) or settings.json asks for the debug controls, mirroring the dev-only test
 * LLM in `models.ts`.
 */
import type { ComfyUiPreset, Preset } from './presets'
import { useDeveloperSettings } from './developerSettings'
import { debugSettingsVisible } from './debugSettings'
import { getComfyAuthToken } from '@/lib/loopbackAuth'

const DUMMY_TAGS = ['dev only', 'instant', 'no model']

const TEST_ONLY_NOTE =
  'DEV/TEST WORKFLOW: returns a placeholder result instantly and ignores the prompt. ' +
  'Only pick it when the user explicitly asks for a dummy, test or fast workflow — never for ' +
  'a genuine media request.'

/** Filenames the 3D dummy expects inside the ComfyUI input directory. */
const GLB_FIXTURE = { name: 'aipg-dummy.glb', subfolder: '3d' }
const VIEW_FIXTURE = { name: 'aipg-dummy-view.png', subfolder: '' }

const promptSetting = {
  type: 'string' as const,
  label: 'Prompt',
  displayed: false,
  modifiable: true,
  defaultValue: '',
  settingName: 'prompt' as const,
}

const seedSetting = {
  type: 'number' as const,
  label: 'Seed',
  displayed: false,
  modifiable: true,
  defaultValue: -1,
  settingName: 'seed' as const,
}

const batchSizeSetting = {
  type: 'number' as const,
  label: 'Batch Size',
  displayed: false,
  modifiable: true,
  defaultValue: 1,
  settingName: 'batchSize' as const,
}

function sizeSetting(name: 'width' | 'height', label: string, defaultValue: number) {
  return {
    type: 'number' as const,
    label,
    displayed: false,
    modifiable: false,
    defaultValue,
    settingName: name,
  }
}

const sourceImageSetting = {
  type: 'image' as const,
  label: 'Reference Image',
  displayed: true,
  modifiable: true,
  defaultValue: '',
  nodeTitle: 'Load Image',
  nodeInput: 'image',
}

/** Small resolutions only: the point is speed, not pixels. */
const dummyResolutionConfig = {
  megapixels: [
    { label: '0.25', totalPixels: 262144 },
    { label: '0.5', totalPixels: 495616 },
  ],
  aspectRatios: ['16/9', '1/1', '9/16'],
  useLookupTable: true,
}

const dummyImagePreset: ComfyUiPreset = {
  type: 'comfy',
  name: 'Dummy Image (test)',
  backend: 'comfyui',
  displayPriority: -100,
  tags: DUMMY_TAGS,
  category: 'create-images',
  toolCategory: 'create-images',
  mediaType: 'image',
  description: 'Dev only: instant solid-colour image, no model involved',
  extendedDescription:
    'Produces a single solid-colour image in a fraction of a second. Use it to verify that ' +
    'image generation is wired up correctly without paying for a real diffusion run.',
  toolInstructions: TEST_ONLY_NOTE,
  excludeFromHomeAgentPicker: true,
  requiredCustomNodes: [],
  requiredPythonPackages: [],
  requiredModels: [],
  resolutionConfig: dummyResolutionConfig,
  settings: [
    promptSetting,
    seedSetting,
    sizeSetting('width', 'Width', 512),
    sizeSetting('height', 'Height', 512),
    batchSizeSetting,
    {
      type: 'number',
      label: 'Colour',
      displayed: true,
      modifiable: true,
      defaultValue: 2201331,
      min: 0,
      max: 16777215,
      step: 1,
      nodeTitle: 'Empty Image',
      nodeInput: 'color',
    },
  ],
  comfyUiApiWorkflow: {
    '1': {
      class_type: 'EmptyImage',
      inputs: { width: 512, height: 512, batch_size: 1, color: 2201331 },
      _meta: { title: 'Empty Image' },
    },
    '2': {
      class_type: 'SaveImage',
      inputs: { filename_prefix: 'AIPG_DummyImage', images: ['1', 0] },
      _meta: { title: 'Save Image' },
    },
  },
}

const dummyVideoPreset: ComfyUiPreset = {
  type: 'comfy',
  name: 'Dummy Video (test)',
  backend: 'comfyui',
  displayPriority: -100,
  tags: DUMMY_TAGS,
  category: 'create-videos',
  toolCategory: 'create-videos',
  mediaType: 'video',
  description: 'Dev only: instant solid-colour clip, no model involved',
  extendedDescription:
    'Encodes a handful of identical solid-colour frames into an mp4 in a fraction of a second, ' +
    'so the video path can be verified without a real video model.',
  toolInstructions: TEST_ONLY_NOTE,
  excludeFromHomeAgentPicker: true,
  requiredCustomNodes: [],
  requiredPythonPackages: [],
  requiredModels: [],
  resolutionConfig: dummyResolutionConfig,
  settings: [
    promptSetting,
    seedSetting,
    sizeSetting('width', 'Width', 512),
    sizeSetting('height', 'Height', 288),
    batchSizeSetting,
    {
      type: 'number',
      label: 'Frames',
      displayed: true,
      modifiable: true,
      defaultValue: 8,
      min: 1,
      max: 64,
      step: 1,
      nodeTitle: 'Empty Image',
      nodeInput: 'batch_size',
    },
    {
      type: 'number',
      label: 'Frames Per Second',
      displayed: true,
      modifiable: true,
      defaultValue: 8,
      min: 1,
      max: 30,
      step: 1,
      nodeTitle: 'Create Video',
      nodeInput: 'fps',
    },
  ],
  comfyUiApiWorkflow: {
    '1': {
      class_type: 'EmptyImage',
      inputs: { width: 512, height: 288, batch_size: 8, color: 8388736 },
      _meta: { title: 'Empty Image' },
    },
    '2': {
      class_type: 'CreateVideo',
      inputs: { images: ['1', 0], fps: 8 },
      _meta: { title: 'Create Video' },
    },
    '3': {
      class_type: 'SaveVideo',
      inputs: {
        video: ['2', 0],
        filename_prefix: 'AIPG_DummyVideo',
        format: 'auto',
        codec: 'auto',
      },
      _meta: { title: 'Save Video' },
    },
  },
}

const dummyEditPreset: ComfyUiPreset = {
  type: 'comfy',
  name: 'Dummy Edit (test)',
  backend: 'comfyui',
  displayPriority: -100,
  tags: DUMMY_TAGS,
  category: 'edit-images',
  toolCategory: 'edit-images',
  mediaType: 'image',
  description: 'Dev only: instantly inverts the colours of the input image',
  extendedDescription:
    'Inverts the colours of the reference image. The visible change proves the source image ' +
    'really reached ComfyUI, which makes it a cheap check for image-to-image chaining.',
  toolInstructions:
    TEST_ONLY_NOTE +
    ' It inverts the colours of the source image, so the result is recognisably derived from it.',
  excludeFromHomeAgentPicker: true,
  requiredCustomNodes: [],
  requiredPythonPackages: [],
  requiredModels: [],
  settings: [promptSetting, seedSetting, batchSizeSetting, sourceImageSetting],
  comfyUiApiWorkflow: {
    '1': {
      class_type: 'LoadImage',
      inputs: { image: '', upload: 'image' },
      _meta: { title: 'Load Image' },
    },
    '2': {
      class_type: 'ImageInvert',
      inputs: { image: ['1', 0] },
      _meta: { title: 'Invert Image' },
    },
    '3': {
      class_type: 'SaveImage',
      inputs: { filename_prefix: 'AIPG_DummyEdit', images: ['2', 0] },
      _meta: { title: 'Save Image' },
    },
  },
}

/**
 * Mirrors the contract of the real "Image To 3D Model" preset (image in, `.glb`
 * out) but returns a fixture pyramid instead of running Hunyuan3D. `Load3D`
 * re-saves a file from the ComfyUI input directory, so the graph needs the two
 * fixtures uploaded by `ensureDummyWorkflowFixtures` first. The `Load Image`
 * node exists to keep the "needs a source image" contract (and to exercise the
 * upload path); nothing consumes it, so ComfyUI never executes it.
 */
const dummy3dPreset: ComfyUiPreset = {
  type: 'comfy',
  name: 'Dummy 3D Model (test)',
  backend: 'comfyui',
  displayPriority: -100,
  tags: DUMMY_TAGS,
  category: 'edit-images',
  toolCategory: 'edit-images',
  mediaType: 'model3d',
  description: 'Dev only: instantly returns a placeholder .glb mesh',
  extendedDescription:
    'Returns a small placeholder pyramid mesh instead of running a real image-to-3D model, so ' +
    'the 3D output path can be verified in a fraction of a second.',
  toolInstructions: TEST_ONLY_NOTE + ' The returned mesh is always the same placeholder pyramid.',
  excludeFromHomeAgentPicker: true,
  requiredCustomNodes: [],
  requiredPythonPackages: [],
  requiredModels: [],
  settings: [
    promptSetting,
    seedSetting,
    batchSizeSetting,
    // Keeps ComfyUI's render size predictable: the standard width/height
    // settings would otherwise land on `Load3D`, the only node with those inputs.
    sizeSetting('width', 'Width', 256),
    sizeSetting('height', 'Height', 256),
    sourceImageSetting,
  ],
  comfyUiApiWorkflow: {
    '1': {
      class_type: 'LoadImage',
      inputs: { image: '', upload: 'image' },
      _meta: { title: 'Load Image' },
    },
    '2': {
      class_type: 'Load3D',
      inputs: {
        model_file: `${GLB_FIXTURE.subfolder}/${GLB_FIXTURE.name}`,
        image: {
          image: VIEW_FIXTURE.name,
          mask: VIEW_FIXTURE.name,
          normal: VIEW_FIXTURE.name,
          recording: '',
          camera_info: {},
        },
        width: 256,
        height: 256,
      },
      _meta: { title: 'Load 3D' },
    },
    '3': {
      // Slot 6 of Load3D is its `model_3d` (File3D) output.
      class_type: 'SaveGLB',
      inputs: { mesh: ['2', 6], filename_prefix: 'AIPG_Dummy3D' },
      _meta: { title: 'Save 3D Model' },
    },
  },
}

export const devPresets: ComfyUiPreset[] = [
  dummyImagePreset,
  dummyEditPreset,
  dummyVideoPreset,
  dummy3dPreset,
]

export const DEV_PRESET_NAMES: ReadonlySet<string> = new Set(devPresets.map((p) => p.name))

function devPresetsEnabled(): boolean {
  return window.envVars?.debugToolsEnabled === true || debugSettingsVisible()
}

/** Appends the dev-only dummy presets to a freshly loaded preset list. */
export function withDevPresets(presets: Preset[]): Preset[] {
  if (!devPresetsEnabled()) return presets
  return [...presets, ...devPresets]
}

/**
 * Whether the media tool catalogs should offer nothing but the dummy workflows
 * (Settings › Developer). Picking a workflow is otherwise up to the model, which
 * makes a verification run take minutes as soon as it reaches for a real one.
 */
export function dummyWorkflowsOnly(): boolean {
  return devPresetsEnabled() && useDeveloperSettings().forceDummyMediaWorkflows
}

// ============================================================================
// Fixtures for the 3D dummy
// ============================================================================

const PYRAMID_VERTICES = [
  [-0.5, 0, -0.5],
  [0.5, 0, -0.5],
  [0.5, 0, 0.5],
  [-0.5, 0, 0.5],
  [0, 1, 0],
]
const PYRAMID_INDICES = [0, 1, 2, 0, 2, 3, 0, 4, 1, 1, 4, 2, 2, 4, 3, 3, 4, 0]

const GLB_MAGIC = 0x46546c67
const GLB_CHUNK_JSON = 0x4e4f534a
const GLB_CHUNK_BIN = 0x004e4942

/** Builds a minimal single-mesh binary glTF (no materials, no textures). */
export function buildDummyGlb(): Blob {
  const positionsLength = PYRAMID_VERTICES.length * 12
  const indicesLength = PYRAMID_INDICES.length * 2
  const binLength = Math.ceil((positionsLength + indicesLength) / 4) * 4
  const bin = new DataView(new ArrayBuffer(binLength))
  let offset = 0
  for (const [x, y, z] of PYRAMID_VERTICES) {
    bin.setFloat32(offset, x, true)
    bin.setFloat32(offset + 4, y, true)
    bin.setFloat32(offset + 8, z, true)
    offset += 12
  }
  for (const index of PYRAMID_INDICES) {
    bin.setUint16(offset, index, true)
    offset += 2
  }

  const gltf = {
    asset: { version: '2.0', generator: 'AI Playground dummy workflow' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'DummyPyramid' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: binLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionsLength, target: 34962 },
      { buffer: 0, byteOffset: positionsLength, byteLength: indicesLength, target: 34963 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: PYRAMID_VERTICES.length,
        type: 'VEC3',
        min: [-0.5, 0, -0.5],
        max: [0.5, 1, 0.5],
      },
      {
        bufferView: 1,
        componentType: 5123,
        count: PYRAMID_INDICES.length,
        type: 'SCALAR',
      },
    ],
  }
  // ASCII-only, so padding with spaces to a 4-byte boundary is safe per character.
  let json = JSON.stringify(gltf)
  while (json.length % 4 !== 0) json += ' '
  const jsonBytes = new TextEncoder().encode(json)

  const totalLength = 12 + 8 + jsonBytes.byteLength + 8 + binLength
  const glb = new ArrayBuffer(totalLength)
  const header = new DataView(glb)
  header.setUint32(0, GLB_MAGIC, true)
  header.setUint32(4, 2, true)
  header.setUint32(8, totalLength, true)
  header.setUint32(12, jsonBytes.byteLength, true)
  header.setUint32(16, GLB_CHUNK_JSON, true)
  const bytes = new Uint8Array(glb)
  bytes.set(jsonBytes, 20)
  const binChunkOffset = 20 + jsonBytes.byteLength
  header.setUint32(binChunkOffset, binLength, true)
  header.setUint32(binChunkOffset + 4, GLB_CHUNK_BIN, true)
  bytes.set(new Uint8Array(bin.buffer), binChunkOffset + 8)

  return new Blob([glb], { type: 'model/gltf-binary' })
}

/** `Load3D` loads a preview/mask/normal image, so it needs one real image file. */
async function buildDummyViewPng(): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = 8
  canvas.height = 8
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not create a canvas context for the dummy 3D fixture')
  context.fillStyle = '#5a6ea0'
  context.fillRect(0, 0, canvas.width, canvas.height)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the dummy 3D fixture'))),
      'image/png',
    )
  })
}

let fixturesUploaded = false

async function uploadFixture(
  comfyBaseUrl: string,
  fixture: { name: string; subfolder: string },
  blob: Blob,
): Promise<void> {
  const body = new FormData()
  body.append('image', blob, fixture.name)
  body.append('overwrite', 'true')
  if (fixture.subfolder) body.append('subfolder', fixture.subfolder)
  const token = await getComfyAuthToken()
  const response = await fetch(`${comfyBaseUrl}/upload/image`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body,
  })
  if (!response.ok) {
    throw new Error(
      `Uploading dummy workflow fixture ${fixture.name} failed with ${response.status}`,
    )
  }
}

/**
 * Puts the 3D dummy's fixture files into ComfyUI's input directory. No-op for
 * every other preset, and only does the upload once per app session.
 */
export async function ensureDummyWorkflowFixtures(
  preset: Preset,
  comfyBaseUrl: string | undefined,
): Promise<void> {
  if (preset.name !== dummy3dPreset.name || fixturesUploaded || !comfyBaseUrl) return
  try {
    await uploadFixture(comfyBaseUrl, GLB_FIXTURE, buildDummyGlb())
    await uploadFixture(comfyBaseUrl, VIEW_FIXTURE, await buildDummyViewPng())
    fixturesUploaded = true
  } catch (error) {
    fixturesUploaded = false
    throw error
  }
}
