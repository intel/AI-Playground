import fs from 'node:fs'
import path from 'node:path'

// ── Thinking for planning only ───────────────────────────────────────────────
//
// A local 27B reasons at the same speed it writes code, so a thinking block
// before every one of a few dozen tool calls is most of a Game Agent run's wall
// clock — and it is re-derived work: the model plans the same game again on each
// step because a trace is not a place a plan can live.
//
// So the plan gets written down instead. The game-studio skill has the agent
// `write design.md` first — mechanic, entities, a checklist of the edits to make
// — and once that file exists thinking is switched off for the rest of the
// session. From then on the checklist carries the plan between steps, and each
// step is a file edit the model can make without re-deciding what the game is.
//
// A session short enough to finish in one turn has nowhere to put that boundary:
// it thinks and writes the deliverable in a single breath, so switching thinking
// off afterwards saves nothing. Those sessions declare a handoff prompt instead
// (`AgentCapability.planHandoff`) and the turn is split in two: the model is
// asked for the plan alone, and the harness then approves it on the user's
// behalf and asks for the build, which runs with thinking already off.
//
// Only ever off, never on: the switch is the user's (Chat settings), and this is
// allowed to end the thinking phase early, not to start one the user declined.

/** The plan the agent writes, relative to the workspace. */
export const PLAN_FILE = 'design.md'

/**
 * What ends a session's planning phase:
 *
 * - `plan-file` — the agent writes `design.md`, then works down the checklist in
 *   it one edit at a time (Game Agent).
 * - `first-write` — the first file the agent writes *is* the deliverable, so
 *   planning is over the moment it lands (Quick Coder).
 */
export type PlanningEnd = 'plan-file' | 'first-write'

/** Tools whose call means the model is writing a file at `path`. */
const WRITING_TOOLS = new Set(['write', 'edit', 'multi_edit', 'apply_patch'])

/**
 * The template's thinking switch inside a live sampling bag, or undefined when
 * the model has none (only the renderer knows, and it sends the key only for
 * models whose template reads it).
 */
function thinkingSwitch(
  samplingParams: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const kwargs = samplingParams?.chat_template_kwargs
  if (!kwargs || typeof kwargs !== 'object') return undefined
  const bag = kwargs as Record<string, unknown>
  return 'enable_thinking' in bag ? bag : undefined
}

/** Whether thinking is currently on for turns using this sampling bag. */
export function thinkingIsOn(samplingParams: Record<string, unknown> | undefined): boolean {
  return thinkingSwitch(samplingParams)?.enable_thinking === true
}

/**
 * Switch thinking off in place. Pi reads `model.samplingParams` when it builds
 * each request, so mutating the bag the live model holds takes effect on the
 * next step of a turn already in flight.
 */
export function endThinking(samplingParams: Record<string, unknown> | undefined): boolean {
  const bag = thinkingSwitch(samplingParams)
  if (!bag || bag.enable_thinking === false) return false
  bag.enable_thinking = false
  return true
}

export function planExists(workspaceDir: string): boolean {
  return fs.existsSync(path.join(workspaceDir, PLAN_FILE))
}

/**
 * Whether a tool call puts something on disk. A plan turn that did this built
 * rather than planned, and needs no handoff — it already did the work.
 */
export function isWritingTool(toolName: string): boolean {
  return WRITING_TOOLS.has(toolName)
}

/** Whether a tool call is the one that ends the planning phase. */
export function endsPlanning(end: PlanningEnd, toolName: string, args: unknown): boolean {
  if (!WRITING_TOOLS.has(toolName)) return false
  if (end === 'first-write') return true
  const target = (args as { path?: unknown } | null | undefined)?.path
  if (typeof target !== 'string') return false
  return path.basename(target.replace(/\\/g, '/')).toLowerCase() === PLAN_FILE
}
