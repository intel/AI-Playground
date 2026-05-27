import WebContents = Electron.WebContents
import fs from 'fs'
import path from 'node:path'
import { app } from 'electron'

// Telegram bot tokens (`<id>:<token>`) and similar secrets must never appear in
// console output, log files, or the renderer debug stream. Belt-and-suspenders
// alongside the Python-side filter — the same regex catches httpx URL forms,
// werkzeug logs, and any future direct token logging.
// No \b on the digit side: tokens embed inside URLs like `…/bot<id>:<token>/…`,
// where `bot` is letters and the next char is a digit (no \b between them).
const TOKEN_PATTERN = /\d{6,}:[A-Za-z0-9_-]{20,}/g
const TOKEN_REDACTION = '<TOKEN_REDACTED>'

function redact(message: string): string {
  return message.replace(TOKEN_PATTERN, TOKEN_REDACTION)
}

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
    const safeMessage = redact(message)
    if (alsoLogToFile) {
      this.logMessageToFile(safeMessage, source)
    }
    console.info(`[${source}]: ${safeMessage}`)
    if (this.webContents) {
      try {
        this.webContents.send('debugLog', { level: 'info', source, message: safeMessage })
      } catch (_error) {
        console.error('Could not send debug log to renderer process')
      }
    } else {
      this.startupMessageCache.push({ level: 'info', source, message: safeMessage })
    }
  }

  warn(message: string, source: string, alsoLogToFile: boolean = false) {
    const safeMessage = redact(message)
    if (alsoLogToFile) {
      this.logMessageToFile(safeMessage, source)
    }
    console.warn(`[${source}]: ${safeMessage}`)
    if (this.webContents) {
      try {
        this.webContents.send('debugLog', { level: 'warn', source, message: safeMessage })
      } catch (_error) {
        console.error('Could not send debug log to renderer process')
      }
    } else {
      this.startupMessageCache.push({ level: 'warn', source, message: safeMessage })
    }
  }

  error(message: string, source: string, alsoLogToFile: boolean = false) {
    const safeMessage = redact(message)
    if (alsoLogToFile) {
      this.logMessageToFile(safeMessage, source)
    }

    console.error(`[${source}]: ${safeMessage}`)

    if (this.webContents) {
      try {
        this.webContents.send('debugLog', { level: 'error', source, message: safeMessage })
      } catch (_error) {
        console.error('Could not send debug log to renderer process')
      }
    } else {
      this.startupMessageCache.push({ level: 'error', source, message: safeMessage })
    }
  }

  logMessageToFile(message: string, source: string) {
    const fileName = `${this.getDebugFileName()}.log`
    const currentDate = new Date()
    const hours = currentDate.getHours().toString().padStart(2, '0')
    const minutes = currentDate.getMinutes().toString().padStart(2, '0')
    const seconds = currentDate.getSeconds().toString().padStart(2, '0')

    const formattedTime = `${hours}:${minutes}:${seconds}`
    const logMessage = `${formattedTime}|${source}|${redact(message)}`
    fs.appendFileSync(path.join(this.pathToLogFiles, fileName), logMessage + '\r\n')
  }

  getDebugFileName(): string {
    const currentDate = new Date()
    const formattedDate = currentDate.toISOString().split('T')[0]
    return `aip-${formattedDate}`
  }
}

export const appLoggerInstance = new Logger()
