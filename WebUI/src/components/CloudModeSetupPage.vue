<template>
  <div class="px-12 py-5 max-w-5xl w-5xl">
    <h1 class="text-center py-1 px-4 rounded-sm text-3xl font-bold">Cloud Mode Setup</h1>
    <p class="text-center text-xs text-muted-foreground pt-2">
      Connect a remote OpenAI-compatible provider. Models are fetched from the provider and become
      selectable in chat under the <span class="font-semibold">Cloud Mode</span> backend.
    </p>

    <div class="flex gap-6 pt-6">
      <!-- Left: provider list -->
      <div class="w-56 shrink-0">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground pb-3">
          Providers
        </h2>
        <div class="flex flex-col gap-2">
          <SetupSidebarTile
            v-for="provider in cloudMode.providers"
            :key="provider.id"
            :selected="selectedId === provider.id"
            @select="selectProvider(provider.id)"
          >
            <span class="text-sm font-medium">{{ provider.name }}</span>
            <span class="text-xs text-muted-foreground truncate">
              {{ provider.baseUrl || 'Not configured' }}
            </span>
            <span v-if="provider.models.length" class="text-xs font-medium text-green-500">
              {{ provider.models.length }} models
            </span>
          </SetupSidebarTile>
        </div>
        <Button variant="secondary" class="mt-3 w-full" @click="addProvider">
          + Add provider
        </Button>
      </div>

      <!-- Right: selected provider settings -->
      <div class="flex-1 min-w-0">
        <div class="flex items-center justify-between pb-3">
          <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Provider Settings
          </h2>
          <button
            type="button"
            class="text-sm font-medium text-destructive hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
            :disabled="cloudMode.providers.length <= 1"
            @click="removeSelectedProvider"
          >
            Remove provider
          </button>
        </div>

        <div class="flex flex-col gap-4">
          <div class="flex flex-col gap-1.5">
            <Label>Prefill from a known provider</Label>
            <DropDownNew
              title="Known providers"
              :items="presetItems"
              :value="selectedPresetKey"
              @change="applyPreset"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label>Name</Label>
            <Input v-model="form.name" placeholder="Custom" />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label>Base URL</Label>
            <Input v-model="form.baseUrl" placeholder="https://your-provider.example.com" />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label>Authentication</Label>
            <DropDownNew
              title="How the API key is sent"
              :items="authStyleItems"
              :value="form.authStyle"
              @change="setAuthStyle"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label>API Key</Label>
            <Input
              v-model="form.apiKey"
              type="password"
              :placeholder="hasStoredKey ? '•••••••• (leave blank to keep)' : 'sk-…'"
            />
            <span v-if="hasStoredKey" class="text-xs text-green-500">✓ API key saved</span>
          </div>

          <div class="flex items-center gap-3">
            <Button :disabled="fetching || !form.baseUrl.trim()" @click="fetchModels">
              <span v-if="fetching" class="svg-icon i-loading w-4 h-4 mr-1"></span>
              {{ fetching ? 'Fetching…' : 'Fetch models' }}
            </Button>
            <span v-if="fetchError" class="text-xs text-destructive">{{ fetchError }}</span>
            <span v-else-if="fetchSuccess" class="text-xs text-green-500">
              ✓ Fetched {{ form.models.length }} models
            </span>
          </div>

          <!-- Fetched models preview -->
          <div
            v-if="form.models.length"
            class="rounded-md border border-green-500/30 bg-green-500/5 p-3"
          >
            <p class="text-xs font-semibold text-green-500 pb-2">
              Available models ({{ form.models.length }})
            </p>
            <ul class="flex flex-col gap-1 max-h-48 overflow-y-auto">
              <li v-for="m in form.models" :key="m" class="text-sm text-foreground">{{ m }}</li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer actions -->
    <SetupWizardFooter :primary-disabled="saving" @back="emit('back')" @primary="saveAndDone">
      <template #actions>
        <span v-if="justSaved" class="text-xs text-green-500">✓ Saved</span>
        <Button variant="secondary" @click="saveOnly" :disabled="saving">Save</Button>
      </template>
    </SetupWizardFooter>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch, onMounted } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import SetupSidebarTile from '@/components/SetupSidebarTile.vue'
import SetupWizardFooter from '@/components/SetupWizardFooter.vue'
import DropDownNew from '@/components/DropDownNew.vue'
import {
  useCloudMode,
  CLOUD_PROVIDER_PRESETS,
  type CloudAuthStyle,
} from '@/assets/js/store/cloudMode'
import { useErrors } from '@/assets/js/store/errors'
import * as toast from '@/assets/js/toast'

const emit = defineEmits<{ (e: 'back'): void; (e: 'done'): void }>()

const cloudMode = useCloudMode()
const errors = useErrors()

const selectedId = ref(cloudMode.selectedProviderId)
const fetching = ref(false)
const fetchError = ref('')
const fetchSuccess = ref(false)
const saving = ref(false)
const justSaved = ref(false)
const hasStoredKey = ref(false)

const form = reactive({
  name: '',
  baseUrl: '',
  apiKey: '',
  authStyle: 'bearer' as CloudAuthStyle,
  models: [] as string[],
})

// One-shot "prefill from a known provider" selector. It isn't persisted — it
// just stamps name/baseUrl/authStyle onto the form — so it resets per provider.
const selectedPresetKey = ref('')
const presetItems = computed(() =>
  CLOUD_PROVIDER_PRESETS.map((p) => ({ label: p.name, value: p.key, active: false })),
)

