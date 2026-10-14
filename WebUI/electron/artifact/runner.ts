/**
 * Main-side artifact runner (docs/architecture-target.md §4.1, step 5): the
 * engine that previously lived in the renderer's `comfyUiPresets` store plus
 * `runArtifact`'s waiting discipline, merged into one owner.
 *
 * Drivers ship fully-resolved runs (preset entry, params, dynamic inputs,
 * pre-registered items); the runner drives the model pre-flight for in-process
 * tool runs, requirement installs, backend start, workflow rewrite, ComfyUI
 * submission and the websocket progress through to a settled outcome —
 * streaming phase/item events on the kernel bus so the renderer's stores are
 * pure projections of this module. One run is active at a time; later
 * submissions either fail fast ("Another generation is already in progress",
 * the panel and Home Agent behavior) or queue behind it (the chat tools'
 * lane, and in-process agent direct tools waiting for the GPU — all of which
 * is the orchestrator's queue now).
 *
 * The single stall owner is here, unchanged from the renderer runner it
 * replaces: one re-arming 5-minute idle watchdog over every phase — backend
 * boot, installs, model load, execution, item settlement.
 */
import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { appLoggerInstance } from '../observability/logger'
import {
  beginArtifactRunSnapshot,
  emitArtifactDone,
  emitArtifactItem,
  emitArtifactPhase,
  emitFailure,
} from '../kernel/kernelBus'
import type { ArtifactPhase, ArtifactRunOwner, ArtifactRunTag } from '@/types/kernelEvents'
import type { MediaItem } from '@/types/mediaItem'
import type { ArtifactRunResult } from '@/types/artifactIpc'
import type { IpcOkWith } from '@/types/ipcChannels'
import {
  findKeysByClassType,
  mediaUrl,
  modifySettingInWorkflow,
  workflowUsesOvmsImage,
} from '@/lib/comfyWorkflow'
import { parseCustomNodeSpec } from '@/lib/customNodeRepoId'
import type { ComfyUIApiWorkflow, ComfyUiPreset } from '@/lib/presetSchemas'
import type { ArtifactMissingModel } from '@/types/mediaRequests'
import { ComfyMessageSchema, summarizeComfyExecutionError } from '@/assets/js/store/comfyUiMessages'
import {
  downloadCustomNode,
  isCustomNodeInstalled,
  isPackageInstalled,
  installPypiPackage,
} from '../adapters/backends/comfyuiTools'
import {
  rewriteWorkflowForRun,
  validateRequiredImageInputs,
  type ArtifactRunInput,
} from './workflowRewrite'
import {
  clearQueue,
  getComfySocket,
  interruptExecution,
  releaseComfySocket,
  submitPrompt,
  uploadInputFile,
  type ComfyClientDeps,
} from './comfyClient'
import { buildDummyGlb, DUMMY_3D_PRESET_NAME, VIEW_FIXTURE } from '@/lib/devPresetWorkflows'
import { saveMediaItems } from '../persist/mediaItemFiles'
import { extractMessage } from '@/assets/js/errors/appError'

const appLogger = appLoggerInstance

const GENERATION_IDLE_TIMEOUT_MS = 5 * 60_000
const WEBSOCKET_CLOSED_BY_POLICY = 1000

/** The renderer's queued-slot placeholder, kept byte-identical. */
const PLACEHOLDER_URL =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"%3E%3C/svg%3E'

export type ArtifactRunParams = {
  prompt: string
  negativePrompt: string
  seed: number
  inferenceSteps: number
  width: number
  height: number
  batchSize: number
}

