<script setup lang="ts">
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useI18N } from '@/assets/js/store/i18n'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { mapServiceNameToDisplayName } from '@/lib/utils'
import { toTypedSchema } from '@vee-validate/zod'
import { z } from 'zod'

const props = defineProps<{
  backend: BackendServiceName
}>()
const backendServices = useBackendServices()
const i18nState = useI18N().state
const backendStatus = computed(
  () =>
    backendServices.info.filter(
      (backendService) => backendService.serviceName === props.backend,
    )[0]['status'],
)

// Initialize current version values for all supported backends
const currentVersion = ref('')
const currentReleaseTag = ref('')

// Load current settings for supported backends
const loadCurrentSettings = async () => {
  const backend = props.backend
  if (
    backend === 'comfyui-backend' ||
    backend === 'llamacpp-backend' ||
    backend === 'openvino-backend'
  ) {
    const settings = await backendServices.getServiceSettings(backend)
    currentVersion.value = settings?.version ?? ''
  } else if (backend === 'ollama-backend') {
    const settings = await backendServices.getServiceSettings(backend)
    currentVersion.value = settings?.version ?? ''
    currentReleaseTag.value = settings?.releaseTag ?? ''
  }
}

// Load settings on component mount
onMounted(() => {
  loadCurrentSettings()
})

const menuOpen = ref(false)
const settingsDialogOpen = ref(false)

// Backend-specific validation schemas
const getFormSchema = (backend: BackendServiceName) => {
  switch (backend) {
    case 'comfyui-backend':
      // ComfyUI: git hash (7-40 chars) or version tag (e.g. v1.0.0)
      return toTypedSchema(
        z
          .object({
            version: z
              .string()
              .regex(/^[0-9a-f]{7,40}$/, 'Must be a valid git hash (7-40 characters)')
              .or(
                z.string().regex(/^v\d+\.\d+\.\d+$/, 'Must be a valid version tag (e.g. v1.0.0)'),
              ),
          })
          .passthrough(),
      )

    case 'llamacpp-backend':
      // LlamaCPP: build numbers like b6048
      return toTypedSchema(
        z
          .object({
            version: z.string().regex(/^b\d+$/, 'Must be a valid build number (e.g. b6048)'),
          })
          .passthrough(),
      )

    case 'openvino-backend':
      // OpenVINO: package versions like 2025.2.0 or 2025.2.0.1
      return toTypedSchema(
        z
          .object({
            version: z
              .string()
              .regex(/^\d+\.\d+\.\d+(\.\d+)?$/, 'Must be a valid version number (e.g. 2025.2.0)'),
          })
          .passthrough(),
      )

    case 'ollama-backend':
      // Ollama: two fields - release tag and version
      return toTypedSchema(
        z
          .object({
            releaseTag: z
              .string()
              .regex(/^v\d+\.\d+\.\d+-\w+$/, 'Must be a valid release tag (e.g. v2.3.0-nightly)'),
            version: z
              .string()
              .regex(/^\d+\.\d+\.\d+[a-z]\d{8}$/, 'Must be a valid version (e.g. 2.3.0b20250630)'),
          })
          .passthrough(),
      )

    default:
      return toTypedSchema(z.object({}).passthrough())
  }
}

const formSchema = computed(() => getFormSchema(props.backend))

const showStart = computed(() => {
  return backendStatus.value === 'stopped' || backendStatus.value === 'notYetStarted'
})
const showStop = computed(() => {
  return backendStatus.value === 'running'
})
const showReinstall = computed(() => {
  return backendStatus.value !== 'installing' && backendStatus.value !== 'notInstalled'
})
const showSettings = computed(() => {
  return ['comfyui-backend', 'llamacpp-backend', 'openvino-backend', 'ollama-backend'].includes(
    props.backend,
  )
})

// Get backend-specific placeholders and descriptions
const getVersionPlaceholder = (backend: BackendServiceName) => {
  switch (backend) {
    case 'comfyui-backend':
      return 'v1.0.0 or abc1234'
    case 'llamacpp-backend':
      return 'b6048'
    case 'openvino-backend':
      return '2025.2.0'
    case 'ollama-backend':
      return 'v2.3.0-nightly'
    default:
      return ''
  }
}

const getVersionDescription = (backend: BackendServiceName) => {
  switch (backend) {
    case 'comfyui-backend':
      return (
        i18nState.BACKEND_VERSION_DESCRIPTION_COMFYUI || 'Enter a git commit hash or version tag'
      )
    case 'llamacpp-backend':
      return i18nState.BACKEND_VERSION_DESCRIPTION_LLAMACPP || 'Enter a build number (e.g. b6048)'
    case 'openvino-backend':
      return (
        i18nState.BACKEND_VERSION_DESCRIPTION_OPENVINO || 'Enter a version number (e.g. 2025.2.0)'
      )
    case 'ollama-backend':
      return i18nState.BACKEND_VERSION_DESCRIPTION_OLLAMA || 'Enter release tag and version'
    default:
      return i18nState.BACKEND_VERSION_DESCRIPTION || 'Enter version information'
  }
}

// Get initial form values based on backend type
const getInitialFormValues = () => {
    return {
      releaseTag: currentReleaseTag.value,
      version: currentVersion.value,
    }
}
const showMenuButton = computed(
  () => showStart.value || showStop.value || showReinstall.value || showSettings.value,
)
</script>

