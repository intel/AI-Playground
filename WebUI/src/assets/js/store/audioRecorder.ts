import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface AudioRecorderConfig {
  echoCancellation: boolean
  noiseSuppression: boolean
  sampleRate: number
  maxDuration: number
  silenceThreshold: number
  silenceDuration: number
  enableSilenceDetection: boolean
}

export const useAudioRecorder = defineStore('audioRecorder', () => {

  const isRecording = ref(false)
  const isPaused = ref(false)
  const recordingTime = ref(0)
  const audioBlob = ref<Blob | null>(null)
  const audioUrl = ref<string | null>(null)
  const error = ref<string | null>(null)
  const isTranscribing = ref(false)
  const audioLevel = ref(0)

  const audioDevices = ref<MediaDeviceInfo[]>([])
  const selectedDeviceId = ref<string | null>(null)

  const config = ref<AudioRecorderConfig>({
    echoCancellation: true,
    noiseSuppression: true,
    sampleRate: 44100,
    maxDuration: 300,
    silenceThreshold: -40,
    silenceDuration: 2,
    enableSilenceDetection: true
  })


  let mediaRecorder: MediaRecorder | null = null
  let audioChunks: Blob[] = []
  let timerInterval: number | null = null
  let stream: MediaStream | null = null
  let transcriptionCallback: ((text: string) => void) | null = null
  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let meterInterval: number | null = null
  let silenceCheckInterval: number | null = null

  const hasRecording = computed(() => audioBlob.value !== null)
  const formattedTime = computed(() => {
    const mins = Math.floor(recordingTime.value / 60)
    const secs = recordingTime.value % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  })
  const canRecord = computed(() => !isRecording.value && !isTranscribing.value)


  async function loadAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const inputs = devices.filter(d => d.kind === 'audioinput')

      const filtered: MediaDeviceInfo[] = []
      const seenGroups = new Set<string>()

      for (const d of inputs) {
        const isValid = d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications'
        if (isValid && !seenGroups.has(d.groupId)) {
          filtered.push(d)
          seenGroups.add(d.groupId)
        }
      }

      audioDevices.value = filtered

      if (!selectedDeviceId.value && audioDevices.value.length > 0) {
        selectedDeviceId.value = audioDevices.value[0].deviceId
      }
    } catch (err) {
      console.error('Failed to load audio devices:', err)
    }
  }

  async function startRecording() {
    if (!canRecord.value) return

    try {
      error.value = null

      if (!selectedDeviceId.value) {
        await loadAudioDevices()
      }

      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: selectedDeviceId.value ? { exact: selectedDeviceId.value } : undefined,
          echoCancellation: config.value.echoCancellation,
          noiseSuppression: config.value.noiseSuppression,
          sampleRate: config.value.sampleRate
        }
      })

      startAudioMeter(stream)

      if (config.value.enableSilenceDetection) {
        startSilenceDetection()
      }

      const mimeType = getSupportedMimeType()
      mediaRecorder = new MediaRecorder(stream, { mimeType })
      audioChunks = []

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data)
        }
      }

      mediaRecorder.onstop = async () => {
        const blob = new Blob(audioChunks, { type: mimeType })
        audioBlob.value = blob
        audioUrl.value = URL.createObjectURL(blob)

        cleanupStream()
        await transcribeAudio()
      }

      mediaRecorder.onerror = (event) => {
        error.value = 'Recording error occurred'
        console.error('MediaRecorder error:', event)
        stopRecording()
      }

      mediaRecorder.start()
      isRecording.value = true
      recordingTime.value = 0

      startTimer()

    } catch (err) {
      stopAudioMeter()
      stopSilenceDetection()
      cleanupStream()
      error.value = err instanceof Error ? err.message : 'Failed to start recording'
      console.error('Error starting recording:', err)
    }
  }

  function stopRecording() {
    if (mediaRecorder && isRecording.value) {
      mediaRecorder.stop()
      isRecording.value = false
      isPaused.value = false
    }
    stopTimer()
    stopSilenceDetection()
    stopAudioMeter()
  }

  function cancelRecording() {
    if (mediaRecorder && isRecording.value) {
      mediaRecorder.ondataavailable = null
      mediaRecorder.onstop = null
      mediaRecorder.stop()
    }

    stopTimer()
    stopSilenceDetection()
    stopAudioMeter()
    cleanupStream()
    reset()
  }

  function reset() {
    if (audioUrl.value) {
      URL.revokeObjectURL(audioUrl.value)
    }
    audioBlob.value = null
    audioUrl.value = null
    recordingTime.value = 0
    error.value = null
    isRecording.value = false
    isPaused.value = false
    audioLevel.value = 0
  }


  function startAudioMeter(stream: MediaStream) {
    audioContext = new AudioContext()
    analyser = audioContext.createAnalyser()
    const source = audioContext.createMediaStreamSource(stream)

    source.connect(analyser)
    analyser.fftSize = 2048

    const bufferLength = analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)

    meterInterval = window.setInterval(() => {
      analyser!.getByteFrequencyData(dataArray)
      const avg = dataArray.reduce((a, b) => a + b) / bufferLength
      const dB = 20 * Math.log10(avg / 255)

      audioLevel.value = Math.max(0, Math.min(100, ((dB + 60) / 60) * 100))
    }, 100)
  }

  function stopAudioMeter() {
    if (meterInterval) {
      clearInterval(meterInterval)
      meterInterval = null
    }
    if (audioContext) {
      audioContext.close()
      audioContext = null
      analyser = null
    }
  }


  function startSilenceDetection() {
    if (!config.value.enableSilenceDetection || !analyser) return

    const bufferLength = analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)
    let silenceStart: number | null = null

    silenceCheckInterval = window.setInterval(() => {
      analyser!.getByteFrequencyData(dataArray)
      const avg = dataArray.reduce((a, b) => a + b) / bufferLength
      const dB = 20 * Math.log10(avg / 255)

      if (dB < config.value.silenceThreshold) {
        if (!silenceStart) silenceStart = Date.now()
        else if ((Date.now() - silenceStart) / 1000 >= config.value.silenceDuration) {
          stopRecording()
        }
      } else {
        silenceStart = null
      }

    }, 100)
  }

  function stopSilenceDetection() {
    if (silenceCheckInterval) {
      clearInterval(silenceCheckInterval)
      silenceCheckInterval = null
    }
  }

  async function transcribeAudio() {
    if (!audioBlob.value) {
      error.value = 'No audio to transcribe'
      return
    }

    isTranscribing.value = true
    error.value = null

    try {
      if (audioUrl.value) {
        const audio = new Audio(audioUrl.value)
        await audio.play()
      }

      return 'Playback only (test mode)'


      // const formData = new FormData()
      //
      // // Determine file extension from MIME type
      // const extension = audioBlob.value.type.includes('webm') ? 'webm' : 'ogg'
      // formData.append('file', audioBlob.value, `recording.${extension}`)
      // formData.append('model', 'whisper-1') // For OpenAI Whisper
      //
      // const headers: HeadersInit = {}
      // if (apiKey) {
      //   headers['Authorization'] = `Bearer ${apiKey}`
      // }
      //
      // const response = await fetch(endpoint, {
      //   method: 'POST',
      //   headers,
      //   body: formData
      // })
      //
      // if (!response.ok) {
      //   throw new Error(`Transcription failed: ${response.statusText}`)
      // }
      //
      // const data = await response.json()
      // const transcribedText = data.text || data.transcription || ''
      //
      // // Call the registered callback with the transcribed text
      // if (transcriptionCallback && transcribedText) {
      //   transcriptionCallback(transcribedText)
      // }
      //
      // // Reset after successful transcription
      // reset()
      //
      // return transcribedText
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Transcription failed'
      console.error('Transcription error:', err)
      throw err
    } finally {
      isTranscribing.value = false
    }
  }

  function registerTranscriptionCallback(callback: (text: string) => void) {
    transcriptionCallback = callback
  }

  function unregisterTranscriptionCallback() {
    transcriptionCallback = null
  }

  function updateConfig(newConfig: Partial<AudioRecorderConfig>) {
    config.value = { ...config.value, ...newConfig }
  }

  function startTimer() {
    timerInterval = window.setInterval(() => {
      recordingTime.value++

      if (config.value.maxDuration > 0 && recordingTime.value >= config.value.maxDuration) {
        stopRecording()
      }
    }, 1000)
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval)
      timerInterval = null
    }
  }

  function cleanupStream() {
    if (stream) {
      stream.getTracks().forEach(track => track.stop())
      stream = null
    }
  }

  function getSupportedMimeType() {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4'
    ]
    for (const t of types) {
      if (MediaRecorder.isTypeSupported(t)) return t
    }
    return 'audio/webm'
  }

  function $dispose() {
    cancelRecording()
    if (audioUrl.value) {
      URL.revokeObjectURL(audioUrl.value)
    }
  }

  function updateSelectedDevice(id: string | null) {
    selectedDeviceId.value = id
  }


  return {
    // State
    isRecording,
    isPaused,
    recordingTime,
    audioBlob,
    audioUrl,
    error,
    isTranscribing,
    config,
    audioDevices,
    selectedDeviceId,
    audioLevel,

    // Computed
    hasRecording,
    formattedTime,
    canRecord,

    // Actions
    startRecording,
    stopRecording,
    cancelRecording,
    reset,
    updateSelectedDevice,
    loadAudioDevices,
    registerTranscriptionCallback,
    unregisterTranscriptionCallback,
    updateConfig,
    $dispose
  }
})
