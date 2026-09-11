import { test, expect } from './fixtures'

// Model management, exercised against the real app as ONE test: launching the app,
// installing the backends and verifying their versions costs minutes, so everything
// the library has to get right is checked in a single session.
//
// It covers the surfaces that are easy to break from a distance — the catalog list,
// the use-case/name/backend filters, favorites, and the batch actions — and then puts
// the library through the round trip that actually matters: delete the target model if
// a previous run left it behind, download it from the library, prove the download
// reached the disk by using it in a chat preset *without* a download dialog, and
// delete it again. Downloading is what makes this the slow spec in the suite, so the
// model is the smallest LLM in the catalog for the backend under test.

/**
 * The smallest chat model per backend, as of the current `WebUI/external/models.json`:
 * SmolLM2-1.7B-Instruct Q4_K_M is 1.06 GB (the only GGUF below the DeepSeek-R1 1.5B
 * Q4_K_S at 1.07 GB) and the TinyLlama-1.1B OpenVINO IR is 0.64 GB. Both are plain
 * instruct models — no reasoning, no tool calling — so a chat turn is a single short
 * reply, and the Chat settings' tool section (which only renders for tool-calling
 * models) stays out of their small context window.
 *
 * Hard-coded rather than derived: the library sorts by *on-disk* size, which is blank
 * for a model that hasn't been downloaded, so "the smallest" cannot be read off the UI.
 * Revisit when the catalog gains something smaller.
 */
const TARGETS = {
  'llamaCPP - GGUF': {
    label: 'smollm2-1.7b-instruct-q4_k_m.gguf',
    repo: 'HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF',
    /** The "Assistant" preset's `preferredModels` entries for this backend. */
    presetDefaults: ['Qwen3.5-9B-Q4_K_M.gguf'],
  },
  OpenVINO: {
    label: 'TinyLlama-1.1B-Chat-v1.0-int4-ov',
    repo: 'OpenVINO',
    /**
     * Two entries because OpenVINO ships this model twice and the picker offers
     * exactly one of them, decided by the inference device: ModelSelector filters
     * out `npuSupport` models on GPU and non-`npuSupport` models on NPU, and the
     * `-cw-` (channel-wise) build is the NPU one. Whichever device the run has
     * landed on by then is the variant that exists, so the restore below takes the
     * one on offer rather than assuming.
     */
    presetDefaults: ['Qwen3-8B-int4-ov', 'Qwen3-8B-int4-cw-ov'],
  },
} as const

type BackendLabel = keyof typeof TARGETS

/** A short, low-context prompt any 1B-class instruct model can answer in one line. */
const PROMPT = 'In one short sentence: what colour is the sky on a clear day?'

