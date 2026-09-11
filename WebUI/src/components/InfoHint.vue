<script setup lang="ts">
// The ⓘ affordance used across the setup wizard, in two flavours that look and
// read identically: without `href` it just explains something, with `href` it also
// opens the component's project/licence page.
//
// Both go through the app's Tooltip. The link flavour used to carry a plain
// `title` attribute instead, which renders the OS's own tooltip — a different
// font, colour and delay from every other hint in the app.
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'

defineProps<{
  text: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  /** Turns the glyph into an external link opened in the browser. */
  href?: string
}>()
</script>

<template>
  <TooltipProvider :delay-duration="200">
    <Tooltip>
      <TooltipTrigger as-child>
        <component
          :is="href ? 'a' : 'span'"
          :href="href"
          :target="href ? '_blank' : undefined"
          :rel="href ? 'noreferrer' : undefined"
          :role="href ? undefined : 'note'"
          :tabindex="href ? undefined : 0"
          :aria-label="text"
          class="shrink-0 inline-flex items-center justify-center leading-none align-middle text-muted-foreground hover:text-foreground transition-colors"
          :class="href ? 'cursor-pointer' : 'cursor-help'"
        >
          <svg
            class="w-3.5 h-3.5 block"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
          </svg>
        </component>
      </TooltipTrigger>
      <TooltipContent :side="side ?? 'right'" class="text-xs max-w-[260px]">
        {{ text }}
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
</template>