/** One resolved run, as shipped by a renderer driver or built for an in-process tool. */
export type ArtifactRunPayload = {
  runId: string
  mode: 'imageGen' | 'imageEdit' | 'video'
  preset: ComfyUiPreset
  params: ArtifactRunParams
  inputs: ArtifactRunInput[]
  /**
   * Pre-registered item stubs (renderer drivers build them so the UI can show
   * slots immediately). When absent (in-process agent tools) the runner builds
   * them itself and streams the registration out as item events.
   */
  items?: MediaItem[]
  /** Source image reference, kept for the item record and trace. */
  source?: string
  /**
   * The variant that was applied to `preset`. `applyVariant` keeps the full
   * variants list, so `preset.variants[0]` is not the selected name.
   */
  variant?: string
  /**
   * Who submitted the run. Renderer drivers pre-register UI items; in-process
   * agent tools do not, and the Image Gen store must not adopt their events.
   */
  origin?: 'renderer' | 'agent'
  /** Which surface renders this run's progress; stamped on every artifact event. */
  owner?: ArtifactRunOwner
  /**
   * Whether required models were already consented AND downloaded by the
   * driver (the renderer's pre-flight). In-process tool runs leave this false
   * and the runner performs the missing-check and consent request itself.
   */
  modelsConsented?: boolean
  showPreview?: boolean
  safetyCheck?: boolean
  /** Whether the user asked to keep models loaded (renderer's developer setting). */
  keepModelsLoaded?: boolean
  /** Chat conversation the run was asked from — routes orchestrator queue events. */
  conversationKey?: string
  /** The renderer activity the tool began for this run — lets queue events relabel it. */
  activityId?: string
}

// Hoisted to `@/types/artifactIpc` (the manifest row states it); re-exported
// so the electron-side importers keep one canonical path.
export type { ArtifactRunResult }

/** The subset of `ComfyUiBackendService` the runner needs, so tests can fake it. */
export type RunnerComfyService = {
  currentStatus: string
  baseUrl: string
  start(): Promise<string>
  stop(): Promise<string>
  getLoopbackAuthToken(): string
  serviceDir: string
  getTorchBackendEnv(): Record<string, string>
  comfyUiVariantName: string
}

export type ArtifactRunnerDeps = {
  getComfyService(): RunnerComfyService | null
  onServiceStatusChange(cb: (status: string) => void): () => void
  /** Which of the preset's required models are missing on disk (ai-backend check). */
  modelsMissing(preset: ComfyUiPreset): Promise<ArtifactMissingModel[]>
  /**
   * Ask the user for download consent through the renderer's permissions layer
   * (dialog / Home Agent in-channel / pre-grants). `true` implies the download
   * completed; `false` means declined or cancelled. `onProgress` fires while
   * the download runs, re-arming the idle watchdog.
   */
  requestModelConsent(models: ArtifactMissingModel[], onProgress?: () => void): Promise<boolean>
  ensureOvmsImageReady(
    modelId: string,
    keepModelsLoaded: boolean,
    resolution: string,
  ): Promise<IpcOkWith<{ url: string }>>
  readMediaAsDataUri(url: string): Promise<string | null>
  getPlatform(): NodeJS.Platform
  /** Dev-only dummy presets are offered (npm run dev / showDebugSettingsInUI). */
  devPresetsEnabled(): boolean
}

type ActiveRun = {
  payload: ArtifactRunPayload
  items: MediaItem[]
  /** Index of the batch entry the next `executed` output belongs to. */
  generateIdx: number
  settle: (result: ArtifactRunResult) => void
  cancel: () => void
  statusWatch: (() => void) | null
  idleTimer: ReturnType<typeof setTimeout> | null
  settled: boolean
  loaderNodes: string[]
  phase: ArtifactPhase
  /** ComfyUI client id for this run — unique so leftover WS frames cannot mix. */
  clientId: string
  comfyBaseUrl: string | null
}

let activeRun: ActiveRun | null = null
let runnerDeps: ArtifactRunnerDeps | null = null

export function setArtifactRunnerDeps(deps: ArtifactRunnerDeps): void {
  runnerDeps = deps
}

/** Whether a run is executing right now — the snapshot and crash watch ask. */
export function artifactRunActive(): boolean {
  return activeRun !== null
}

/** The active run's id, or null — the orchestrator routes cancels by id. */
export function activeArtifactRunId(): string | null {
  return activeRun?.payload.runId ?? null
}

/**
 * Starts a resolved run. Queueing, GPU windowing and queue events are the
 * orchestrator's (electron/kernel/orchestrator.ts, step 7) — it calls
 * this once a run reaches the head.
 */
export function startArtifactRun(payload: ArtifactRunPayload): Promise<ArtifactRunResult> {
  return startRun(payload)
}

/** Cancels the active run — the Stop button. Queued runs are untouched. */
export function cancelActiveArtifactRun(): void {
  activeRun?.cancel()
}

