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
const currentVersion = ref('')
if (props.backend === 'comfyui-backend') {
  backendServices.getServiceSettings(props.backend).then((settings) => {
    currentVersion.value = settings?.version ?? ''
  })
}
const menuOpen = ref(false)
const settingsDialogOpen = ref(false)
const formSchema = toTypedSchema(
  z
    .object({
      // git hash (long or short) or version tag (e.g. v1.0.0)
      version: z
        .string()
        .regex(/^[0-9a-f]{7,40}$/)
        .or(z.string().regex(/^v\d+\.\d+\.\d+$/)),
    })
    .passthrough(),
)

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
  return props.backend === 'comfyui-backend'
})
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
        :initial-values="{ version: currentVersion }"
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
                  currentVersion = values.version
                  backendServices.updateServiceSettings({ serviceName: props.backend, ...values })
                  settingsDialogOpen = false
                  menuOpen = false
                })
              "
            >
              <FormField v-slot="{ componentField }" name="version">
                <FormItem>
                  <FormLabel>{{ i18nState.BACKEND_VERSION }}</FormLabel>
                  <FormControl>
                    <Input type="text" placeholder="v1.0.0" v-bind="componentField" />
                  </FormControl>
                  <FormDescription>
                    {{ i18nState.BACKEND_VERSION_DESCRIPTION }}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              </FormField>
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
