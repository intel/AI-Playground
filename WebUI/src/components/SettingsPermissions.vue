<template>
  <DemoModeBlocker>
    <div class="flex flex-col gap-3 pt-4">
      <SettingsHeading>{{ languages.SETTINGS_PERMISSIONS }}</SettingsHeading>
      <div class="pl-2 pt-2 flex flex-col gap-4">
        <div class="flex justify-between pr-4 items-center gap-4">
          <div class="flex items-center gap-2">
            <Label for="remote-download-pregrant" class="whitespace-nowrap">{{
              languages.SETTINGS_PERMISSIONS_REMOTE_DOWNLOADS
            }}</Label>
            <TooltipProvider :delay-duration="200">
              <Tooltip>
                <TooltipTrigger as-child>
                  <span class="svg-icon i-info w-4 h-4 opacity-50 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="bottom" class="max-w-[320px]">
                  {{ languages.SETTINGS_PERMISSIONS_REMOTE_DOWNLOADS_INFO }}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <Checkbox
            id="remote-download-pregrant"
            :model-value="remoteDownloadsGranted"
            @update:model-value="(v) => setRemoteDownloads(v === true)"
          />
        </div>

        <div class="border-t border-white/10 pt-3 flex flex-col gap-2">
          <div class="flex items-center gap-2">
            <SettingsHeading sub>{{ languages.SETTINGS_PERMISSIONS_REMEMBERED }}</SettingsHeading>
          </div>
          <div v-if="rememberedGrants.length" class="flex flex-col gap-2">
            <div
              v-for="grant in rememberedGrants"
              :key="grant.key"
              class="flex justify-between pr-4 items-center gap-4"
            >
              <span class="text-sm">{{ labelFor(grant) }}</span>
              <Button variant="outline" size="sm" @click="grants.revoke(grant.key)">
                {{ languages.SETTINGS_PERMISSIONS_REVOKE }}
              </Button>
            </div>
          </div>
          <p v-else class="text-xs opacity-60">{{ languages.SETTINGS_PERMISSIONS_EMPTY }}</p>
        </div>
      </div>
    </div>
  </DemoModeBlocker>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  REMOTE_DOWNLOAD_GRANT,
  usePermissionGrants,
  VRAM_WARNING_GRANT_PREFIX,
  type PermissionGrant,
} from '@/assets/js/store/permissionGrants'
import { useI18N } from '@/assets/js/store/i18n'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import SettingsHeading from '@/components/SettingsHeading.vue'
import DemoModeBlocker from '@/components/DemoModeBlocker.vue'

const grants = usePermissionGrants()
const i18nState = useI18N().state
const languages = i18nState

const remoteDownloadsGranted = computed(() => grants.has(REMOTE_DOWNLOAD_GRANT))

const rememberedGrants = computed<PermissionGrant[]>(() =>
  grants.list.filter((grant) => grant.origin === 'remember'),
)

function setRemoteDownloads(enabled: boolean): void {
  if (enabled) grants.grant(REMOTE_DOWNLOAD_GRANT, 'pre-grant')
  else grants.revoke(REMOTE_DOWNLOAD_GRANT)
}

function labelFor(grant: PermissionGrant): string {
  if (grant.key.startsWith(VRAM_WARNING_GRANT_PREFIX)) {
    return (languages.SETTINGS_PERMISSIONS_VRAM_LABEL ?? '').replace(
      '{preset}',
      grant.key.slice(VRAM_WARNING_GRANT_PREFIX.length),
    )
  }
  return grant.key
}
</script>
