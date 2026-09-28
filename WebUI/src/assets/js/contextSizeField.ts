import { ref, watch, type Ref } from 'vue'

/** Bounds the settings box used to declare. Enforced on commit, not per keystroke. */
const CONTEXT_SIZE_MIN = 512
const CONTEXT_SIZE_MAX = 131072

/**
 * Draft for the context-size box.
 *
 * A live `v-model` on `type="number"` plus `min` set to the KM floor (16384)
 * makes the field refuse edits: the browser rejects any intermediate value
 * below that minimum, and the clamp watcher writes the floor back on the same
 * tick. Remote desktops hit this constantly, because the spinner is the only
 * control that jumps by a whole step. The draft commits on blur/enter, so a
 * number can be typed in full before the floor and the model ceiling apply.
 */
export function useContextSizeField(contextSize: Ref<number>, onCommit?: () => void) {
  const draft = ref(String(contextSize.value))
  const editing = ref(false)

  watch(contextSize, (value) => {
    if (!editing.value) draft.value = String(value)
  })

  function onFocus() {
    editing.value = true
    draft.value = String(contextSize.value)
  }

  function onInput(event: Event) {
    const target = event.target as HTMLInputElement
    const digits = target.value.replace(/\D/g, '')
    editing.value = true
    draft.value = digits
    if (target.value !== digits) target.value = digits
  }

  function commit() {
    editing.value = false
    const raw = draft.value.trim()
    const parsed = Number(raw)
    if (raw === '' || !Number.isFinite(parsed)) {
      draft.value = String(contextSize.value)
      return
    }
    const bounded = Math.min(CONTEXT_SIZE_MAX, Math.max(CONTEXT_SIZE_MIN, Math.round(parsed)))
    contextSize.value = bounded
    // The store may clamp further (KM floor, model ceiling) inside this assignment.
    draft.value = String(contextSize.value)
    onCommit?.()
  }

  return { draft, onFocus, onInput, commit }
}