function resolvedVariantName(payload: ArtifactRunPayload): string | undefined {
  return payload.variant ?? payload.preset.variants?.[0]?.name
}

function runOrigin(payload: ArtifactRunPayload): 'renderer' | 'agent' {
  return payload.origin ?? (payload.items ? 'renderer' : 'agent')
}

export function artifactRunTag(payload: ArtifactRunPayload): ArtifactRunTag {
  return { runId: payload.runId, origin: runOrigin(payload), owner: payload.owner }
}

// Test seam.
export function resetArtifactRunnerForTest(): void {
  if (activeRun?.idleTimer) {
    clearTimeout(activeRun.idleTimer)
    activeRun.idleTimer = null
  }
  if (activeRun?.comfyBaseUrl) releaseComfySocket(activeRun.comfyBaseUrl)
  activeRun = null
  runnerDeps = null
}

// ── Run internals ────────────────────────────────────────────────────────────

function clientDeps(): ComfyClientDeps {
  return {
    getServiceBaseUrl: () =>
      runnerDeps?.getComfyService()?.currentStatus === 'running'
        ? runnerDeps.getComfyService()!.baseUrl
        : null,
    getToken: () => runnerDeps?.getComfyService()?.getLoopbackAuthToken() ?? '',
  }
}

function emitItem(run: ActiveRun, item: MediaItem): void {
  const index = run.items.findIndex((existing) => existing.id === item.id)
  if (index === -1) run.items.push(item)
  else run.items[index] = item
  emitArtifactItem(artifactRunTag(run.payload), item)
}

function setPhase(
  run: ActiveRun,
  phase: ArtifactPhase,
  progress?: { current: number; max: number },
): void {
  if (run.settled) return
  run.phase = phase
  emitArtifactPhase(artifactRunTag(run.payload), phase, progress)
  if (phase === 'running') {
    const current = run.items[run.generateIdx]
    if (current?.state === 'queued') {
      emitItem(run, { ...current, state: 'generating' } as MediaItem)
    }
  }
  armIdleTimeout(run)
}

function armIdleTimeout(run: ActiveRun): void {
  if (run.idleTimer) clearTimeout(run.idleTimer)
  run.idleTimer = setTimeout(() => {
    appLogger.warn('Generation stalled (no progress for 5 minutes)', 'electron-backend')
    failRun(run, 'Generation stalled (no progress for 5 minutes)', true)
  }, GENERATION_IDLE_TIMEOUT_MS)
}

function isDoneWithMedia(item: MediaItem): boolean {
  return (
    item.state === 'done' &&
    ((item.type === 'image' && !!item.imageUrl && item.imageUrl !== PLACEHOLDER_URL) ||
      (item.type === 'video' && !!item.videoUrl) ||
      (item.type === 'model3d' && !!item.model3dUrl))
  )
}

function doneItems(run: ActiveRun): MediaItem[] {
  return run.items.filter(isDoneWithMedia)
}

function settleItems(run: ActiveRun, state: 'failed' | 'stopped'): void {
  for (const item of run.items) {
    if (item.state === 'queued' || item.state === 'generating') {
      emitItem(run, { ...item, state } as MediaItem)
    }
  }
}

function persistRendererGallery(run: ActiveRun): void {
  if (runOrigin(run.payload) !== 'renderer') return
  const items = doneItems(run)
  if (items.length === 0) return
  void saveMediaItems(items).catch((error) => {
    appLogger.warn(`Media record persist failed: ${extractMessage(error)}`, 'electron-backend')
  })
}

function finish(run: ActiveRun, result: ArtifactRunResult): void {
  if (run.settled) return
  run.settled = true
  if (run.idleTimer) {
    clearTimeout(run.idleTimer)
    run.idleTimer = null
  }
  run.statusWatch?.()
  run.statusWatch = null
  persistRendererGallery(run)
  emitArtifactPhase(
    artifactRunTag(run.payload),
    result.state === 'completed'
      ? 'completed'
      : result.state === 'cancelled'
        ? 'cancelled'
        : 'failed',
    undefined,
    result.error,
  )
  emitArtifactDone(artifactRunTag(run.payload), result.state, result.error)
  if (activeRun === run) {
    activeRun = null
    // Drop this run's websocket before a queued run binds new handlers —
    // leftover `executed` frames of the previous prompt would otherwise
    // land on the next run (one shared connection, one client).
    if (run.comfyBaseUrl) releaseComfySocket(run.comfyBaseUrl)
  }
  run.settle(result)
}

