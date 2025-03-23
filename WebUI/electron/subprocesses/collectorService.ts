import { spawn } from 'child_process'
import path from 'path'

import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const collectorPath = path.join(__dirname, '../../public/tools/collector.ps1')
const gpuidPath = path.join(__dirname, '../../public/tools/gpuid.exe')

let gpuInfo: { adapter: string; luid: string; sharedMemory: string; dedicatedMemory: string }[] = []

export function runGpuid() {
  console.log('Running gpuid...')
  const ps = spawn(gpuidPath)

  ps.stdout.on('data', (data) => {
    const output = data.toString()
    processGPUIdOutput(output)
  })

  ps.stderr.on('data', (data) => {
    console.error('Error:', data.toString())
  })

  ps.on('close', (code) => {
    console.log(`GPUId tool exited with code ${code}`)
  })
}

export function runPowerShellScript() {
  console.log('Running PowerShell script...')
  const ps = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    collectorPath,
  ])

  ps.stdout.on('data', (data) => {
    const output = data.toString()
    processOutput(output)
  })

  ps.stderr.on('data', (data) => {
    console.error('Error:', data.toString())
  })

  ps.on('close', (code) => {
    console.log(`PowerShell script exited with code ${code}`)
    runPowerShellScript() // Restart the process
  })
}

export function processGPUIdOutput(output: string) {
  const lines = output.split('\n')
  gpuInfo = []
  let currentAdapter: {
    adapter: string
    luid: string
    sharedMemory: string
    dedicatedMemory: string
  } | null = null

  lines.forEach((line) => {
    if (line.startsWith('Found adapter:')) {
      if (currentAdapter) {
        gpuInfo.push(currentAdapter)
      }
      currentAdapter = {
        adapter: line.replace('Found adapter: ', '').trim(),
        luid: '',
        sharedMemory: '',
        dedicatedMemory: '',
      }
    } else if (currentAdapter) {
      const [key, value] = line.split(':')
      switch (key.trim()) {
        case 'Adapter LUID':
          currentAdapter.luid = value.trim().split(' ')[0]
          break
        case 'Adapter Shared Memory':
          currentAdapter.sharedMemory = value.trim().split(' ')[0]
          break
        case 'Adapter Dedicated Memory':
          currentAdapter.dedicatedMemory = value.trim().split(' ')[0]
          break
      }
    }
  })

  if (currentAdapter) {
    gpuInfo.push(currentAdapter)
  }

  // Log the GPU info
  console.log('GPU Info:', gpuInfo)
}

import { BrowserWindow } from 'electron'
let win: BrowserWindow | null = null

export function setWindow(window: BrowserWindow) {
  win = window
}

function processOutput(output: string) {
  // Split output by new line
  const lines = output.split('\n')

  // Process each line
  lines.forEach((line) => {
    // Initialize metrics object
    let metrics: { [key: string]: number } = {}

    // Split line by space
    const segments = line.split(' ')

    // Check that the first segment is the "metrics" keyword
    if (segments[0] !== 'metrics') {
      return
    }

    // Process each metric
    segments[1].split(',').forEach((metric) => {
      const [key, value] = metric.split('=')
      metrics[key] = parseFloat(value)
    })

    // Add the timestamp
    metrics['epoch'] = parseInt(segments[2], 10)

    // Send the metrics and GPU info to the renderer
    win?.webContents.send('metrics', { metrics, gpuInfo })
  })
}
