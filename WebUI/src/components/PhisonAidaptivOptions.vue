<script setup lang="ts">
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useI18N } from '@/assets/js/store/i18n'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
} from '@/components/ui/alert-dialog'
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
import { z } from 'zod'
import { Cog6ToothIcon } from '@heroicons/vue/24/solid'
import * as toast from '@/assets/js/toast'

const backendServices = useBackendServices()
const i18nState = useI18N().state

const menuOpen = ref(false)
const settingsDialogOpen = ref(false)
const reinstallDialogOpen = ref(false)

const llamaInfo = computed(() =>
  backendServices.info.find((s) => s.serviceName === 'llamacpp-backend'),
)

const phisonDisplayName = computed(
  () => i18nState.PHISON_AIDAPTIV_MENU_LABEL || 'Llama.cpp - Phison aiDAPTIV+ SSD',
)

const backendStatus = computed(() => llamaInfo.value?.status ?? 'notInstalled')

const showReinstall = computed(
  () => backendStatus.value !== 'installing' && backendStatus.value !== 'notInstalled',
)

const llamaCppStorageTargets = computed(() => llamaInfo.value?.storageTargets ?? [])

const llamaCppSsdOffloadConfigPath = computed(
  () => llamaInfo.value?.llamaCppSsdOffloadConfigPath ?? '',
)

function resolvedConfigRelativePath(): string {
  const fromService = llamaCppSsdOffloadConfigPath.value
  if (fromService) {
    return fromService
  }
  const isWindows = typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent)
  return isWindows ? '..\\aidaptiv_config.json' : '../aidaptiv_config.json'
}

function defaultSsdParameters(): string {
  return `--config-file ${resolvedConfigRelativePath()}`
}

const formSchema = z.object({
  llamaCppOffloadDrive: z.string().optional(),
  llamaCppParameters: z.string().optional(),
})

function getInitialFormValues() {
  return {
    llamaCppOffloadDrive: backendServices.llamaCppOffloadDrive ?? '',
    llamaCppParameters: backendServices.llamaCppParameters ?? defaultSsdParameters(),
  }
}

async function pushPhisonLlamaSettingsToMain() {
  await backendServices.updateServiceSettings({
    serviceName: 'llamacpp-backend',
    llamaCppBuildVariant: 'ssd-offload',
    llamaCppOffloadDrive: backendServices.llamaCppOffloadDrive,
    llamaCppParameters: backendServices.effectiveLlamaCppParameters,
  })
}

async function applySettings(values: Record<string, unknown>) {
  const offload = (values.llamaCppOffloadDrive as string) || null
  const params = (values.llamaCppParameters as string) || ''
  backendServices.llamaCppBuildVariant = 'ssd-offload'
  backendServices.llamaCppOffloadDrive = offload
  const def = defaultSsdParameters()
  backendServices.llamaCppParameters = !params || params === def ? null : params
  try {
    await pushPhisonLlamaSettingsToMain()
  } catch (error) {
    console.error('Llama.cpp (Phison) settings update failed:', error)
    toast.error(
      `Failed to update Phison aiDAPTIV+ settings: ${error instanceof Error ? error.message : String(error)}`,
    )
    // Leave dialogs open so the user can retry without losing context.
    return
  }
  settingsDialogOpen.value = false
  menuOpen.value = false
}

