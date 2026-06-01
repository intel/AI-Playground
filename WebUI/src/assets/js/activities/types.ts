// Unified activity/status model. Mirrors the error model (errors/types.ts): a
// single typed Activity that every long-running phase of the app produces, so
// the activity sink (store/activities.ts) is the single source of truth for
// "what is the app busy with right now" instead of each call site inventing its
// own ad-hoc loading flag.

export type ActivityCategory =
  | 'backend' // backend/model start & load
  | 'inference' // LLM thinking / TTFT / inter-step agentic pauses
  | 'rag' // document embedding + similarity search
  | 'tools' // tool/MCP resolution and tool execution
  | 'generation' // ComfyUI image/video/3D generation phases
  | 'setup' // boot / preset switching
  | 'unknown'

export type ActivityState = 'active' | 'done' | 'failed' | 'cancelled'

// Where an activity belongs, so the UI can show the right activities in the
// right place (e.g. the in-progress chat turn vs. the image-gen overlay).
export type ActivityScope =
  | { kind: 'global' }
  | { kind: 'chat'; conversationKey: string }
  | { kind: 'imageGen' }

export type Activity = {
  // Brand so isActivity() can distinguish a normalized Activity from a random object.
  readonly __isActivity: true
  // Stable id; updates (label/progress/state) target the same activity.
  id: string
  category: ActivityCategory
  // Short, user-facing status line, e.g. "Searching documents…".
  label: string
  // Optional secondary text (e.g. model name, current node).
  detail?: string
  // Determinate progress 0..1; undefined => indeterminate (spinner only).
  progress?: number
  scope: ActivityScope
  state: ActivityState
  // Nest child activities (e.g. image-gen phases under the tool that started them)
  // so the UI can prefer the innermost/most-specific label.
  parentId?: string
  startedAt: number
  updatedAt: number
}