<template>
  <DropdownMenu v-model:open="menuOpen" v-if="showMenuButton">
    <DropdownMenuTrigger><span class="svg-icon i-setup w-6 h-6"></span></DropdownMenuTrigger>
    <DropdownMenuContent>
      <DropdownMenuLabel>{{ mapServiceNameToDisplayName(backend) }}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem v-if="showStop" @click="() => backendServices.stopService(backend)">{{
        i18nState.BACKEND_STOP
      }}</DropdownMenuItem>
      <DropdownMenuItem v-if="showStart" @click="() => backendServices.startService(backend)">{{
        i18nState.BACKEND_START
      }}</DropdownMenuItem>

      <AlertDialog
        v-if="showReinstall"
        @update:open="
          (open: boolean) => {
            if (!open) menuOpen = false
          }
        "
      >
        <AlertDialogTrigger asChild
          ><DropdownMenuItem @select="(e: Event) => e.preventDefault()">{{
            i18nState.BACKEND_REINSTALL
          }}</DropdownMenuItem></AlertDialogTrigger
        >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{{ i18nState.BACKEND_CONFIRM }}</AlertDialogTitle>
            <AlertDialogDescription>
              {{
                i18nState.BACKEND_REINSTALL_DESCRIPTION.replace(
                  '{backend}',
                  mapServiceNameToDisplayName(backend),
                )
              }}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{{ i18nState.COM_CANCEL }}</AlertDialogCancel>
            <AlertDialogAction
              @click="
                async () => {
                  await backendServices.uninstallService(backend)
                  await backendServices.setUpService(backend)
                  await backendServices.startService(backend)
                }
              "
              >{{ i18nState.COM_CONTINUE }}</AlertDialogAction
            >
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Form
        v-if="showSettings"
        v-slot="{ handleSubmit }"
        as=""
        :initial-values="getInitialFormValues()"
        keep-values
        :validation-schema="formSchema"
      >
        <Dialog
          @update:open="
            (open: boolean) => {
              if (!open) menuOpen = false
            }
          "
          v-model:open="settingsDialogOpen"
        >
          <DialogTrigger asChild
            ><DropdownMenuItem @select="(e: Event) => e.preventDefault()">{{
              i18nState.COM_SETTINGS
            }}</DropdownMenuItem></DialogTrigger
          >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{{
                i18nState.BACKEND_SETTINGS_TITLE.replace(
                  '{backend}',
                  mapServiceNameToDisplayName(backend),
                )
              }}</DialogTitle>
              <DialogDescription>
                {{
                  i18nState.BACKEND_SETTINGS_DESCRIPTION.replace(
                    '{backend}',
                    mapServiceNameToDisplayName(backend),
                  )
                }}
              </DialogDescription>
            </DialogHeader>

            <form
              id="dialogForm"
              @submit="
                handleSubmit($event, (values) => {
                  console.log('Form submitted with values:', values)

                  // Update current values based on backend type
                  if (backend === 'ollama-backend') {
                    currentReleaseTag = values.releaseTag
                    currentVersion = values.version
                  } else {
                    currentVersion = values.version
                  }

                  backendServices.updateServiceSettings({ serviceName: props.backend, ...values })
                  settingsDialogOpen = false
                  menuOpen = false
                })
              "
            >
              <!-- Ollama backend has two fields -->
              <template v-if="backend === 'ollama-backend'">
                <FormField v-slot="{ componentField }" name="releaseTag">
                  <FormItem>
                    <FormLabel>{{ i18nState.BACKEND_RELEASE_TAG || 'Release Tag' }}</FormLabel>
                    <FormControl>
                      <Input
                        type="text"
                        :placeholder="getVersionPlaceholder(backend)"
                        v-bind="componentField"
                      />
                    </FormControl>
                    <FormDescription>
                      {{
                        i18nState.BACKEND_RELEASE_TAG_DESCRIPTION ||
                        'Enter the release tag (e.g. v2.3.0-nightly)'
                      }}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                </FormField>

                <FormField v-slot="{ componentField }" name="version" class="mt-4">
                  <FormItem>
                    <FormLabel>{{ i18nState.BACKEND_VERSION }}</FormLabel>
                    <FormControl>
                      <Input type="text" placeholder="2.3.0b20250630" v-bind="componentField" />
                    </FormControl>
                    <FormDescription>
                      {{
                        i18nState.BACKEND_VERSION_DESCRIPTION_OLLAMA_VERSION ||
                        'Enter the version number (e.g. 2.3.0b20250630)'
                      }}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                </FormField>
              </template>

              <!-- Other backends have single version field -->
              <template v-else>
                <FormField v-slot="{ componentField }" name="version">
                  <FormItem>
                    <FormLabel>{{ i18nState.BACKEND_VERSION }}</FormLabel>
                    <FormControl>
                      <Input
                        type="text"
                        :placeholder="getVersionPlaceholder(backend)"
                        v-bind="componentField"
                      />
                    </FormControl>
                    <FormDescription>
                      {{ getVersionDescription(backend) }}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                </FormField>
              </template>
            </form>

            <DialogFooter>
              <Button type="submit" form="dialogForm">
                {{ i18nState.BACKEND_SAVE_CHANGES }}
              </Button></DialogFooter
            >
          </DialogContent>
        </Dialog>
      </Form>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
