import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { UIMessage } from 'ai'
import { backendToAipgBackendName, useTextInference } from './textInference'
import { useModels } from './models'
import { useCloudMode } from './cloudMode'
import { usePresets, type ChatPreset } from './presets'
import { usePresetSwitching } from './presetSwitching'
import { useConfirmations } from './confirmations'
import { useOemBranding } from './oemBranding'
import { useErrors } from './errors'
import { useI18N } from './i18n'
import { unregisterAgentModeIpc } from './agentModeIpc'
import { demoAwareStorage } from '../demoAwareStorage'
import { makeForwardPersist } from '@/lib/ipcPersist'
import { cloneForIpc } from '@/lib/cloneForIpc'
import {
  makeFileBackedPreference,
  type FileBackedPreferencesApi,
} from '@/lib/fileBackedPreferences'
import {
  LegacyAgentSessionStateSchema,
  type AgentSessionBootstrap,
  type LegacyAgentSessionState,
} from '@/types/agentSessionIpc'
import { withResponseLanguage } from '@/lib/responseLanguage'
import { ragEmbeddingPrepFailure } from '@/lib/ragEmbeddingPrep'
import { requestDownload } from '@/assets/js/permissions/permissions'
import {
  DEFAULT_CAPABILITY_IDS,
  GAME_STUDIO_QUICK_ID,
  OFFER_GAME_AGENT_TOOL,
  RAG_PREPARE_EMBEDDING_MODEL,
} from '@/types/agentCapabilities'
import type { GameLibraryEntry } from '@/types/agentIpc'
import {
  AGENT_PRESET,
  applySessionPresetNames,
  computedPresetSessions,
  ensureSessionId,
  GAME_AGENT_PRESET,
  gameAgentHandoffPrompt,
  migrateMcpServerIdsIntoCapabilities,
  mintSessionId,
  snapshotSession,
  takeLegacyPlanningThinkingOnly,
  toggleCapabilityIds,
  type AgentSessionRecord,
} from './agentModeSessions'
import { buildTurnConfig, createAgentTurnRuntime, latestTurnMetadata } from './agentModeTurn'
import {
  createUnsandboxedWorkspaces,
  createWorkspaceAttachments,
  isGameFolder,
  reconcileGamesWorkspace,
} from './agentModeWorkspace'

export type { AgentSessionRecord }

// ── Agent Mode: renderer side of the Pi coding-agent integration ─────────────
//
// The Pi session runs in the Electron main process
// (electron/agent/piAgentManager.ts). This store owns the UI state
// (workspace folder, sandbox consent) and a custom ChatTransport whose
// sendMessages() triggers `agentMode:startTurn` over IPC and reconstructs the UI
// message chunk stream from `agentMode:streamChunk` pushes — feeding a standard
// @ai-sdk/vue Chat instance so the existing part renderers work unchanged.
// Backend/model selection is fully shared with Chat (textInference + cloudMode)
// — no agent-specific model settings.
//
// There is at most one live Pi session and one workspace preview server. Switching
// conversation or workspace (newSession, switchSession, adoptWorkspace, newGame)
// stops the current turn and the next prompt rebuilds the main-process session
// when the config key (session id, folder, model, tools) no longer matches. Two
// conversations cannot run in parallel.

/**
 * Capabilities a new session starts with. Same list as DEFAULT_CAPABILITY_IDS;
 * persisted from then on as the user's own selection.
 */
const DEFAULT_CAPABILITIES = [...DEFAULT_CAPABILITY_IDS]

/** The Pinia persistence key this store wrote before session records moved to files. */
const LEGACY_AGENT_MODE_KEY = 'agentMode'

