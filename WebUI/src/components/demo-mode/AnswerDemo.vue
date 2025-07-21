<template>
  <transition name="fade">
    <div class="demo-mode-answer-overlay" v-if="demoMode.answer.show">
        <!-- Enhance Center Popup -->
        <div class="center-popup">
          <p>
             {{ languages.DEMO_ANSWER_HEADING }}
          </p>
        </div>

        <div class="tooltip-wrapper">
            <div class="tooltip-box">
              <div class="tooltip-row">
                <div class="tooltip-circle">1</div>
                <div>
                   <p>{{ languages.DEMO_ANSWER_GENERATE_TEXT }}</p>
                  <p class="content-tooltip">
                
                {{ languages.DEMO_YOU_COULD_TYPE }}
               
                <span class="italic-blue">"{{ languages.DEMO_ANSWER_GENERATE_HELP_TEXT }}"</span>
              
              </p>
              </div>
            </div>
              <div class="got-it-btn">
               <button class="tooltip-button" @click="() => ((demoMode.answer.show = false))">
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