function failRun(run: ActiveRun, message: string, interrupt: boolean): void {
  if (run.settled) return
  emitFailure({
    category: 'generation',
    code: 'generation/failed',
    userMessage: message,
    surface: 'silent',
    context: { runId: run.payload.runId },
  })
  const baseUrl = clientDeps().getServiceBaseUrl()
  if (interrupt && baseUrl) {
    void interruptExecution(baseUrl, clientDeps()).catch(() => {})
    void clearQueue(baseUrl, clientDeps()).catch(() => {})
  }
  settleItems(run, 'failed')
  finish(run, { state: 'failed', items: doneItems(run), error: message })
}

function cancelRun(run: ActiveRun): void {
  if (run.settled) return
  const baseUrl = clientDeps().getServiceBaseUrl()
  if (baseUrl) {
    void interruptExecution(baseUrl, clientDeps()).catch(() => {})
    void clearQueue(baseUrl, clientDeps()).catch(() => {})
  }
  settleItems(run, 'stopped')
  finish(run, { state: 'cancelled', items: doneItems(run), error: 'Generation cancelled.' })
}

function checkCompletion(run: ActiveRun): void {
  if (run.settled) return
  if (run.items.some((item) => item.state === 'failed')) {
    finish(run, { state: 'failed', items: doneItems(run), error: 'Generation failed' })
    return
  }
  const completed = doneItems(run)
  if (completed.length >= run.payload.params.batchSize) {
    finish(run, { state: 'completed', items: completed })
  }
}

function buildItems(payload: ArtifactRunPayload): MediaItem[] {
  const baseSeed =
    payload.params.seed === -1 ? Math.floor(Math.random() * 1_000_000) : payload.params.seed
  return Array.from({ length: payload.params.batchSize }, (_, i) => ({
    id: randomUUID(),
    mode: payload.mode,
    sourceImageUrl: payload.source,
    state: 'queued' as const,
    type: 'image' as const,
    imageUrl: PLACEHOLDER_URL,
    settings: {
      preset: payload.preset.name,
      variant: resolvedVariantName(payload),
      prompt: payload.params.prompt,
      negativePrompt: payload.params.negativePrompt,
      batchSize: payload.params.batchSize,
      inferenceSteps: payload.params.inferenceSteps,
      seed: baseSeed + i,
      height: payload.params.height,
      width: payload.params.width,
      resolution: `${payload.params.width}x${payload.params.height}`,
      safetyCheck: payload.safetyCheck ?? true,
      showPreview: payload.showPreview ?? true,
    },
    dynamicSettings: payload.inputs.map((input) => ({
      ...input,
      current: input.current as never,
    })),
    createdAt: Date.now(),
  }))
}

function startRun(payload: ArtifactRunPayload): Promise<ArtifactRunResult> {
  if (!runnerDeps) {
    return Promise.resolve({
      state: 'failed',
      items: [],
      error: 'Artifact runner is not wired yet',
    })
  }
  const deps = runnerDeps
  const items = payload.items ?? buildItems(payload)
  const run: ActiveRun = {
    payload,
    items: [...items],
    generateIdx: 0,
    settle: () => {},
    cancel: () => {},
    statusWatch: null,
    idleTimer: null,
    settled: false,
    loaderNodes: [],
    phase: 'queued',
    clientId: `aipg-artifact-${payload.runId}`,
    comfyBaseUrl: null,
  }
  activeRun = run

  const result = new Promise<ArtifactRunResult>((resolve) => {
    run.settle = resolve
    run.cancel = () => cancelRun(run)
  })

  beginArtifactRunSnapshot({
    runId: payload.runId,
    mode: payload.mode,
    workflow: payload.preset.name,
    variant: resolvedVariantName(payload),
    origin: runOrigin(payload),
    owner: payload.owner,
    phase: 'queued',
  })
  for (const item of items) emitItem(run, item)
  emitArtifactPhase(artifactRunTag(payload), 'queued')

  driveRun(run, deps).then(
    () => {},
    (error: unknown) => {
      failRun(
        run,
        error instanceof Error
          ? error.message
          : 'The ComfyUI backend could not generate the image.',
        false,
      )
    },
  )
  return result
}

