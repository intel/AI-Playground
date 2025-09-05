<template>
  <div
    id="chatHistoryPanel"
    :class="{ 'w-12': !isHistoryVisible, 'w-56': isHistoryVisible }"
    class="flex shrink-0 flex-col overflow-y-auto bg-gradient-to-r from-[#05010fb4]/20 to-[#05010fb4]/70 transition-all"
  >
    <div class="flex justify-end">
      <button @click="isHistoryVisible = !isHistoryVisible" class="m-2 flex text-white">
        <img
          v-if="!isHistoryVisible"
          :class="textInference.iconSizeClass"
          src="@/assets/svg/expand.svg"
          class="w-8 h-8"
        />
        <img
          v-else
          :class="textInference.iconSizeClass"
          src="@/assets/svg/collapse.svg"
          class="w-8 h-8"
        />
      </button>
    </div>
    <div v-if="isHistoryVisible" class="flex flex-col-reverse">
      <div
        v-for="(conversation, conversationKey) in conversations.conversationList"
        :key="'if' + conversationKey"
        @click="select(conversationKey)"
        :title="conversation?.[0]?.title ?? languages.ANSWER_NEW_CONVERSATION"
        class="group relative cursor-pointer text-gray-300"
      >
        <div class="flex justify-between items-center w-full h-10 px-3">
          <div
            v-if="conversations.activeKey === conversationKey"
            class="absolute inset-1 bg-[#00c4fa]/50 rounded-lg"
          ></div>
          <div class="relative flex justify-between items-center w-full">
            <span class="w-45 whitespace-nowrap overflow-x-auto text-ellipsis text-sm ml-1">
              {{ conversation?.[0]?.title ?? languages.ANSWER_NEW_CONVERSATION }}
            </span>
            <div
              v-if="!conversations.isNewConversation(conversationKey)"
              @click.stop="() => {}"
              @pointerdown.stop
            >
              <DropdownMenu
                :open="menuOpenKey === conversationKey"
                @update:open="open => onMenuOpenChange(conversationKey, open)"
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    :class="[
                      'transition-opacity duration-200 ml-2 text-gray-300 hover:text-white hover:bg-transparent dark:hover:bg-transparent focus:bg-transparent focus-visible:bg-transparent active:bg-transparent outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0',
                      menuOpenKey === conversationKey ? 'opacity-70' : 'opacity-0 group-hover:opacity-70',
                    ]"
                    @click.stop="() => {}"
                    @pointerdown.stop="() => {}"
                    @mousedown.stop
                  >
                    <img src="@/assets/svg/ellipsis.svg" class="w-5 h-5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  class="min-w-36"
                  :onCloseAutoFocus="ev => { ev.preventDefault?.() }"
                >
                  <DropdownMenuItem @select="(e: Event) => { e.preventDefault(); conversations.deleteConversation(conversationKey) }">
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="flex flex-col-reverse">
      <div
        v-for="(conversation, conversationKey) in conversations.conversationList"
        :key="'else' + conversationKey"
        :inVisibleKey="conversationKey"
        @click="select(conversationKey)"
        :title="conversation?.[0]?.title ?? languages.ANSWER_NEW_CONVERSATION"
        class="flex justify-between items-center h-12 py-2 cursor-pointer hover:bg-[#00c4fa]/50"
        :class="conversations.activeKey === conversationKey ? 'bg-[#00c4fa]/50' : ''"
      >
        <span
          v-if="conversationKey === currentlyGeneratingKey && processing"
          class="svg-icon i-loading w-8 h-8 animate-spin text-white flex items-center justify-center m-auto"
        ></span>
        <svg
          v-else-if="conversations.isNewConversation(conversationKey)"
          class="m-auto h-8 w-8 text-gray-300"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M12 9v6m3-3H9m12 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
          />
        </svg>
        <svg
          v-else
          class="m-auto h-8 w-8 text-gray-300"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1"
            d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z"
          />
        </svg>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useConversations } from '@/assets/js/store/conversations'
import { useTextInference } from '@/assets/js/store/textInference'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'

const conversations = useConversations()
const textInference = useTextInference()
const isHistoryVisible = ref(false)

const menuOpenKey = ref<string | null>(null)
function onMenuOpenChange(conversationKey: string, open: boolean) {
  menuOpenKey.value = open
    ? conversationKey
    : menuOpenKey.value === conversationKey
      ? null
      : menuOpenKey.value
}

const props = defineProps<{
  onConversationClick: () => void
  currentlyGeneratingKey: string | null
  processing: boolean
}>()

function select(conversationKey: string) {
  console.log('Switching to conversationKey:', conversationKey)
  conversations.activeKey = conversationKey
  props.onConversationClick()
}
</script>