async function handlePhisonReinstall() {
  let allOk = false
  try {
    backendServices.llamaCppBuildVariant = 'ssd-offload'
    try {
      await pushPhisonLlamaSettingsToMain()
    } catch (e) {
      console.error('Llama.cpp (Phison) settings push failed:', e)
      toast.error(
        `Failed to push Phison aiDAPTIV+ settings: ${e instanceof Error ? e.message : String(e)}`,
      )
      return
    }
    try {
      await backendServices.uninstallService('llamacpp-backend')
    } catch (e) {
      console.error('Llama.cpp (Phison) uninstall failed:', e)
      toast.error(`Failed to uninstall Llama.cpp: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    const setupResult = await backendServices.setUpService('llamacpp-backend')
    if (!setupResult.success) {
      console.error('Llama.cpp (Phison) reinstallation failed:', setupResult)
      toast.error('Llama.cpp (Phison) reinstallation failed. See logs for details.')
      return
    }
    try {
      const startStatus = await backendServices.startService('llamacpp-backend')
      if (startStatus !== 'running') {
        console.error(`Llama.cpp (Phison) failed to start after reinstall (status=${startStatus}).`)
        toast.error(`Llama.cpp (Phison) failed to start after reinstall (status=${startStatus}).`)
        return
      }
    } catch (startError) {
      console.error('Llama.cpp (Phison) startup failed after reinstall:', startError)
      toast.error(
        `Llama.cpp (Phison) startup failed after reinstall: ${
          startError instanceof Error ? startError.message : String(startError)
        }`,
      )
      return
    }
    allOk = true
  } catch (error) {
    console.error('Llama.cpp (Phison) reinstall failed:', error)
    toast.error(
      `Llama.cpp (Phison) reinstall failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    // Only collapse the menu when the whole reinstall flow succeeded —
    // otherwise the user might lose the entry point to retry.
    if (allOk) menuOpen.value = false
  }
}
</script>

<template>
  <DropdownMenu v-model:open="menuOpen">
    <DropdownMenuTrigger>
      <span class="inline-flex" title="Llama.cpp-Phison aiDAPTIV+ settings">
        <Cog6ToothIcon class="size-6" />
      </span>
    </DropdownMenuTrigger>
    <DropdownMenuContent>
      <DropdownMenuLabel>{{ phisonDisplayName }}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem v-if="showReinstall" @select="reinstallDialogOpen = true">{{
        i18nState.BACKEND_REINSTALL
      }}</DropdownMenuItem>
      <DropdownMenuItem @select="settingsDialogOpen = true">{{
        i18nState.COM_SETTINGS || 'Settings'
      }}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>

  <AlertDialog v-if="showReinstall" v-model:open="reinstallDialogOpen">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ i18nState.BACKEND_CONFIRM }}</AlertDialogTitle>
        <AlertDialogDescription>
          {{ i18nState.BACKEND_REINSTALL_DESCRIPTION.replace('{backend}', phisonDisplayName) }}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{{ i18nState.COM_CANCEL }}</AlertDialogCancel>
        <AlertDialogAction @click="handlePhisonReinstall">{{
          i18nState.COM_CONTINUE
        }}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>

  <Dialog v-model:open="settingsDialogOpen">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{
          i18nState.PHISON_AIDAPTIV_SETTINGS_TITLE || 'Llama.cpp-Phison aiDAPTIV+ SSD offload'
        }}</DialogTitle>
        <DialogDescription>
          {{
            i18nState.PHISON_AIDAPTIV_SETTINGS_DESCRIPTION ||
            'SSD offload path and startup parameters for the Phison aiDAPTIV+ Llama.cpp build.'
          }}
        </DialogDescription>
      </DialogHeader>

      <Form
        v-if="settingsDialogOpen"
        v-slot="{ handleSubmit }"
        as=""
        :initial-values="getInitialFormValues()"
        keep-values
        :validation-schema="formSchema"
      >
        <form
          id="phisonAidaptivForm"
          @submit="
            handleSubmit($event, (values) => {
              void applySettings(values as Record<string, unknown>)
            })
          "
        >
          <FormField v-slot="{ componentField }" name="llamaCppOffloadDrive">
            <FormItem>
              <FormLabel>{{
                i18nState.BACKEND_LLAMACPP_OFFLOAD_DRIVE_LABEL || 'SSD Offload Drive'
              }}</FormLabel>
              <FormControl>
                <select
                  class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  v-bind="componentField"
                >
                  <option value="">Select a drive</option>
                  <option
                    v-for="target in llamaCppStorageTargets"
                    :key="target.id"
                    :value="target.path"
                  >
                    {{ target.name }}
                  </option>
                </select>
              </FormControl>
              <FormDescription>
                {{
                  llamaCppStorageTargets.length > 0
                    ? i18nState.BACKEND_LLAMACPP_OFFLOAD_DRIVE_DESCRIPTION ||
                      'Assign the drive used for SSD KV offload.'
                    : i18nState.BACKEND_LLAMACPP_OFFLOAD_DRIVE_EMPTY ||
                      'No fixed drives detected yet. Install Llama.cpp or reopen settings.'
                }}
              </FormDescription>
              <FormMessage />
            </FormItem>
          </FormField>

          <FormField v-slot="{ componentField }" name="llamaCppParameters">
            <FormItem class="mt-4">
              <FormLabel>{{
                i18nState.BACKEND_LLAMACPP_PARAMETERS_LABEL || 'Startup Parameters'
              }}</FormLabel>
              <FormControl>
                <Input type="text" :placeholder="defaultSsdParameters()" v-bind="componentField" />
              </FormControl>
              <FormDescription>
                {{
                  i18nState.BACKEND_LLAMACPP_SSD_PARAMETERS_DESCRIPTION ||
                  'Defaults to --config-file for aidaptiv_config.json; edit if needed.'
                }}
              </FormDescription>
              <FormMessage />
            </FormItem>
          </FormField>
        </form>
      </Form>

      <DialogFooter class="gap-2">
        <Button type="submit" form="phisonAidaptivForm" class="bg-primary hover:bg-primary/80">
          {{ i18nState.BACKEND_SAVE_CHANGES || 'Save changes' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