// ── The drive pass ───────────────────────────────────────────────────────────

async function installMissingRequirements(run: ActiveRun, preset: ComfyUiPreset): Promise<void> {
  const service = runnerDeps!.getComfyService()
  if (!service) throw new Error('ComfyUI backend service not found')

  const missingCustomNodes = (preset.requiredCustomNodes ?? []).filter(
    (node) => !isCustomNodeInstalled(parseCustomNodeSpec(node), service.serviceDir),
  )
  const missingPythonPackages: string[] = []
  for (const pkg of preset.requiredPythonPackages ?? []) {
    if (!(await isPackageInstalled(pkg))) missingPythonPackages.push(pkg)
  }
  if (missingCustomNodes.length === 0 && missingPythonPackages.length === 0) return

  setPhase(run, 'installing-components')
  // The status watch is not armed yet (it goes on after the backend is
  // running), so this intentional stop/start cannot be mistaken for a crash.
  const wasRunning = service.currentStatus === 'running'
  if (wasRunning) await service.stop()
  try {
    for (const pkg of missingPythonPackages) {
      await installPypiPackage(pkg, service.getTorchBackendEnv())
    }
    for (const node of missingCustomNodes) {
      const installed = await downloadCustomNode(parseCustomNodeSpec(node), service.serviceDir, {
        extraEnv: service.getTorchBackendEnv(),
        skipExtraWheels: service.comfyUiVariantName !== 'xpu',
      })
      if (!installed) throw new Error(`Failed to install custom node: ${node}`)
    }
  } finally {
    if (wasRunning) {
      const status = await service.start()
      if (status !== 'running') {
        throw new Error('Failed to restart comfyUI. Required Nodes are not active.')
      }
    }
  }
}

async function ensureDummyFixtures(run: ActiveRun, baseUrl: string): Promise<void> {
  if (!runnerDeps!.devPresetsEnabled()) return
  if (run.payload.preset.name !== DUMMY_3D_PRESET_NAME) return
  await uploadInputFile(baseUrl, clientDeps(), {
    name: 'aipg-dummy.glb',
    blob: buildDummyGlb(),
    subfolder: VIEW_FIXTURE.subfolder,
  })
  await uploadInputFile(baseUrl, clientDeps(), {
    name: VIEW_FIXTURE.name,
    blob: await solidViewPng(),
  })
}

/**
 * The 3D dummy's preview fixture. The renderer drew it on a canvas; main has
 * no DOM, so it is a hand-encoded 8x8 PNG (zlib + CRC32) — same bytes a canvas
 * would have produced for the fill color.
 */