const AUTH_STYLE_LABELS: Record<CloudAuthStyle, string> = {
  bearer: 'Bearer — Authorization header',
  'x-api-key': 'x-api-key — Anthropic',
  'api-key': 'api-key — Azure OpenAI',
}
const authStyleItems = computed(() =>
  (Object.keys(AUTH_STYLE_LABELS) as CloudAuthStyle[]).map((value) => ({
    label: AUTH_STYLE_LABELS[value],
    value,
    active: value === form.authStyle,
  })),
)

function applyPreset(key: string) {
  const preset = CLOUD_PROVIDER_PRESETS.find((p) => p.key === key)
  if (!preset) return
  selectedPresetKey.value = key
  form.name = preset.name
  form.baseUrl = preset.baseUrl
  form.authStyle = preset.authStyle
  applyFormToStore()
}

function setAuthStyle(style: string) {
  form.authStyle = style as CloudAuthStyle
}

function loadForm(id: string) {
  const provider = cloudMode.providers.find((p) => p.id === id)
  if (!provider) return
  form.name = provider.name
  form.baseUrl = provider.baseUrl
  form.authStyle = provider.authStyle ?? 'bearer'
  form.apiKey = ''
  form.models = [...provider.models]
  hasStoredKey.value = !!cloudMode.activeProviderApiKey
  // The preset selector is a per-provider prefill helper — reset it on switch.
  selectedPresetKey.value = ''
  // Success hints belong to the provider we just left — clear them on switch.
  fetchSuccess.value = false
  justSaved.value = false
  fetchError.value = ''
}

async function selectProvider(id: string) {
  // Persist any edits to the current provider before switching away.
  applyFormToStore()
  selectedId.value = id
  cloudMode.selectProvider(id)
  // Pull the key into the session cache so the placeholder reflects reality.
  await cloudMode.loadApiKey(id).catch(() => null)
  loadForm(id)
}

/** Create a fresh provider, select it, and start editing a blank form. */
function addProvider() {
  // Don't lose edits to the provider we're leaving.
  applyFormToStore()
  const id = crypto.randomUUID()
  cloudMode.addProvider({ id, name: 'New provider', baseUrl: '' })
  selectedId.value = id
  cloudMode.selectProvider(id)
  loadForm(id)
}

/** Remove the selected provider (and its stored key), then select another. */
async function removeSelectedProvider() {
  if (cloudMode.providers.length <= 1) return
  await cloudMode.removeProvider(selectedId.value)
  const nextId = cloudMode.selectedProviderId
  selectedId.value = nextId
  await cloudMode.loadApiKey(nextId).catch(() => null)
  loadForm(nextId)
}

/** Write the in-form name/baseURL back onto the selected provider. */
function applyFormToStore() {
  // Don't push `models` here: the store owns the fetched list (written by
  // fetchModels) and drops it when the base URL changes — round-tripping the
  // form's copy would resurrect a stale list under the new URL. Mirror the
  // store's list back into the form afterwards so the UI reflects any drop.
  cloudMode.updateProvider(selectedId.value, {
    name: form.name.trim() || 'Custom',
    baseUrl: form.baseUrl.trim(),
    authStyle: form.authStyle,
  })
  const provider = cloudMode.providers.find((p) => p.id === selectedId.value)
  if (provider) form.models = [...provider.models]
}

async function fetchModels() {
  fetchError.value = ''
  fetchSuccess.value = false
  fetching.value = true
  try {
    applyFormToStore()
    // Persist a freshly-entered key first so fetch can authenticate.
    if (form.apiKey.trim()) {
      await cloudMode.saveApiKey(selectedId.value, form.apiKey.trim())
      hasStoredKey.value = true
      form.apiKey = ''
    }
    const models = await cloudMode.fetchModels(selectedId.value)
    form.models = models
    fetchSuccess.value = models.length > 0
    if (!models.length) toast.warning?.('Provider returned no models.')
  } catch (e) {
    // Route through the central error sink: it logs the technical detail + cause
    // to the console once and returns the normalized AppError. Rendered inline
    // below (surface: 'inline') rather than toasted.
    const appError = errors.report(e, {
      category: 'inference',
      code: 'cloud/fetch-models-failed',
      surface: 'inline',
    })
    fetchError.value = appError.userMessage
  } finally {
    fetching.value = false
  }
}

async function persist() {
  saving.value = true
  try {
    applyFormToStore()
    if (form.apiKey.trim()) {
      await cloudMode.saveApiKey(selectedId.value, form.apiKey.trim())
      hasStoredKey.value = true
      form.apiKey = ''
    }
  } finally {
    saving.value = false
  }
}

async function saveOnly() {
  await persist()
  justSaved.value = true
  toast.success('Provider saved.')
}

async function saveAndDone() {
  await persist()
  emit('done')
}

watch(
  () => cloudMode.selectedProviderId,
  (id) => {
    if (id !== selectedId.value) {
      selectedId.value = id
      loadForm(id)
    }
  },
)

onMounted(async () => {
  // Ensure the stored key (if any) is in the session cache so the placeholder
  // reflects reality after a restart.
  await cloudMode.loadApiKey(selectedId.value).catch(() => null)
  loadForm(selectedId.value)
})
</script>
