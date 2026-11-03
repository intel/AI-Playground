// The prompt bar is busy only for what it would send to: work elsewhere (an agent
// turn while in Chat, a Chat turn while in Image Gen) never locks it.

export type PromptBusyTargets = {
  /** The Open Agent Session has a turn queued or running. */
  agentSession: boolean
  /** The open conversation has a turn in flight (prep, queued, streaming). */
  conversation: boolean
  /** The image/edit/video panel has a run in flight. */
  panelRun: boolean
  /** The open Session has a Text-to-Speech / Speech-to-Text turn running. */
  audioTurn: boolean
}

const CHAT_LIKE_MODES: ModeType[] = ['chat', 'agent', 'audio']

export function isChatLikeMode(mode: ModeType): boolean {
  return CHAT_LIKE_MODES.includes(mode)
}

export function promptBusy(mode: ModeType, targets: PromptBusyTargets): boolean {
  if (mode === 'agent') return targets.agentSession
  if (mode === 'audio') return targets.audioTurn
  if (mode === 'chat') return targets.conversation
  return targets.panelRun
}

/**
 * What the prompt field does when its target's busy state flips. Chat-like modes clear
 * the field once a send is accepted (the message is in the transcript by then) and never
 * on the way back, so navigating between busy and idle targets leaves typed text alone.
 * Image modes keep the prompt so it can be tweaked and reused.
 */
export function promptOnBusyChange(
  mode: ModeType,
  change: { busy: boolean; wasBusy: boolean; submitted: boolean },
): { clearPrompt: boolean; resetSubmitted: boolean } {
  if (isChatLikeMode(mode)) {
    return { clearPrompt: change.busy && change.submitted, resetSubmitted: true }
  }
  return { clearPrompt: false, resetSubmitted: change.wasBusy && !change.busy }
}
