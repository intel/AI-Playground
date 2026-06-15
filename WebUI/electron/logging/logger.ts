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

// Log files are never rotated within a day, so the directory only grows. Cap the
// combined size of all `aip-*.log` files; oldest are pruned first.
const MAX_TOTAL_LOG_SIZE_BYTES = 100 * 1024 * 1024
const LOG_FILE_PATTERN = /^aip-\d{4}-\d{2}-\d{2}\.log$/

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
    const filePath = path.join(this.pathToLogFiles, fileName)
    const isNewFile = !fs.existsSync(filePath)
    fs.appendFileSync(filePath, logMessage + '\r\n')
    // Only check on file creation (once per day) to avoid the cost of a directory
    // scan on every log line.
    if (isNewFile) {
      this.enforceTotalLogSizeLimit()
    }
  }

  // Deletes the oldest log files until the combined size of all log files is
  // within the limit. The freshly created file is kept regardless.
  private enforceTotalLogSizeLimit() {
    try {
      const logFiles = fs
        .readdirSync(this.pathToLogFiles)
        .filter((name) => LOG_FILE_PATTERN.test(name))
        .map((name) => ({
          name,
          path: path.join(this.pathToLogFiles, name),
          size: fs.statSync(path.join(this.pathToLogFiles, name)).size,
        }))
        // Oldest first: file names sort chronologically (aip-YYYY-MM-DD.log).
        .sort((a, b) => a.name.localeCompare(b.name))

      let totalSize = logFiles.reduce((sum, file) => sum + file.size, 0)

      for (const file of logFiles) {
        if (totalSize <= MAX_TOTAL_LOG_SIZE_BYTES) {
          break
        }
        // Never delete the newest file (the one just created/appended to).
        if (file.name === logFiles[logFiles.length - 1].name) {
          break
        }
        fs.rmSync(file.path)
        totalSize -= file.size
      }
    } catch (error) {
      console.error(`Could not enforce log size limit: ${error}`)
    }
  }

  getDebugFileName(): string {
    const currentDate = new Date()
    const formattedDate = currentDate.toISOString().split('T')[0]
    return `aip-${formattedDate}`
  }
}

export const appLoggerInstance = new Logger()
