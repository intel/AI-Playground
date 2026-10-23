import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { transcribe } from '../speech/speechIO'
import { convertToWav } from '@/lib/audioUtils'

export interface AudioRecorderConfig {
  echoCancellation: boolean
  noiseSuppression: boolean
  sampleRate: number
  maxDuration: number
  silenceThreshold: number
  silenceDuration: number
  enableSilenceDetection: boolean
}

export type StartRecordingOptions = {
  /** Never auto-stop on silence; only Stop (or max duration) ends the take. */
  manualStopOnly?: boolean
}

const RECORDING_TIMESLICE_MS = 250
const MIN_RECORDING_MS = 400

function pickRecordingMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/webm;codecs=pcm',
  ]
  for (const mimeType of candidates) {
    if (MediaRecorder.isTypeSupported(mimeType)) return mimeType
  }
  return ''
}

export const useAudioRecorder = defineStore('audioRecorder', () => {
  const isRecording = ref(false)
  const recordingTime = ref(0)
  const audioBlob = ref<Blob | null>(null)
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
    enableSilenceDetection: false,
  })

  let mediaRecorder: MediaRecorder | null = null
  let activeMimeType = ''
  let audioChunks: Blob[] = []
  let timerInterval: number | null = null
  let stream: MediaStream | null = null
  let transcriptionCallback: ((text: string) => void) | null = null
  let recordingCompleteHandler: ((wavBlob: Blob) => Promise<void>) | null = null
  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let meterInterval: number | null = null
  let silenceCheckInterval: number | null = null
  let recordingStartedAt = 0
  let stopRequested = false
  let manualStopOnlySession = false
  let processingStop = false

  const canRecord = computed(() => !isRecording.value && !isTranscribing.value)

  async function loadAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const inputs = devices.filter((d) => d.kind === 'audioinput')

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

  function finishRecordingSession() {
    stopTimer()
    stopSilenceDetection()
    stopAudioMeter()
    cleanupStream()
    mediaRecorder = null
    activeMimeType = ''
    audioChunks = []
    manualStopOnlySession = false
    stopRequested = false
    processingStop = false
  }

  function buildConstraints(): MediaTrackConstraints {
    const base: MediaTrackConstraints = {
      echoCancellation: config.value.echoCancellation,
      noiseSuppression: config.value.noiseSuppression,
    }
    if (manualStopOnlySession) {
      if (selectedDeviceId.value) {
        base.deviceId = { ideal: selectedDeviceId.value }
      }
      return base
    }
    return {
      ...base,
      deviceId: selectedDeviceId.value ? { exact: selectedDeviceId.value } : undefined,
      sampleRate: config.value.sampleRate,
    }
  }

  async function processStoppedRecording(userStopped: boolean) {
    if (processingStop) return
    processingStop = true
    isRecording.value = false

    const elapsedMs = Date.now() - recordingStartedAt
    const containerBlob = new Blob(audioChunks, {
      type: activeMimeType || mediaRecorder?.mimeType || 'audio/webm',
    })
    const hasUsableAudio =
      elapsedMs >= MIN_RECORDING_MS && containerBlob.size >= 256 && audioChunks.length > 0

    try {
      if (!hasUsableAudio) {
        if (!userStopped) {
          error.value =
            'Recording ended unexpectedly. Press Record, speak, then press Stop recording.'
        } else {
          error.value =
            'Recording was too short. Hold Record while you speak, then press Stop recording.'
        }
        return
      }

      const wavBlob = await convertToWav(containerBlob)

      if (recordingCompleteHandler && manualStopOnlySession) {
        isTranscribing.value = true
        error.value = null
        try {
          await recordingCompleteHandler(wavBlob)
        } catch (err) {
          error.value = err instanceof Error ? err.message : 'Transcription failed'
          throw err
        } finally {
          isTranscribing.value = false
        }
        reset()
        return
      }

      audioBlob.value = wavBlob
      await transcribeAudio()
    } catch (err) {
      if (!error.value) {
        error.value = err instanceof Error ? err.message : 'Recording processing failed'
      }
      console.error('Recording onstop failed:', err)
    } finally {
      finishRecordingSession()
    }
  }

  async function startRecording(options?: StartRecordingOptions) {
    if (!canRecord.value) return

    manualStopOnlySession = options?.manualStopOnly === true
    if (manualStopOnlySession) {
      config.value = { ...config.value, enableSilenceDetection: false }
    }

    try {
      error.value = null
      stopRequested = false
      processingStop = false

      if (!selectedDeviceId.value) {
        await loadAudioDevices()
      }

      stream = await navigator.mediaDevices.getUserMedia({
        audio: buildConstraints(),
      })

      if (!manualStopOnlySession) {
        startAudioMeter(stream)
        if (config.value.enableSilenceDetection) {
          startSilenceDetection()
        }
      }

      activeMimeType = pickRecordingMimeType()
      mediaRecorder = activeMimeType
        ? new MediaRecorder(stream, { mimeType: activeMimeType })
        : new MediaRecorder(stream)
      if (!activeMimeType) {
        activeMimeType = mediaRecorder.mimeType
      }
      audioChunks = []

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data)
        }
      }

      mediaRecorder.onstop = () => {
        const userStopped = stopRequested
        stopRequested = false
        void processStoppedRecording(userStopped)
      }

      mediaRecorder.onerror = (event) => {
        error.value = 'Recording error occurred'
        console.error('MediaRecorder error:', event)
        if (mediaRecorder?.state === 'recording') {
          stopRequested = false
          mediaRecorder.stop()
        } else {
          isRecording.value = false
          finishRecordingSession()
        }
      }

      mediaRecorder.start(RECORDING_TIMESLICE_MS)
      isRecording.value = true
      recordingTime.value = 0
      recordingStartedAt = Date.now()

      startTimer()
    } catch (err) {
      finishRecordingSession()
      isRecording.value = false
      error.value = err instanceof Error ? err.message : 'Failed to start recording'
      console.error('Error starting recording:', err)
    }
  }

  function stopRecording() {
    if (!mediaRecorder) return
    const stillCapturing = isRecording.value || mediaRecorder.state === 'recording'
    if (!stillCapturing) return

    stopRequested = true
    isRecording.value = false
    stopTimer()
    stopSilenceDetection()

    if (mediaRecorder.state === 'recording') {
      try {
        mediaRecorder.requestData()
      } catch {
        /* requestData is best-effort before stop */
      }
      mediaRecorder.stop()
    }
  }

  function reset() {
    audioBlob.value = null
    recordingTime.value = 0
    error.value = null
    isRecording.value = false
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
      if (!analyser) return
      analyser.getByteFrequencyData(dataArray)
      const avg = dataArray.reduce((a, b) => a + b) / bufferLength
      const dB = 20 * Math.log10(Math.max(avg, 1) / 255)

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
    if (!config.value.enableSilenceDetection || !analyser || manualStopOnlySession) return

    const bufferLength = analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)
    let silenceStart: number | null = null

    silenceCheckInterval = window.setInterval(() => {
      if (!analyser) return
      if (Date.now() - recordingStartedAt < 1000) return
      analyser.getByteFrequencyData(dataArray)
      const avg = dataArray.reduce((a, b) => a + b) / bufferLength
      const dB = 20 * Math.log10(Math.max(avg, 1) / 255)

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
      // The mic's blob is already WAV (see onstop) — the adapter's transcribe
      // detects that and sends it without a re-encode.
      const { text } = await transcribe({ audio: audioBlob.value })
      const trimmed = text.trim()
      const meaningless = trimmed.length > 0 && /^[.\s…]+$/.test(trimmed)

      if (transcriptionCallback && trimmed && !meaningless) {
        transcriptionCallback(trimmed)
      } else if (meaningless || !trimmed) {
        error.value =
          "Couldn't make out any speech in that recording. Try speaking closer to the mic, then press Stop."
      }

      reset()
      return trimmed
    } catch (err) {
      reset()
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

  function registerRecordingCompleteHandler(handler: (wavBlob: Blob) => Promise<void>) {
    recordingCompleteHandler = handler
  }

  function unregisterRecordingCompleteHandler() {
    recordingCompleteHandler = null
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
      stream.getTracks().forEach((track) => track.stop())
      stream = null
    }
  }

  function updateSelectedDevice(id: string | null) {
    selectedDeviceId.value = id
  }

  return {
    isRecording,
    recordingTime,
    audioBlob,
    error,
    isTranscribing,
    config,
    audioDevices,
    selectedDeviceId,
    audioLevel,

    startRecording,
    stopRecording,
    updateSelectedDevice,
    loadAudioDevices,
    registerTranscriptionCallback,
    unregisterTranscriptionCallback,
    registerRecordingCompleteHandler,
    unregisterRecordingCompleteHandler,
    updateConfig,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAudioRecorder, import.meta.hot))
}