export const useAgentMode = defineStore(
  'agentMode',
  () => {
    const textInference = useTextInference()
    const models = useModels()
    const cloudMode = useCloudMode()
    const presetsStore = usePresets()
    const presetSwitching = usePresetSwitching()
    const confirmations = useConfirmations()
    const oemBranding = useOemBranding()
    const errors = useErrors()
    const i18n = useI18N()

    const workspaceDir = ref<string>('')

    /**
     * The agent preset driving the session, if any. Agent Mode is entered by
     * selecting a chat preset marked `agentPreset` (Agent, Game Agent), and that
     * preset supplies the extra instructions and the capability set.
     *
     * Remembered rather than read live, because the active preset can change
     * under a running turn — the user clicking another preset mid-turn must
     * not swap the session's capabilities, instructions and workspace policy
     * while the agent is working, and the workspace watcher below would stop
     * the very turn that was interrupted.
     */
    const agentPresetName = ref<string>('')

    const activeAgentPreset = computed<ChatPreset | null>(() => {
      const active = presetsStore.activePresetWithVariant
      if (active?.type === 'chat' && active.name === agentPresetName.value) {
        return active as ChatPreset
      }
      const remembered = presetsStore.presets.find((p) => p.name === agentPresetName.value)
      return remembered?.type === 'chat' ? (remembered as ChatPreset) : null
    })

    watch(
      () => presetsStore.activePresetWithVariant,
      (preset) => {
        if (preset?.type === 'chat' && (preset as ChatPreset).agentPreset) {
          agentPresetName.value = preset.name
        }
      },
      { immediate: true },
    )

    const presetCapabilities = computed<string[] | null>(() => {
      const declared = activeAgentPreset.value?.agentCapabilities
      return declared && declared.length > 0 ? declared : null
    })

    const agentWorkspaceKind = computed<'pick' | 'games'>(
      () => activeAgentPreset.value?.agentWorkspace ?? 'pick',
    )

    function workspaceKindOf(presetName: string): 'pick' | 'games' {
      const preset = presetsStore.presets.find((entry) => entry.name === presetName)
      return preset?.type === 'chat' ? ((preset as ChatPreset).agentWorkspace ?? 'pick') : 'pick'
    }

    const currentGame = ref<GameLibraryEntry | null>(null)
    const lastWorkspaceByKind = ref<Record<string, string>>({})
    const defaultCapabilities = ref<string[]>([...DEFAULT_CAPABILITIES])
    const mcpServerIds = ref<string[]>([])

    const { unsandboxedWorkspaces, unsandboxed, setUnsandboxed } =
      createUnsandboxedWorkspaces(workspaceDir)

    const sessions = ref<Record<string, AgentSessionRecord>>({})
    const activeSessionId = ref<string>('')
    /** Set once `init()` has hydrated (or migrated) — gates every write-through. */
    const sessionsHydrated = ref(false)

    // Step 8 (§6.1): the last-used workspace pointers are app data — their
    // own kernel-owned file (agent-workspace.json), not the preferences file.
    // The pinia key keeps the user preferences, so this half only slims its
    // fields out of it.
    const workspaceApi: FileBackedPreferencesApi = {
      read: async () => {
        const r = await window.electronAPI.agentMode.readWorkspaceState()
        if (!r.success) return { success: false as const, error: r.error }
        // An absent file is the "never migrated" state; a failed read
        // (success false) never is.
        return r.section === null
          ? { success: true as const, sections: {} }
          : { success: true as const, sections: { agentWorkspace: r.section } }
      },
      migrate: (_section, payload) => window.electronAPI.agentMode.migrateWorkspaceState(payload),
      write: (_section, value) => window.electronAPI.agentMode.writeWorkspaceState(value),
    }
    const workspacePrefs = makeFileBackedPreference({
      section: 'agentWorkspace',
      refs: { workspaceDir, lastWorkspaceByKind },
      legacyKey: 'agentMode',
      legacySlim: true,
      api: workspaceApi,
      errorScope: 'agent-workspace',
    })
    if (import.meta.hot) import.meta.hot.dispose(() => workspacePrefs.dispose())
    let agentSessionsInitPromise: Promise<void> | null = null
    /** Set while a session is deliberately moved between presets, so the watcher below leaves it. */
    let movingSession = false

    const presetSessions = computedPresetSessions(sessions, agentPresetName)
    const sessionCapabilities = ref<string[] | null>(null)

    /** An accepted `offer_game_agent`, waiting for the turn that offered it to end. */
    const pendingHandoff = ref<{ summary: string; request: string } | null>(null)

    const capabilities = computed<string[]>(
      () =>
        sessions.value[activeSessionId.value]?.capabilities ??
        sessionCapabilities.value ??
        presetCapabilities.value ??
        defaultCapabilities.value,
    )

    function isCapabilityEnabled(id: string): boolean {
      return capabilities.value.includes(id)
    }

    function setCapabilityEnabled(id: string, enabled: boolean): void {
      const next = toggleCapabilityIds(capabilities.value, id, enabled)
      if (presetCapabilities.value) sessionCapabilities.value = next
      else defaultCapabilities.value = next
      const session = sessions.value[activeSessionId.value]
      if (!session) return
      rewriteSession(activeSessionId.value, { ...session, capabilities: next })
    }

    /**
     * "Reset Preset Settings" for Agent Mode: put the settings this panel owns
     * back to what the preset (or the built-in default) asks for. The active
     * session carries its own capability copy, so it is re-stamped too —
     * otherwise the checkboxes would snap straight back on the next read.
     *
     * Workspace folder, sandbox consent and the sessions themselves are
     * user-owned state, not preset settings, and are left alone. The shared
     * model settings are reset by textInference's own reset.
     */
    function resetPresetSettings(): void {
      planningThinkingOnly.value = true
      sessionCapabilities.value = null
      defaultCapabilities.value = [...DEFAULT_CAPABILITIES]
      const session = sessions.value[activeSessionId.value]
      if (!session) return
      // Not `capabilities.value`: that still reads the session's own copy, which
      // is the very override being cleared here.
      const restored = presetCapabilities.value ?? defaultCapabilities.value
      rewriteSession(activeSessionId.value, { ...session, capabilities: [...restored] })
    }

    async function migrateSessionPresets(): Promise<void> {
      const legacy = Object.values(sessions.value).filter((session) => !session.presetName)
      const gameFolders = new Set<string>()
      if (legacy.length > 0) {
        const games = await window.electronAPI.games.list()
        for (const game of games) gameFolders.add(game.dir)
      }
      sessions.value = applySessionPresetNames(sessions.value, gameFolders)
    }

    // ── Hydration (step 8, architecture-target §6.1) ─────────────────────────────
    //
    // Session records — transcripts included — live as kernel-owned files
    // (`AI-Playground/agent-sessions/`); this store is the live projection.
    // `init()` runs once before the app mounts, so the Sessions panel and a
    // resumed turn never see a half-hydrated map.

    /** The pre-step-8 Pinia-persisted payload, read once for the legacy upload. */
    function readLegacyAgentSessions(): LegacyAgentSessionState | null {
      const raw = demoAwareStorage.getItem(LEGACY_AGENT_MODE_KEY)
      if (!raw) return null
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        return LegacyAgentSessionStateSchema.parse({
          sessions: parsed.sessions ?? {},
          activeSessionId:
            typeof parsed.activeSessionId === 'string' ? parsed.activeSessionId : null,
        })
      } catch {
        return null
      }
    }

    /**
     * Files own the records now, so the legacy copies leave the Pinia key —
     * including a leftover empty payload, which would otherwise linger (and
     * keep the multi-megabyte transcripts in localStorage) forever. Kept when
     * the upload failed, so the next boot can retry it.
     */
    function stripLegacyAgentSessions(): void {
      const raw = demoAwareStorage.getItem(LEGACY_AGENT_MODE_KEY)
      if (!raw) return
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        delete parsed.sessions
        delete parsed.activeSessionId
        demoAwareStorage.setItem(LEGACY_AGENT_MODE_KEY, JSON.stringify(parsed))
      } catch {
        // Unreadable leftover: the persist plugin's next write replaces the
        // key wholesale with only the picked fields, so it heals itself.
      }
    }

    async function init(): Promise<void> {
      if (agentSessionsInitPromise) return agentSessionsInitPromise
      agentSessionsInitPromise = (async () => {
        let bootstrap: AgentSessionBootstrap | { status: 'error'; error: string } | null = null
        let bootstrapError: unknown = null
        try {
          bootstrap = await window.electronAPI.agentMode.bootstrapSessions()
          // One-shot legacy upload (§6.1: "localStorage migrates once"): a
          // first boot with no index uploads whatever the old persisted state
          // held, then the key is slimmed so it never runs or dual-writes
          // again.
          if (
            bootstrap.status === 'empty' ||
            (bootstrap.status === 'ok' && bootstrap.sessions.length === 0)
          ) {
            const legacy = readLegacyAgentSessions()
            if (legacy && Object.keys(legacy.sessions).length > 0) {
              bootstrap = await window.electronAPI.agentMode.migrateSessions(legacy)
            }
          }
          if (
            bootstrap.status === 'ok' ||
            (bootstrap.status === 'empty' && demoAwareStorage.getItem(LEGACY_AGENT_MODE_KEY))
          ) {
            stripLegacyAgentSessions()
          }
        } catch (error) {
          bootstrap = null
          bootstrapError = error
        }
        if (!bootstrap) {
          errors.report(bootstrapError ?? new Error('agent session bootstrap IPC failed'), {
            code: 'agent-sessions/bootstrap-failed',
            category: 'backend',
            severity: 'warning',
            surface: 'silent',
            technicalMessage:
              'the session file store did not answer; the session list may be empty this session',
          })
        } else if (bootstrap.status === 'error') {
          errors.report(new Error(bootstrap.error), {
            code: 'agent-sessions/bootstrap-failed',
            category: 'backend',
            severity: 'warning',
            surface: 'silent',
            technicalMessage: 'the session file store rejected the boot hydration',
          })
          bootstrap = null
        }
        if (bootstrap && bootstrap.status === 'ok') {
          const hydrated: Record<string, AgentSessionRecord> = {}
          for (const record of bootstrap.sessions) {
            hydrated[record.id] = { ...record, messages: record.messages as UIMessage[] }
          }
          sessions.value = hydrated
          // A missing id is not adopted. A corrupt file hydrates as a
          // placeholder (empty transcript) so the list keeps it.
          const activeId = bootstrap.activeSessionId
          if (activeId && hydrated[activeId]) activeSessionId.value = activeId
          restoreActiveSession()
          // Ran from the persist plugin's afterHydrate before the records moved
          // to files; it needs the hydrated records (and the games library).
          // Renamed records persist with their next snapshot, so legacy
          // sessions may re-run this once per boot — idempotent and bounded.
          await migrateSessionPresets()
        }
        sessionsHydrated.value = true
        // The workspace half of the same shared legacy key runs strictly
        // after the sessions half: interleaved read-modify-write slims can
        // resurrect what the other removed (§8.2).
        await workspacePrefs.init()
        // The agentWorkspaceKind watch can have fired before this hydrate
        // (preset files load during conversations/media init): a games-kind
        // flip against an empty workspace no-ops inside
        // reconcileGamesWorkspace, so the reconciliation the pinia
        // afterHydrate used to run repeats here against hydrated pointers.
        await reconcileWorkspaceKind()
        await refreshCurrentGame()
      })()
      return agentSessionsInitPromise
    }

    function migrateMcpServerIds(): void {
      const migrated = migrateMcpServerIdsIntoCapabilities(
        mcpServerIds.value,
        defaultCapabilities.value,
      )
      mcpServerIds.value = migrated.mcpServerIds
      defaultCapabilities.value = migrated.defaultCapabilities
    }

    // Agent Mode only: think through the plan, then stop thinking. Previously
    // persisted inside chat `settingsPerPreset`; copied from there on first
    // hydrate if this store has not stored it yet.
    const planningThinkingOnly = ref(true)

    function migratePlanningThinkingOnly(): void {
      const bags = textInference.settingsPerPreset
      if (!bags) return
      const { value, bags: next } = takeLegacyPlanningThinkingOnly(
        bags,
        agentPresetName.value || AGENT_PRESET,
      )
      if (typeof value === 'boolean') planningThinkingOnly.value = value
      if (next !== bags) textInference.settingsPerPreset = next
    }

    // Frozen per session so a later turn does not rebuild Pi (instructions are
    // part of the session key) or pick up a Language-selector change mid-run.
    const pendingResponseLocales: Record<string, string> = {}

    function sessionResponseLocale(sessionId: string): string {
      const stored = sessions.value[sessionId]?.responseLocale ?? pendingResponseLocales[sessionId]
      if (stored) return stored
      pendingResponseLocales[sessionId] = i18n.langName
      return pendingResponseLocales[sessionId]
    }

    // The rag capability (main process) asks for this before its first index:
    // the session-frozen embedding model may not be on disk yet, and the
    // renderer owns the download policy (shared dialog) plus the models store.
    async function prepareRagEmbeddingModel(input: Record<string, unknown>): Promise<unknown> {
      const model = typeof input.model === 'string' ? input.model : ''
      const backend = input.backend === 'openVINO' ? 'openVINO' : 'llamaCPP'
      if (!model) return { status: 'ready' }
      const checked = await models.checkModelAlreadyLoaded([
        { repo_id: model, type: 'embedding', backend: backendToAipgBackendName[backend] },
      ])
      const missing = checked.filter((m) => !m.already_loaded)
      if (missing.length === 0) return { status: 'ready' }
      // The permissions layer owns the prompt (the shared download modal, or
      // the in-channel question on a remote Home Agent turn), so the agent
      // store does not touch the dialog store directly — the same seam chat
      // and media use (AGENTS.md: "Report through the sink, not directly").
      try {
        await requestDownload(missing)
        return { status: 'ready' }
      } catch (error) {
        return ragEmbeddingPrepFailure(error)
      }
    }

    const turn = createAgentTurnRuntime({
      errors,
      storeTools: {
        [OFFER_GAME_AGENT_TOOL]: (input) => offerGameAgent(input),
        [RAG_PREPARE_EMBEDDING_MODEL]: (input) => prepareRagEmbeddingModel(input),
      },
      buildTurnConfig: () => {
        const sessionId = ensureSessionId(activeSessionId)
        return buildTurnConfig({
          sessionId,
          workspaceDir: workspaceDir.value,
          // The remembered agent preset, not the active one: a media call
          // switches the active preset to an image-gen one mid-turn.
          presetName: agentPresetName.value,
          instructions: withResponseLanguage(
            activeAgentPreset.value?.systemPrompt?.trim() ?? '',
            sessionResponseLocale(sessionId),
          ),
          capabilities: [...capabilities.value],
          unsandboxed: unsandboxed.value,
          planningThinkingOnly: planningThinkingOnly.value,
          textInference,
          cloudMode,
        })
      },
    })
    const { chat, processing, toolProgress, toolImages, abortRunningTools } = turn

    watch(activeSessionId, () => {
      toolImages.value = {}
    })

    // Records persist on turn lifecycle (step 11): a generate/stop snapshot,
    // capability rewrite, or explicit delete — not a map watch. The Chat
    // still owns the UIMessage list; main writes the file.
    const persistSessionMutation = makeForwardPersist({
      code: 'agent-sessions/persist-failed',
      technicalMessage: 'saving an agent session file failed',
    })

    function persistSessionRecord(record: AgentSessionRecord): void {
      if (!sessionsHydrated.value) return
      persistSessionMutation(() => window.electronAPI.agentMode.saveSession(cloneForIpc(record)))
    }

    function rewriteSession(id: string, record: AgentSessionRecord): void {
      sessions.value = { ...sessions.value, [id]: record }
      persistSessionRecord(record)
    }

    watch(activeSessionId, (id) => {
      if (!sessionsHydrated.value) return
      persistSessionMutation(() => window.electronAPI.agentMode.saveActiveSessionId(id || null))
    })

    // A tool can be waiting on a confirmation card when the turn ends, errors or
    // is aborted. Settling it as declined keeps a question the user can no longer
    // answer from lingering, and unblocks the tool if it is still listening
    // (mirrors the chat store).
    watch(processing, (isProcessing, wasProcessing) => {
      if (!wasProcessing || isProcessing) return
      confirmations.cancelForConversation(activeSessionId.value, false)
      const handoff = pendingHandoff.value
      if (!handoff) return
      pendingHandoff.value = null
      void startGameAgentHandoff(handoff)
    })

    const messages = computed(() => chat.messages)

    const sessionUsage = computed(() => latestTurnMetadata(messages.value, 'usage'))
    const sessionTokens = computed(
      () => (sessionUsage.value?.inputTokens ?? 0) + (sessionUsage.value?.outputTokens ?? 0),
    )
    const contextUsage = computed(() => latestTurnMetadata(messages.value, 'contextUsage'))
    const lastStepUsage = computed(() => latestTurnMetadata(messages.value, 'lastStep'))

    /**
     * `presetName` is the preset that held the session, which is the current one
     * except while leaving it: a turn that was still running has no record yet,
     * and would otherwise be filed under the preset it is moving to.
     */
    function snapshotActiveSession(presetName: string = agentPresetName.value): void {
      const id = activeSessionId.value
      if (!id || !workspaceDir.value) return
      const record = snapshotSession({
        id,
        workspaceDir: workspaceDir.value,
        messages: chat.messages as UIMessage[],
        existing: sessions.value[id],
        capabilities: capabilities.value,
        presetName,
        responseLocale: sessions.value[id]?.responseLocale ?? pendingResponseLocales[id],
      })
      if (!record) return
      rewriteSession(id, record)
    }

    function restoreActiveSession(): void {
      chat.messages = (sessions.value[activeSessionId.value]?.messages ?? []) as UIMessage[]
    }

    async function newSession(): Promise<void> {
      await stop()
      activeSessionId.value = mintSessionId()
      sessionCapabilities.value = null
      chat.messages = []
    }

    async function switchSession(id: string): Promise<void> {
      if (id === activeSessionId.value) return
      const target = sessions.value[id]
      if (!target) return
      // Tears down the live Pi session and preview server for the conversation
      // we are leaving; the next prompt rebuilds them for `id`.
      await stop()
      movingSession = true
      try {
        if (target.presetName && target.presetName !== agentPresetName.value) {
          await presetSwitching.switchPreset(target.presetName)
        }
        activeSessionId.value = id
        sessionCapabilities.value = null
        if (target.workspaceDir) {
          workspaceDir.value = target.workspaceDir
          lastWorkspaceByKind.value = {
            ...lastWorkspaceByKind.value,
            [agentWorkspaceKind.value]: target.workspaceDir,
          }
        }
        restoreActiveSession()
        await refreshCurrentGame()
      } finally {
        movingSession = false
      }
    }

    /**
     * Quick Coder's `offer_game_agent` tool (see the `game-studio-quick`
     * capability): put the switch to the user as a card in the transcript, and
     * on a yes note what the agent taking over needs to know. Nothing happens
     * here beyond that note — the switch runs once this turn has ended.
     */
    async function offerGameAgent(input: Record<string, unknown>): Promise<unknown> {
      const label = oemBranding.presetLabel(GAME_AGENT_PRESET)
      const request = typeof input.reason === 'string' ? input.reason.trim() : ''
      const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
      const accepted = await confirmations.request({
        conversationKey: activeSessionId.value,
        title: `Continue in ${label}?`,
        summaryMarkdown:
          (request ? `${request}\n\n` : '') +
          `That is more than this mode can do. **${label}** picks the game up from here — same ` +
          'folder, a fresh conversation — and can read and edit the code, play-test it in a ' +
          'browser and generate art for it. It starts on this straight away, and works step by ' +
          'step, so it takes longer.',
        origin: 'desktop',
      })
      if (!accepted) {
        return {
          accepted: false,
          message:
            'The user declined and stays here. If the change is small, write the whole ' +
            'index.html again with it applied; otherwise tell them plainly what this mode ' +
            'cannot do.',
        }
      }
      pendingHandoff.value = { summary, request }
      return {
        accepted: true,
        message:
          `${label} takes the game from here and starts on this itself as soon as you stop. ` +
          'Say so in one line — no code, no further tool calls.',
      }
    }

    /**
     * Start the session Game Agent takes the game over in: same folder, empty
     * transcript, one hand-over message which it is then answering. A fresh
     * session rather than this one re-tagged, because a Quick Coder transcript
     * is written under instructions that are wrong for the agent inheriting it —
     * the game folder is the artifact, and both sessions stay in the panel.
     *
     * Runs after the offering turn ended, never from inside the tool: a
     * `generate()` there would nest a second turn inside the open one, and
     * moving the preset mid-turn would file the one-shot run itself under Game
     * Agent (`snapshotSession` only freezes a record that already exists).
     */
    async function startGameAgentHandoff(handoff: {
      summary: string
      request: string
    }): Promise<void> {
      // No agent preset is memory-gated, and this switch answers a card the
      // user already said yes to — a modal here would only stall it.
      // `movingSession` keeps the preset watcher from blanking the very folder
      // being handed over before `newSession()` below reaches it.
      movingSession = true
      let switched: { success: boolean; error?: string }
      try {
        switched = await presetSwitching.switchPreset(GAME_AGENT_PRESET, {
          skipMemoryAlert: true,
        })
      } finally {
        movingSession = false
      }
      if (!switched.success) {
        errors.report(new Error(switched.error ?? 'Could not switch preset.'), {
          category: 'unknown',
          code: 'agent/handoff-failed',
          userMessage: `Could not hand the game to ${oemBranding.presetLabel(GAME_AGENT_PRESET)}.`,
          surface: 'toast',
        })
        return
      }
      await newSession()
      await generate(
        gameAgentHandoffPrompt({
          ...handoff,
          gameName: currentGame.value?.name,
          gameDescription: currentGame.value?.description,
        }),
      )
    }

    async function deleteSession(id: string): Promise<void> {
      // Stop first so Pi teardown in the same IPC is not racing a live turn,
      // then wait for the kernel: dropping the row before that would make a
      // failed delete vanish from the panel and come back on the next boot.
      if (id === activeSessionId.value) await stop()
      const result = await window.electronAPI.agentMode.deleteSession(id)
      if (!result.success) {
        errors.report(new Error(result.error ?? 'Failed to delete session.'), {
          category: 'unknown',
          code: 'agent/delete-session-failed',
          userMessage: result.error ?? 'Failed to delete the agent session.',
          surface: 'silent',
        })
        return
      }
      const next = { ...sessions.value }
      delete next[id]
      sessions.value = next
      if (id === activeSessionId.value) {
        activeSessionId.value = mintSessionId()
        sessionCapabilities.value = null
        chat.messages = []
      }
    }

    async function adoptWorkspace(dir: string): Promise<void> {
      await stop()
      workspaceDir.value = dir
      const latest = Object.values(sessions.value)
        .filter((s) => s.workspaceDir === dir)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      activeSessionId.value = latest?.id ?? ''
      sessionCapabilities.value = null
      restoreActiveSession()
      await refreshCurrentGame()
    }

    async function pickWorkspaceFolder(): Promise<void> {
      const result = await window.electronAPI.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select the agent workspace folder',
      })
      if (result.canceled || result.filePaths.length === 0) return
      const next = result.filePaths[0]
      if (workspaceDir.value === next) return
      await adoptWorkspace(next)
    }

    async function refreshCurrentGame(): Promise<void> {
      const dir = workspaceDir.value
      currentGame.value = dir ? await window.electronAPI.games.read(dir) : null
    }

    const { attachments, attachFiles, removeAttachment, clearAttachments, importAttachments } =
      createWorkspaceAttachments(errors)

    async function newGame(): Promise<void> {
      await stop()
      workspaceDir.value = ''
      activeSessionId.value = ''
      sessionCapabilities.value = null
      currentGame.value = null
      chat.messages = []
    }

    async function startNew(): Promise<void> {
      if (agentWorkspaceKind.value === 'games') await newGame()
      else await newSession()
    }

    async function reconcileWorkspaceKind(): Promise<void> {
      const reconciled = await reconcileGamesWorkspace({
        kind: agentWorkspaceKind.value,
        workspaceDir: workspaceDir.value,
        lastGamesDir: lastWorkspaceByKind.value.games ?? '',
      })
      if (!reconciled) return
      lastWorkspaceByKind.value = {
        ...lastWorkspaceByKind.value,
        pick: reconciled.pickDir ?? lastWorkspaceByKind.value.pick,
      }
      await adoptWorkspace(reconciled.workspaceDir)
    }

    watch(
      agentWorkspaceKind,
      async (_kind, previous) => {
        if (movingSession) return
        if (previous === undefined) await reconcileWorkspaceKind()
      },
      { immediate: true },
    )

    /**
     * Switching agent preset by hand always starts a blank session for the new
     * preset. A session's capabilities are frozen on its record while the
     * instructions are read live off the active preset, so continuing one under
     * another preset runs that preset's prompt against the wrong toolbox. The
     * `offer_game_agent` hand-over is the one way a game crosses over, and it
     * sets `movingSession` to keep its folder.
     */
    watch(agentPresetName, async (name, previous) => {
      if (!previous || name === previous || movingSession) return
      snapshotActiveSession(previous)
      lastWorkspaceByKind.value = {
        ...lastWorkspaceByKind.value,
        [workspaceKindOf(previous)]: workspaceDir.value,
      }
      if (agentWorkspaceKind.value === 'games') {
        await newGame()
        return
      }
      await stop()
      workspaceDir.value = lastWorkspaceByKind.value.pick ?? ''
      await newSession()
      await refreshCurrentGame()
    })

    async function generate(prompt: string): Promise<void> {
      // Game Agent never asks for a folder: the first turn of a game mints one.
      if (agentWorkspaceKind.value === 'games' && !(await isGameFolder(workspaceDir.value))) {
        const game = await window.electronAPI.games.create(prompt, {
          scaffold: !capabilities.value.includes(GAME_STUDIO_QUICK_ID),
          backend: textInference.backend,
          startingModel: textInference.activeModel,
          initialPrompt: prompt,
        })
        workspaceDir.value = game.dir
        lastWorkspaceByKind.value = { ...lastWorkspaceByKind.value, games: game.dir }
        currentGame.value = game
      }
      if (!workspaceDir.value) {
        errors.report(new Error('Select a workspace folder before starting the agent.'), {
          category: 'validation',
          code: 'agent/no-workspace',
          userMessage: 'Select a workspace folder before starting the agent.',
          surface: 'toast',
        })
        return
      }
      const attached = await importAttachments(workspaceDir.value)
      ensureSessionId(activeSessionId)
      toolProgress.value = {}
      processing.value = true
      try {
        await chat.sendMessage({ text: `${prompt}${attached}` })
      } finally {
        processing.value = false
        snapshotActiveSession()
        await refreshCurrentGame()
      }
    }

    async function stop(): Promise<void> {
      await window.electronAPI.agentMode.cancel()
      abortRunningTools()
      await chat.stop()
      processing.value = false
      snapshotActiveSession()
    }

    return {
      workspaceDir,
      agentPresetName,
      activeAgentPreset,
      agentWorkspaceKind,
      currentGame,
      lastWorkspaceByKind,
      mcpServerIds,
      defaultCapabilities,
      capabilities,
      isCapabilityEnabled,
      setCapabilityEnabled,
      resetPresetSettings,
      migrateMcpServerIds,
      migrateSessionPresets,
      init,
      sessionsHydrated,
      migratePlanningThinkingOnly,
      planningThinkingOnly,
      unsandboxedWorkspaces,
      unsandboxed,
      setUnsandboxed,
      attachments,
      attachFiles,
      removeAttachment,
      clearAttachments,
      processing,
      messages,
      toolProgress,
      toolImages,
      sessionUsage,
      sessionTokens,
      contextUsage,
      lastStepUsage,
      chat,
      sessions,
      presetSessions,
      activeSessionId,
      pickWorkspaceFolder,
      refreshCurrentGame,
      newGame,
      startNew,
      reconcileWorkspaceKind,
      generate,
      stop,
      newSession,
      switchSession,
      deleteSession,
      restoreActiveSession,
    }
  },
  {
    persist: {
      // Session records, the active id and the last-used workspace pointers
      // live in the kernel's files (step 8, §6.1); everything here is user
      // preference.
      pick: [
        'mcpServerIds',
        'defaultCapabilities',
        'unsandboxedWorkspaces',
        'planningThinkingOnly',
      ],
      afterHydrate: (ctx) => {
        ctx.store.migrateMcpServerIds()
        ctx.store.migratePlanningThinkingOnly()
      },
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.dispose(() => unregisterAgentModeIpc())
  import.meta.hot.accept(acceptHMRUpdate(useAgentMode, import.meta.hot))
}
