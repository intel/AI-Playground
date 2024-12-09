import WebContents = Electron.WebContents;
import fs from "fs";
import path from "node:path";
import {app} from "electron";


class Logger {
    webContents: WebContents | null = null
    private pathToLogFiles: string = path.resolve(app.isPackaged ? process.resourcesPath : path.join(__dirname, "../../external/"));
    private startupMessageCache: {
        message: string,
        source: string,
        level: 'error' | 'warn' | 'info'
    }[] = []

    constructor() {
    }

    onWebcontentReady(webContents: WebContents) {
        this.webContents = webContents
        this.startupMessageCache.forEach((logEntry) => {
            this.webContents!.send('debugLog', logEntry)
        });
        this.startupMessageCache = []
    }

    info(message: string, source: string, alsoLogToFile: boolean = true) {
        console.info(`[${source}]: ${message}`);
        if (alsoLogToFile) {
            this.logMessage(`${source} | ${message}`)
        }
        if (this.webContents) {
            try {
                this.webContents.send('debugLog', {level: 'info', source, message})
            } catch (error) {
                console.error('Could not send debug log to renderer process');
            }
        } else {
            this.startupMessageCache.push({level: 'info', source, message})
        }
    }

    warn(message: string, source: string, alsoLogToFile: boolean = true) {
        console.warn(`[${source}]: ${message}`);
        if (alsoLogToFile) {
            this.logMessage(`${source} | ${message}`)
        }
        if (this.webContents) {
            try {
                this.webContents.send('debugLog', {level: 'warn', source, message})
            } catch (error) {
                console.error('Could not send debug log to renderer process');
            }
        } else {
            this.startupMessageCache.push({level: 'error', source, message})
        }
    }

    error(message: string, source: string, alsoLogToFile: boolean = true) {
        console.error(`[${source}]: ${message}`);
        if (alsoLogToFile) {
            this.logMessage(`${source} | ${message}`)
        }
        if (this.webContents) {
            try {
                this.webContents.send('debugLog', {level: 'error', source, message})
            } catch (error) {
                console.error('Could not send debug log to renderer process');
            }
        } else {
            this.startupMessageCache.push({level: 'error', source, message})
        }
    }


    logMessage(message: string) {
        const fileName = `${this.getDebugFileName()}.log`
        fs.appendFileSync(path.join(this.pathToLogFiles, fileName), message + "\r\n");
    }

    getDebugFileName(): string {
        const currentDate = new Date();
        const formattedDate = currentDate.toISOString().split('T')[0];
        return `aip-${formattedDate}`
    }
}

export const appLoggerInstance = new Logger()
