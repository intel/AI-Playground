<template>
  <div class="space-y-2">
    <h2 class="text-lg font-semibold mb-2">Chat History</h2>

    <div
      v-for="(item, i) in chatHistory"
      :key="i"
      class="flex items-center justify-between bg-muted/30 rounded-lg px-3 py-2 hover:bg-muted/50 transition"
    >
      <span class="truncate text-sm text-foreground">{{ item.title }}</span>

      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon" class="h-6 w-6">
            <span class="svg-icon i-dots-vertical w-4 h-4"></span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-28">
          <DropdownMenuItem @click="editItem(item)">
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem @click="deleteItem(item)">
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"

interface ChatItem {
  title: string
}

const chatHistory: ChatItem[] = [
  { title: "What is Generative AI?" },
  { title: "Write a story about AI" },
  { title: "Explain quantum computing" }
]

const editItem = (item: ChatItem) => {
  console.log("Edit", item)
}

const deleteItem = (item: ChatItem) => {
  console.log("Delete", item)
}
</script>

<style scoped>
</style>
