<template>
  <transition name="fade">
    <div class="demo-mode-enhance-overlay" v-if="demoMode.enhance.showUpscale">
      <!-- Enhance Center Popup -->
      <div class="center-popup">
        <p>
          {{ languages.DEMO_ENHANCE_HEADING }}
        </p>
      </div>

      <div class="tooltip-wrapper">
        <div class="tooltip-box">
          <div class="tooltip-row">
            <div class="tooltip-circle">1</div>
            <p class="tooltip-text">
              {{ languages.DEMO_ENHANCE_UPSCALE_TEXT }}
            </p>
          </div>

          <div class="tooltip-row">
            <div class="tooltip-circle">2</div>
            <p class="tooltip-text">
              {{ languages.DEMO_ENHANCE_VARIATION_TEXT }}
            </p>
          </div>

          <div class="got-it-btn">
            <button class="tooltip-button" @click="() => (demoMode.enhance.showUpscale = false)">
              {{ languages.DEMO_OK_GOT_IT }} &#8594;
            </button>
          </div>
        </div>
      </div>
    </div>
  </transition>
  <transition name="fade">
    <div class="demo-mode-Image-overlay" v-if="demoMode.enhance.showPrompt">
      <div class="tooltip-wrapper">
        <div class="tooltip-box">
          <div class="tooltip-row">
            <div class="tooltip-circle">1</div>
            <p class="tooltip-text">
              {{ languages.DEMO_ENHANCE_IMAGE_TEXT }}
            </p>
          </div>

          <div class="tooltip-row">
            <div class="tooltip-circle">2</div>
            <p class="tooltip-text">
              {{ languages.DEMO_ENHANCE_IMAGE_TEXT_2 }}
            </p>
          </div>

          <div class="got-it-btn">
            <button class="tooltip-button" @click="() => (demoMode.enhance.showPrompt = false)">
              {{ languages.DEMO_OK_GOT_IT }} &#8594;
            </button>
          </div>
        </div>
      </div>
    </div>
  </transition>
  <transition name="fade">
    <div class="demo-mode-inpaint-overlay" v-if="demoMode.enhance.showInpaint">
      <div id="inpaintOverlayContent" class="tooltip-wrapper">
        <div class="tooltip-box">
          <div class="tooltip-row">
            <div class="tooltip-circle">1</div>
            <p class="tooltip-text">
              {{ languages.DEMO_ENHANCE_INPAINT_ONE }}
            </p>
          </div>

          <div class="tooltip-row">
            <div class="tooltip-circle">2</div>
            <p class="tooltip-text">
              {{ languages.DEMO_ENHANCE_INPAINT_TWO }}
            </p>
          </div>

          <div class="tooltip-row">
            <div class="tooltip-circle">3</div>
            <p class="tooltip-text">
              {{ languages.DEMO_ENHANCE_INPAINT_THREE }}
            </p>
          </div>

          <div class="got-it-btn">
            <button class="tooltip-button" @click="() => (demoMode.enhance.showInpaint = false)">
              {{ languages.DEMO_OK_GOT_IT }} &#8594;
            </button>
          </div>
        </div>
      </div>
    </div>
  </transition>
  <transition name="fade">
    <div
      class="demo-mode-outpaint-overlay"
      v-if="demoMode.enhance.showOutpaint"
    >
      <div class="tooltip-wrapper">
        <div class="tooltip-box">
          <div class="tooltip-row">
            <div class="tooltip-circle">1</div>
            <p class="tooltip-text">
              {{ languages.DEMO_ENHANCE_OUTPAINT_TEXT }}
            </p>
          </div>

          <div class="tooltip-row">
            <div class="tooltip-circle">2</div>
            <p class="tooltip-text">
              {{ languages.DEMO_ENHANCE_OUTPAINT_TEXT_2 }}
            </p>
          </div>

          <div class="tooltip-row">
            <div class="tooltip-circle">3</div>
            <p class="tooltip-text">
              {{ languages.DEMO_ENHANCE_OUTPAINT_TEXT_3 }}
            </p>
          </div>
          <div class="got-it-btn">
            <button class="tooltip-button" @click="() => (demoMode.enhance.showOutpaint = false)">
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
