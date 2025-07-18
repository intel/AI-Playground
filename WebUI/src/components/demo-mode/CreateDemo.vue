<template>
  <!--To Introduce Demo Mode Overlay-->
  <transition name="fade">
    <div class="demo-mode-create-overlay" v-if="demoMode.enabled && demoMode.create.show">
      <!-- Create Popup Centered -->
      <div class="popup-box center-box">
        <div class="create-text">
          <p>
            {{ languages.DEMO_CREATE_CENTER_CONTENT }}
          </p>
        </div>
      </div>

      <!-- Tooltip Popup at Bottom Left -->
      <div class="prompt-popup-box bottom-left-box">
        <div class="step">1</div>
        <div class="content">
          <p>{{ languages.DEMO_CREATE_POPUP_CONTENT_1 }}</p>
          <p class="example">
            {{ languages.DEMO_YOU_COULD_TYPE }}
            "{{ languages.DEMO_CREATE_POPUP_CONTENT_3 }}".
          </p>
          <div class="got-it-btn">
            <button class="action" @click="() => (demoMode.create.show = false)">
              {{ languages.DEMO_OK_GOT_IT }} &#8594;
            </button>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { useDemoMode } from '@/assets/js/store/demoMode'

const demoMode = useDemoMode()
</script>
