import WebContents = Electron.WebContents
import fs from 'fs'
import path from 'node:path'
import { app } from 'electron'

class Logger {
  webContents: WebContents | null = null
  private pathToLogFiles: string = path.resolve(
    app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../external/'),
  )
  private startupMessageCache: {
    message: string
    source: string
    level: 'error' | 'warn' | 'info'
  }[] = []

  constructor() {}

  onWebcontentReady(webContents: WebContents) {
    this.webContents = webContents
    this.startupMessageCache.forEach((logEntry) => {
      this.webContents!.send('debugLog', logEntry)
    })
    this.startupMessageCache = []
  }

  info(message: string, source: string, alsoLogToFile: boolean = false) {
    if (alsoLogToFile) {
      this.logMessageToFile(message, source)
    }
    console.info(`[${source}]: ${message}`)
    if (this.webContents) {
      try {
        this.webContents.send('debugLog', { level: 'info', source, message })
      } catch (_error) {
        console.error('Could not send debug log to renderer process')
      }
    } else {
      this.startupMessageCache.push({ level: 'info', source, message })
    }
  }

  warn(message: string, source: string, alsoLogToFile: boolean = false) {
    if (alsoLogToFile) {
      this.logMessageToFile(message, source)
    }
    console.warn(`[${source}]: ${message}`)
    if (this.webContents) {
      try {
        this.webContents.send('debugLog', { level: 'warn', source, message })
      } catch (_error) {
        console.error('Could not send debug log to renderer process')
      }
    } else {
      this.startupMessageCache.push({ level: 'error', source, message })
    }
  }

  error(message: string, source: string, alsoLogToFile: boolean = false) {
    if (alsoLogToFile) {
      this.logMessageToFile(message, source)
    }

    console.error(`[${source}]: ${message}`)

    if (this.webContents) {
      try {
        this.webContents.send('debugLog', { level: 'error', source, message })
      } catch (_error) {
        console.error('Could not send debug log to renderer process')
      }
    } else {
      this.startupMessageCache.push({ level: 'error', source, message })
    }
  }

  logMessageToFile(message: string, source: string) {
    const fileName = `${this.getDebugFileName()}.log`
    const currentDate = new Date()
    const hours = currentDate.getHours().toString().padStart(2, '0')
    const minutes = currentDate.getMinutes().toString().padStart(2, '0')
    const seconds = currentDate.getSeconds().toString().padStart(2, '0')

    const formattedTime = `${hours}:${minutes}:${seconds}`
    const logMessage = `${formattedTime}|${source}|${message}`
    fs.appendFileSync(path.join(this.pathToLogFiles, fileName), logMessage + '\r\n')
  }

  getDebugFileName(): string {
    const currentDate = new Date()
    const formattedDate = currentDate.toISOString().split('T')[0]
    return `aip-${formattedDate}`
  }
}

export const appLoggerInstance = new Logger()
