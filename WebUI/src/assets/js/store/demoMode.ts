import { acceptHMRUpdate, defineStore } from 'pinia'

const answerInitial = {
  show: false,
  finished: false,
}
const createInitial = {
  show: false,
  finished: false,
}
type EnhanceFeature = 'upscale' | 'prompt' | 'inpaint' | 'outpaint'
const enhanceInitial = {
  showUpscale: false,
  showPrompt: false,
  showInpaint: false,
  showOutpaint: false,
  finishedUpscale: false,
  finishedPrompt: false,
  finishedInpaint: false,
  finishedOutpaint: false,
  feature: 'upscale' as EnhanceFeature,
  imageAvailable: false,
  show: false,
  finished: false,
}
export const useDemoMode = defineStore('demoMode', () => {
  const enabled = ref(false)

  let resetTimer: null | ReturnType<typeof setTimeout> = null
  let trackUserInteractionInterval: null | ReturnType<typeof setInterval> = null

  const resetInSeconds = ref<null | number>(null)
  window.electronAPI.getDemoModeSettings().then((res) => {
    enabled.value = res.isDemoModeEnabled
    resetInSeconds.value = res.demoModeResetInSeconds
    if (res.isDemoModeEnabled && res.demoModeResetInSeconds) trackUserInteraction()
  })

  const answer = ref(answerInitial)
  const create = ref(createInitial)
  const enhance = ref(enhanceInitial)

  const pages = {
    answer,
    create,
    enhance,
  }

  const trackUserInteraction = () => {
    if (trackUserInteractionInterval) {
      clearInterval(trackUserInteractionInterval)
      trackUserInteractionInterval = null
    }
    trackUserInteractionInterval = setInterval(() => {
      if (!navigator.userActivation.hasBeenActive) return
      if (navigator.userActivation.isActive) {
        if (resetTimer) {
          clearTimeout(resetTimer)
          resetTimer = null
        }
      } else {
        if (!resetTimer && resetInSeconds.value) {
          console.log(
            `demo mode reset timer started, resetting after ${resetInSeconds.value} seconds`,
          )
          resetTimer = setTimeout(() => {
            location.reload()
          }, resetInSeconds.value * 1000)
        }
      }
    }, 1000)
  }

  const escapeDemo = (e: Event) => {
    e.stopPropagation()
    create.value.show = false
    enhance.value.show = false
    answer.value.show = false
  }

  function calculateMaskPenDim() {
    const maskPenRef = document.getElementById('mask-pen')?.getBoundingClientRect()

    if (maskPenRef) {
      setTimeout(() => {
        const inpaintOverlayContent = document.getElementById('inpaintOverlayContent')
        if (inpaintOverlayContent && inpaintOverlayContent.style) {
          inpaintOverlayContent.style.top = `${maskPenRef.bottom - 145}px`
          inpaintOverlayContent.style.left = `${maskPenRef.left - 445}px`
        }
      }, 50)
    }
  }

  function triggerHelp(page: AipgPage, force = false) {
    if (!enabled.value) return
    console.log('demo mode triggered for ', {
      page,
      force,
    })
    if (page === 'learn-more') return
    if (!force && pages[page].value.finished) return
    if (page !== 'enhance') {
      pages[page].value.show = true
      pages[page].value.finished = true
    } else {
      switch (enhance.value.feature) {
        case 'upscale':
          if (enhance.value.finishedUpscale && !force) break
          enhance.value.showUpscale = true
          enhance.value.finishedUpscale = true
          pages[page].value.show = true
          break
        case 'prompt':
          if (enhance.value.finishedPrompt && !force) break
          enhance.value.showPrompt = true
          enhance.value.finishedPrompt = true
          pages[page].value.show = true
          break
        case 'inpaint':
          if (!enhance.value.imageAvailable) break
          if (enhance.value.finishedInpaint && !force) return
          setTimeout(() => {
            const maskPenRef: HTMLElement = document.getElementById('mask-pen') as HTMLElement
            const isMaskPenVisible = window.getComputedStyle(maskPenRef).display !== 'none'
            if (isMaskPenVisible) {
              enhance.value.showInpaint = true
              enhance.value.finishedInpaint = true
              pages[page].value.show = true
              calculateMaskPenDim()
            }
          }, 100)
          break
        case 'outpaint':
          if (enhance.value.finishedOutpaint && !force) break
          enhance.value.showOutpaint = true
          enhance.value.finishedOutpaint = true
          pages[page].value.show = true
          break
      }
    }
  }

  watch(
    () => enhance.value.show,
    (showEnhance) => {
      if (!showEnhance) {
        enhance.value.showUpscale = false
        enhance.value.showPrompt = false
        enhance.value.showInpaint = false
        enhance.value.showOutpaint = false
      }
    },
  )

  watch(
    () => enhance.value.feature,
    () => {
      if (!enabled.value) return
      if (!enhance.value.show) triggerHelp('enhance')
    },
  )

  watch(
    [() => answer.value.show, () => create.value.show, () => enhance.value.show],
    ([a, c, e]) => {
      if (c || e || a) {
        setTimeout(() => document.addEventListener('click', escapeDemo), 50)
      } else {
        document.removeEventListener('click', escapeDemo)
      }
    },
  )

  return {
    enabled,
    answer,
    create,
    enhance,
    triggerHelp,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useDemoMode, import.meta.hot))
}