test('the model library lists, filters and round-trips a model through download, use and delete', async ({
  app,
}) => {
  // One model download (~1 GB) plus backend installation and a chat turn.
  test.setTimeout(40 * 60_000)
  await app.installAllBackends()

  // Which backend the library is exercised for decides which model is downloaded, so
  // it is settled first. As in the chat preset specs: llama.cpp on NVIDIA (where the
  // app filters OpenVINO out and the picker may not even be shown), and a random one
  // of the two on Intel/OpenVINO modes.
  const presetActive = await app.main.selectPreset('Chat', 'Assistant')
  test.skip(!presetActive, 'The "Assistant" preset is not available in this product mode')

  let offered: string[] = []
  let backend: BackendLabel = 'llamaCPP - GGUF'
  await test.step('Pin the chat backend for this run', async () => {
    await app.settings.open('Chat')
    offered = await app.settings.availableBackends('Chat')
    backend = offered.includes('OpenVINO')
      ? Math.random() < 0.5
        ? 'OpenVINO'
        : 'llamaCPP - GGUF'
      : 'llamaCPP - GGUF'
    if (offered.includes(backend)) {
      await app.settings.selectBackend(backend, 'Chat')
    }
    await app.settings.close('Chat')
    test.info().annotations.push({ type: 'chat-backend', description: backend })
  })

  const target = TARGETS[backend]
  // OpenVINO on offer means this is not an NVIDIA install, which decides how many
  // backends a category can hold: NVIDIA builds drop every OpenVINO row, so
  // categories that span both backends collapse to one there and not here.
  const isNvidia = !offered.includes('OpenVINO')

  await test.step('Open the model library', async () => {
    await app.models.open()
  })

  await test.step('The library lists the model catalog', async () => {
    // The bundled catalog alone is dozens of models, so any sane threshold
    // proves the list was derived rather than left empty.
    expect(await app.models.rows.count()).toBeGreaterThan(10)
  })

  await test.step('Filtering by name narrows to the matching model', async () => {
    await app.models.search(target.label)
    await app.models.expectRowVisible(target.label)
    expect(await app.models.rows.count()).toBe(1)
  })

  await test.step('A search that matches nothing empties the table', async () => {
    await app.models.search('no-such-model-anywhere')
    await app.models.expectRowAbsent(target.label)
    expect(await app.models.rows.count()).toBe(0)
    await app.models.search('')
  })

  await test.step('The use-case sidebar filters to one kind of model', async () => {
    await app.models.selectUseCase('Embedding')
    const labels = await app.models.visibleLabels()
    expect(labels.length).toBeGreaterThan(0)
    // The chat catalog's LLMs must not leak into the embedding list.
    expect(labels).not.toContain(target.label)
    await app.models.selectUseCase('All')
  })

  await test.step('Speech models are listed even though no picker offers them', async () => {
    await app.models.selectUseCase('Speech')
    // STT/TTS load fixed repos with no picker, so the library is the only place
    // they can be seen or pre-fetched.
    expect(await app.models.rows.count()).toBeGreaterThan(0)
  })

  await test.step('A filter with one possible value is stuck on it', async () => {
    // "Media creation" is the reliable single-backend category on NVIDIA: every
    // media model is ComfyUI's except the `openvino-image` ones, and those are
    // filtered out there. (Speech no longer works as the vehicle — it now spans
    // Qwen3-TTS *and* the standalone Whisper sidecar, both of which survive the
    // NVIDIA filter, so its Backend list has two entries.)
    if (isNvidia) {
      await app.models.selectUseCase('Media creation')
      await expect(app.models.backendFilter).toBeDisabled()
    }
    await app.models.selectUseCase('All')
    // A mixed category always has more than one, so there it is live either way.
    await expect(app.models.backendFilter).toContainText('All backends')
    await expect(app.models.backendFilter).toBeEnabled()
  })

  await test.step('Favoriting a model sorts it to the top of the library', async () => {
    await app.models.toggleFavorite(target.label)
    expect((await app.models.visibleLabels())[0]).toBe(target.label)

    await app.models.selectUseCase('Favorites')
    expect(await app.models.visibleLabels()).toContain(target.label)
    await app.models.selectUseCase('All')

    // Leave the library as it was found: preferences persist across runs.
    await app.models.toggleFavorite(target.label)
  })

  await test.step('With nothing selected both batch actions are disabled', async () => {
    // They stay in the toolbar rather than being hidden, so the layout does not
    // reflow as rows are ticked.
    await expect(app.models.downloadSelectedButton).toBeVisible()
    await expect(app.models.downloadSelectedButton).toBeDisabled()
    await expect(app.models.deleteSelectedButton).toBeVisible()
    await expect(app.models.deleteSelectedButton).toBeDisabled()
  })

  await app.models.search(target.label)

  await test.step('A model left on disk by an earlier run is deleted first', async () => {
    // The download half of this test only means something starting from nothing on
    // disk, and deleting from the row action covers that path too (the batch delete
    // is exercised at the end).
    if (await app.models.isDownloaded(target.label)) {
      await app.models.deleteFromRow(target.label)
    }
    await app.models.expectDownloaded(target.label, false)
  })

  await test.step('Selecting a downloadable model enables only the download action', async () => {
    await app.models.select(target.label)
    await expect(app.models.downloadSelectedButton).toBeEnabled()
    // Nothing selected is on disk, so deletion stays unavailable.
    await expect(app.models.deleteSelectedButton).toBeDisabled()
  })

  await test.step(`Download ${target.label} from the library`, async () => {
    await app.models.downloadSelectedButton.click()
    const listed = await app.downloads.listedModels()
    // The dialog keys rows on the full repo id, of which the label is the tail.
    expect(listed.some((id) => id.includes(target.label))).toBe(true)
    expect(listed.some((id) => id.startsWith(target.repo))).toBe(true)

    const outcome = await app.downloads.resolve()
    test.skip(
      outcome === 'blocked',
      `Skipping: ${target.label} is gated / unavailable without Hugging Face access in this environment`,
    )
    expect(outcome).toBe('downloaded')
    await app.models.expectDownloaded(target.label, true, 60_000)
  })

  await app.models.close()

  await test.step('The downloaded model is usable in a preset without a download', async () => {
    await app.settings.open('Chat')
    await app.settings.selectModel(target.label)
    await app.settings.close('Chat')

    await app.main.sendPrompt(PROMPT)
    // The whole point of downloading from the library: the model is on disk, so the
    // turn must not stop to fetch it. `resolve()` returns 'none' when no dialog shows.
    expect(
      await app.downloads.resolve(),
      'a model downloaded from the library must not be re-requested by the preset that uses it',
    ).toBe('none')
    await app.main.waitForAssistantAnswer()
    expect(await app.main.lastAssistantText()).not.toEqual('')
    await app.main.assertWellFormedResponse()
  })

  await test.step('Unload the model so its files can be deleted', async () => {
    // The turn above left the model loaded in the backend, and a backend that still
    // holds the weights open makes the delete below fail on Windows ("stop the backend
    // and try again"). Nothing in the UI stops a backend, but changing the inference
    // device restarts one, which is enough to release the files. Best-effort: a
    // machine with a single device has nothing to switch to, and llama.cpp loads
    // without mmap anyway, so the delete is asserted either way. The next spec's
    // installAllBackends() re-pins every preset to the default GPU.
    await app.settings.open('Chat')
    const switched = await app.settings.selectOtherDevice('Chat')
    await app.settings.close('Chat')
    test.info().annotations.push({
      type: 'model-unload',
      description: switched
        ? 'switched inference device to restart the backend'
        : 'no second inference device — backend left running',
    })
  })

  await test.step('Deleting the model from the library reclaims it', async () => {
    await app.models.open()
    await app.models.search(target.label)
    await app.models.select(target.label)
    // Mirror image of the download: on disk, only the destructive action applies.
    await expect(app.models.deleteSelectedButton).toBeEnabled()
    await expect(app.models.downloadSelectedButton).toBeDisabled()

    await app.models.deleteSelectedButton.click()
    await app.models.confirmDelete(target.label)
    await app.models.expectDownloaded(target.label, false, 60_000)
    await app.models.search('')
    await app.models.close()
  })

  await test.step('Put the "Assistant" preset back on its default model', async () => {
    // The model picked in Chat settings is saved *per preset* and outlives this spec,
    // and the tiny model used above cannot call tools — which hides the whole tool
    // section (SettingsBuiltinTools.vue) and breaks the agentic specs that come after.
    // Deleting it doesn't help: the picker then falls back to the first catalog entry,
    // which is a non-tool-calling model too. So restore the preset's own default
    // explicitly, the way the Text-to-Speech flow re-pins its voice.
    //
    // Whichever of its builds this device offers: the step above deliberately moved
    // the inference device to unload the model, and on OpenVINO that decides which
    // variant the picker lists at all (see TARGETS).
    await app.settings.open('Chat')
    const restored = await app.settings.selectFirstOfferedModel(target.presetDefaults)
    test.info().annotations.push({ type: 'preset-default-restored', description: restored })
    await app.settings.close('Chat')
  })
})
