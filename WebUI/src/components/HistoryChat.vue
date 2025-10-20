<template>
  <div class="space-y-2 overflow-y-auto max-h-[100vh]">
    <div
      v-for="key in reversedConversationKeys"
      :key="key"
      class="flex items-center justify-between bg-muted/30 rounded-lg px-3 py-2 hover:bg-muted/50 transition cursor-pointer"
      @click="selectConversation(key)"
    >
      <span
        class="truncate text-sm text-foreground"
        :class="{ 'font-semibold text-primary': conversations.activeKey === key }"
      >
        {{ conversations.conversationList[key]?.[0]?.title ?? languages.ANSWER_NEW_CONVERSATION }}
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon" class="h-6 w-6">
            <span class="svg-icon i-dots-vertical w-4 h-4"></span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-28">
          <DropdownMenuItem @click.stop="editItem(key)">Edit</DropdownMenuItem>
          <DropdownMenuItem @click.stop="deleteItem(key)">Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { useConversations } from '@/assets/js/store/conversations'

const conversations = useConversations()

const reversedConversationKeys = computed(() => {
  const list = conversations.conversationList ?? {}
  const keys = Object.keys(list).reverse()
  keys.shift()
  return keys
})

const selectConversation = (key: string) => {
  conversations.activeKey = key
  console.log('Selected conversation:', key)
}

const editItem = (key: string) => {
  console.log('Edit conversation:', key)
}

const deleteItem = (key: string) => {
  console.log('Delete conversation:', key)
}
</script>

<style scoped>
</style>