function solidViewPng(): Blob {
  const width = 8
  const height = 8
  const rgb = [0x5a, 0x6e, 0xa0]
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const offset = y * (1 + width * 3)
    for (let x = 0; x < width; x++) {
      raw[offset] = 0 // filter: none
      raw[offset + 1 + x * 3] = rgb[0]
      raw[offset + 2 + x * 3] = rgb[1]
      raw[offset + 3 + x * 3] = rgb[2]
    }
  }
  const idat = deflateSync(raw)

  const crcTable: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buffer: Buffer): number => {
    let crc = 0xffffffff
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const typeBuffer = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
    return Buffer.concat([length, typeBuffer, data, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return new Blob([png], { type: 'image/png' })
}

async function startBackendAndWait(run: ActiveRun): Promise<string | null> {
  const service = runnerDeps!.getComfyService()
  if (!service) throw new Error('ComfyUI backend service not found')
  if (service.currentStatus === 'running') return service.baseUrl

  // Subscribe before start(): a start() that reaches 'running' without a
  // status event (or fires one before a later subscription would exist) must
  // not hang the run.
  const running = new Promise<string | null>((resolve) => {
    run.statusWatch = runnerDeps!.onServiceStatusChange((status) => {
      if (status === 'running') resolve(runnerDeps!.getComfyService()?.baseUrl ?? null)
    })
  })
  if (service.currentStatus !== 'starting') {
    const result = await service.start()
    if (result !== 'running' && result !== 'starting') {
      throw new Error(`ComfyUI backend status: ${result}`)
    }
  }
  if (service.currentStatus === 'running') {
    run.statusWatch?.()
    run.statusWatch = null
    return service.baseUrl
  }
  // Boot produces no progress signals; the idle watchdog is the only bound.
  return await running
}

/** Crash detection: the backend leaving 'running' mid-run fails the run. */
function armCrashWatch(run: ActiveRun): void {
  run.statusWatch?.()
  run.statusWatch = runnerDeps!.onServiceStatusChange((status) => {
    if (status !== 'running' && !run.settled) {
      failRun(run, 'The ComfyUI backend stopped unexpectedly.', true)
    }
  })
}

function handleWebsocketMessage(run: ActiveRun, msg: unknown): void {
  if (run.settled || activeRun !== run) return
  let parsed: ReturnType<typeof ComfyMessageSchema.parse>
  try {
    parsed = ComfyMessageSchema.parse(msg)
  } catch (error) {
    appLogger.warn(`Unhandled ComfyUI message: ${error}`, 'electron-backend')
    return
  }
  switch (parsed.type) {
    case 'progress':
      setPhase(run, 'running', { current: parsed.data.value, max: parsed.data.max })
      break
    case 'executing': {
      const executingNode = parsed.data.node
      if (executingNode && run.loaderNodes.includes(executingNode)) {
        setPhase(run, 'loading-model')
      } else if (executingNode !== null) {
        setPhase(run, 'running')
      }
      break
    }
    case 'executed': {
      const output = parsed.data.output
      const current = run.items[run.generateIdx]
      if (!current) break
      const createdAt = Date.now()
      const relative = (subfolder?: string, filename?: string) =>
        mediaUrl(subfolder && filename ? `${subfolder}/${filename}` : (filename ?? ''))
      const image = 'images' in output ? output.images.find((i) => i.type === 'output') : undefined
      const video = 'gifs' in output ? output.gifs.find((i) => i.type === 'output') : undefined
      const model3d =
        '3d' in output
          ? (output['3d'] as { type: string; subfolder?: string; filename: string }[]).find(
              (i) => i.type === 'output',
            )
          : undefined
      let patch: Partial<MediaItem> | null = null
      if (image) {
        patch =
          'animated' in output &&
          Array.isArray(output.animated) &&
          output.animated[output.images.indexOf(image)]
            ? { type: 'video', videoUrl: relative(image.subfolder, image.filename) }
            : { type: 'image', imageUrl: relative(image.subfolder, image.filename) }
      } else if (video) {
        patch = {
          type: 'video',
          videoUrl: relative(video.subfolder, video.filename),
          thumbnailUrl: relative(video.subfolder, video.workflow),
        }
      } else if (model3d) {
        patch = { type: 'model3d', model3dUrl: relative(model3d.subfolder, model3d.filename) }
      }
      if (patch) {
        emitItem(run, {
          ...(current as MediaItem),
          state: 'done',
          createdAt,
          ...patch,
        } as MediaItem)
        run.generateIdx++
      }
      if (run.generateIdx >= run.items.length) checkCompletion(run)
      break
    }
    case 'execution_start':
      setPhase(run, 'loading-components')
      break
    case 'execution_success':
      checkCompletion(run)
      break
    case 'execution_error': {
      const userMessage = summarizeComfyExecutionError(parsed.data)
      appLogger.error(
        `ComfyUI execution error: ${parsed.data.exception_type}: ${parsed.data.exception_message}`,
        'electron-backend',
      )
      failRun(run, userMessage, false)
      break
    }
    case 'execution_interrupted':
      cancelRun(run)
      break
    default:
      break
  }
}

function handleBinaryPreview(run: ActiveRun, mime: string, bytes: ArrayBuffer): void {
  if (run.settled || activeRun !== run) return
  if (run.payload.showPreview === false) return
  const current = run.items[run.generateIdx]
  if (!current || current.state === 'done') return
  const base64 = Buffer.from(bytes).toString('base64')
  emitItem(run, {
    ...(current as MediaItem),
    state: 'generating',
    type: 'image',
    imageUrl: `data:${mime};base64,${base64}`,
  } as MediaItem)
}

async function driveRun(run: ActiveRun, deps: ArtifactRunnerDeps): Promise<void> {
  armIdleTimeout(run)
  setPhase(run, 'preparing-backend')

  // In-process tool runs did not go through the renderer's model pre-flight.
  if (run.payload.modelsConsented !== true) {
    const missing = await deps.modelsMissing(run.payload.preset)
    if (missing.length > 0) {
      const approved = await deps.requestModelConsent(missing, () => armIdleTimeout(run))
      if (!approved) {
        cancelRun(run)
        return
      }
    }
  }

  const missingInputs = validateRequiredImageInputs(run.payload.inputs)
  if (missingInputs.length > 0) {
    failRun(run, `Missing required image inputs: ${missingInputs.join(', ')}`, false)
    return
  }

  await installMissingRequirements(run, run.payload.preset)
  if (run.settled) return

  const baseUrl = await startBackendAndWait(run)
  if (run.settled) return
  if (!baseUrl) throw new Error('ComfyUI backend did not reach running state')
  run.comfyBaseUrl = baseUrl
  armCrashWatch(run)

  await ensureDummyFixtures(run, baseUrl)
  if (run.settled) return

  let ovmsImageUrl: string | null = null
  if (workflowUsesOvmsImage(run.payload.preset.comfyUiApiWorkflow)) {
    const modelInput = run.payload.inputs.find(
      (input) => 'nodeInput' in input && input.nodeInput === 'model',
    )
    const modelId =
      (modelInput ? String(modelInput.current) : '') ||
      run.payload.preset.requiredModels?.[0]?.model ||
      ''
    if (!modelId) {
      failRun(run, 'No model id configured for OVMS image generation.', false)
      return
    }
    const result = await deps.ensureOvmsImageReady(
      modelId,
      run.payload.keepModelsLoaded ?? false,
      `${run.payload.params.width}x${run.payload.params.height}`,
    )
    if (!result.success) {
      failRun(run, `Failed to start OVMS image server: ${result.error}`, false)
      return
    }
    ovmsImageUrl = result.url
  }

  const workflow = await rewriteWorkflowForRun(
    run.payload.preset,
    {
      prompt: run.payload.params.prompt,
      negativePrompt: run.payload.params.negativePrompt,
      inferenceSteps: run.payload.params.inferenceSteps,
      width: run.payload.params.width,
      height: run.payload.params.height,
    },
    run.payload.inputs,
    deps.getPlatform(),
    ovmsImageUrl,
    {
      readMediaAsDataUri: deps.readMediaAsDataUri,
      uploadInputFile: (file) => uploadInputFile(baseUrl, clientDeps(), file),
    },
  )
  run.loaderNodes = [
    ...findKeysByClassType(workflow, 'CheckpointLoaderSimple'),
    ...findKeysByClassType(workflow, 'Unet Loader (GGUF)'),
    ...findKeysByClassType(workflow, 'DualCLIPLoader (GGUF)'),
  ]

  const socket = getComfySocket(baseUrl, clientDeps(), run.clientId, {
    onBinaryPreview: (mime, bytes) => handleBinaryPreview(run, mime, bytes),
    onJson: (msg) => handleWebsocketMessage(run, msg),
    onClose: (code) => {
      if (!run.settled && activeRun === run && code !== WEBSOCKET_CLOSED_BY_POLICY) {
        failRun(run, `The ComfyUI websocket closed unexpectedly (code ${code}).`, true)
      }
    },
  })
  try {
    await socket.opened
  } catch (error) {
    throw new Error(
      `Could not open the ComfyUI progress websocket: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (run.settled) return

  // One queued prompt per batch entry, seed spliced in per item — the batch
  // shares every other resolved value.
  for (const item of run.items) {
    const seeded: ComfyUIApiWorkflow = structuredClone(workflow)
    modifySettingInWorkflow(seeded, 'seed', `${(item.settings.seed ?? 0).toFixed(0)}`)
    await submitPrompt(baseUrl, clientDeps(), seeded, run.clientId)
  }
  setPhase(run, 'loading-components')
}
