import { ChildProcess } from 'node:child_process'
import { app, BrowserWindow, net } from 'electron'
import * as filesystem from 'fs-extra'
import fsPromises from 'fs/promises'
import path from 'node:path'
import { appLoggerInstance } from '../logging/logger.ts'
import { existingFileOrError, spawnProcessAsync } from './osProcessHelper'
import { assert } from 'node:console'
import { createHash } from 'crypto'

import * as childProcess from 'node:child_process'
import { promisify } from 'util'
import { Arch, getArchPriority, getDeviceArch } from './deviceArch.ts'
import { z } from 'zod'

const exec = promisify(childProcess.exec)

const aipgBaseDir = () =>
  app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../../')
export const hijacksDir = path.resolve(path.join(aipgBaseDir(), `hijacks/ipex_to_cuda`))
const hijacksRemote = 'https://github.com/Disty0/ipex_to_cuda.git'
const hijacksRevision = '7379d6ecbc26a96b1a39f6fc063c61fc8462914f'

const checkHijacksDir = async (): Promise<boolean> => {
  try {
    await filesystem.promises.stat(path.join(hijacksDir, '__init__.py'))
    return true
  } catch (_e) {
    try {
      await filesystem.promises.rm(hijacksDir, { recursive: true })
    } finally {
      return false
    }
  }
}

export const installHijacks = async (): Promise<void> => {
  const git = new GitService()
  if (await checkHijacksDir()) {
    appLoggerInstance.info('ipex_to_cuda hijacks already cloned, skipping', 'ipex-hijacks')
  } else {
    await git.run(['clone', hijacksRemote, hijacksDir])
    await git.run(['-C', hijacksDir, 'checkout', hijacksRevision], {}, hijacksDir)
    await patchFile(
      path.join(hijacksDir, 'hijacks.py'),
      'device_supports_fp64 = torch.xpu.has_fp64_dtype()',
      ['torch.backends.cuda.allow_fp16_bf16_reduction_math_sdp(True)'],
    )
  }
}

export const patchFile = async (
  filePath: string,
  targetLineIncludes: string,
  unindentedLinesToInsert: string[],
): Promise<void> => {
  const targetfilePath = path.normalize(filePath)
  const targetFileContent = await fsPromises.readFile(targetfilePath, 'utf-8')
  const targetFileLines = targetFileContent.split(/\r?\n/)
  const lineAboveSpliceTargetIndex = targetFileLines.findIndex((l) =>
    l.includes(targetLineIncludes),
  )
  if (lineAboveSpliceTargetIndex === -1) {
    throw new Error(`Failed to find line to patch in ${filePath}`)
  }
  const targetIndentation = targetFileLines[lineAboveSpliceTargetIndex].search(/\S/)
  const linesToSpliceIn = unindentedLinesToInsert.map(
    (line) => ' '.repeat(targetIndentation) + line,
  )
  targetFileLines.splice(lineAboveSpliceTargetIndex + 1, 0, ...linesToSpliceIn)
  await fsPromises.writeFile(targetfilePath, targetFileLines.join('\n'))
}

class ServiceCheckError extends Error {
  readonly component: string
  readonly stage: string

  constructor(component: string, stage: string = 'all') {
    super(`Service ${component} check failed at stage ${stage}`)
    this.name = 'ServiceCheckError'
    this.component = component
    this.stage = stage
  }
}

export interface GenericService {
  name: string

  /**
   * Check first, then repair/install if check fails
   * @throws any error if repair/install throws
   */
  ensureInstalled(): Promise<void>

  /**
   * @throws ServiceCheckError if check fails
   */
  check(): Promise<void>

  /**
   * Fresh install
   * @throws any error
   */
  install(): Promise<void>

  /**
   * Repair install
   * @param checkError error that caused the repair
   * @throws any error
   */
  repair(checkError: ServiceCheckError): Promise<void>
}

export abstract class GenericServiceImpl implements GenericService {
  name: string

  readonly appLogger = appLoggerInstance
  readonly baseDir = aipgBaseDir()

  constructor(name: string) {
    this.name = name
  }

  async ensureInstalled(): Promise<void> {
    try {
      await this.check()
    } catch (e) {
      if (e instanceof ServiceCheckError) {
        await this.repair(e)
      } else {
        await this.install()
      }
    }
  }

  abstract check(): Promise<void>
  abstract install(): Promise<void>
  abstract repair(checkError: ServiceCheckError): Promise<void>

  log(msg: string) {
    this.appLogger.info(msg, this.name)
  }

  logError(msg: string) {
    this.appLogger.error(msg, this.name, true)
  }
}

abstract class ExecutableService extends GenericServiceImpl {
  dir: string

  constructor(name: string, dir: string) {
    super(name)
    this.dir = dir
  }

  abstract getExePath(): string

  async run(args: string[] = [], extraEnv?: object, workDir?: string): Promise<string> {
    const exePath = existingFileOrError(this.getExePath())
    return spawnProcessAsync(exePath, args, (data) => this.log(data), extraEnv, workDir)
  }
}

export class PythonService extends ExecutableService {
  constructor(
    readonly dir: string,
    readonly serviceDir: string,
  ) {
    super('python', dir)
  }

  getExePath(): string {
    return path.resolve(path.join(this.dir, 'python.exe'))
  }

  async check(): Promise<void> {
    this.log('checking')
    try {
      await this.run(['--version'])
    } catch (e) {
      this.log(`warning: ${e}`)
      throw new ServiceCheckError(this.name)
    }
  }

  async install(): Promise<void> {
    this.log(
      `installing python env at ${this.dir} from ${this.name} for service ${this.serviceDir}`,
    )
    await this.clonePythonEnv()
  }

  async repair(checkError: ServiceCheckError): Promise<void> {
    assert(checkError.component === this.name)
    await this.install()
  }

  readonly prototypicalEnvDir = app.isPackaged
    ? path.join(this.baseDir, 'prototype-python-env')
    : path.join(this.baseDir, 'build/python-env')
  private async clonePythonEnv(): Promise<void> {
    existingFileOrError(this.prototypicalEnvDir)
    if (filesystem.existsSync(this.dir)) {
      this.log(`removing existing python env at ${this.dir}`)
      filesystem.removeSync(this.dir)
    }
    this.log(`copying prototypical python env to ${this.dir} for service in ${this.serviceDir}`)
    await filesystem.copy(this.prototypicalEnvDir, this.dir)

    // Find the Python version by looking for python*._pth file
    const files = filesystem.readdirSync(this.dir)
    const pthFilePattern = /^python(\d+)\._pth$/
    let pythonVersion = null
    let pthFileName = null

    for (const file of files) {
      const match = file.match(pthFilePattern)
      if (match) {
        pythonVersion = match[1]
        pthFileName = file
        break
      }
    }

    if (!pythonVersion || !pthFileName) {
      this.log(`Could not find python*._pth file in the directory: ${this.dir}`)
      throw new Error(`Could not find python*._pth file in the directory: ${this.dir}`)
    }

    this.log(`Found Python version: ${pythonVersion} (${pthFileName})`)

    filesystem.writeFile(
      path.join(this.dir, pthFileName),
      `
    python${pythonVersion}.zip
    .
    ../${this.serviceDir}
    ../hijacks
    ../backend-shared

    # Uncomment to run site.main() automatically
    import site
    `,
    )
    this.log(`Patched Python paths in ${pthFileName}`)
  }
}

export class PipService extends ExecutableService {
  readonly python: PythonService

  constructor(
    readonly pythonEnvDir: string,
    readonly serviceDir: string,
  ) {
    super('pip', pythonEnvDir)
    this.log(`setting up pip service at ${this.dir} for service ${this.serviceDir}`)
    this.python = new PythonService(this.dir, this.serviceDir)
  }

  getExePath(): string {
    return this.python.getExePath()
  }

  async run(args: string[] = [], extraEnv?: object, workDir?: string): Promise<string> {
    return this.python.run(
      ['-m', 'pip', ...args],
      { ...extraEnv, PYTHONNOUSERSITE: 'true' },
      workDir,
    )
  }

  async check(): Promise<void> {
    this.log('checking')
    try {
      await this.python.check()
      await this.run(['--version'])
      await this.run(['show', 'setuptools'])
      return
    } catch (e) {
      this.log(`warning: ${e}`)
      if (e instanceof ServiceCheckError) throw e
      if (e instanceof Error && e.message.includes('setuptools'))
        throw new ServiceCheckError(this.name, 'setuptools')
      throw new ServiceCheckError(this.name)
    }
  }

  async install(): Promise<void> {
    this.log('start installing')
    await this.python.ensureInstalled()
    await this.getPip()
    await this.run(['install', 'setuptools'])
  }

  async repair(checkError: ServiceCheckError): Promise<void> {
    this.log('repairing')
    if (checkError.component !== this.name) {
      await this.python.repair(checkError)
    }

    switch (checkError.stage) {
      default:
        await this.getPip()
      // fallthrough
      case 'setuptools':
        await this.run(['install', 'setuptools'])
    }
  }

  private async getPip(): Promise<void> {
    const getPipScript = existingFileOrError(path.join(this.dir, 'get-pip.py'))
    await this.python.run([getPipScript], { PYTHONNOUSERSITE: 'true' })
  }

  async installRequirementsTxt(requirementsTxtPath: string): Promise<void> {
    await this.run(['install', '-r', requirementsTxtPath])
  }

  async checkRequirementsTxt(requirementsTxtPath: string): Promise<void> {
    await this.python
      .run([
        '-c',
        `import pkg_resources; pkg_resources.require([s for s in open(r'${requirementsTxtPath}') if s and s[0].isalpha()])`,
      ])
      .catch((e: unknown) => {
        throw new Error(`requirements check failed: ${e}`)
      })
  }
}

export class UvPipService extends PipService {
  readonly pip: PipService
  readonly python: PythonService

  constructor(
    readonly pythonEnvDir: string,
    readonly serviceDir: string,
  ) {
    super(pythonEnvDir, serviceDir)
    this.log(`setting up uv-pip service at ${this.dir} for service ${this.serviceDir}`)
    this.pip = new PipService(this.dir, this.serviceDir)
    this.python = this.pip.python
    this.name = 'uvpip'
  }

  async run(args: string[] = [], extraEnv?: object, workDir?: string): Promise<string> {
    return this.python.run(
      ['-m', 'uv', 'pip', ...args],
      { ...extraEnv, PYTHONNOUSERSITE: 'true', UV_LINK_MODE: 'copy' },
      workDir,
    )
  }

  async check(): Promise<void> {
    this.log('checking')
    try {
      await this.pip.check()
      await this.run(['--version'])
    } catch (e) {
      this.log(`warning: ${e}`)
      if (e instanceof ServiceCheckError) throw e
      throw new ServiceCheckError(this.name)
    }
  }

  async install(): Promise<void> {
    this.log('start installing')
    await this.pip.ensureInstalled()
    await this.pip.run(['install', 'uv'])
  }

  async repair(checkError: ServiceCheckError): Promise<void> {
    this.log('repairing')
    if (checkError.component !== this.name) {
      await this.pip.repair(checkError)
    }
    await this.pip.run(['install', 'uv'])
  }
}

export class GitService extends ExecutableService {
  constructor() {
    super('git', '')
    this.dir = path.resolve(path.join(this.baseDir, 'portable-git'))
  }

  getExePath(): string {
    return path.resolve(path.join(this.dir, 'cmd/git.exe'))
  }

  async run(args: string[] = [], extraEnv?: object, workDir?: string): Promise<string> {
    // Explicitly specify the cert file bundled with portable git,
    // to avoid being affected by the system git configuration.
    const env = {
      ...extraEnv,
      GIT_SSL_CAINFO: path.resolve(path.join(this.dir, 'mingw64/etc/ssl/certs/ca-bundle.crt')),
    }
    return super.run(args, env, workDir)
  }

  async check(): Promise<void> {
    this.log('checking')
    try {
      await this.run(['--version'])
    } catch (e) {
      this.log(`warning: ${e}`)
      throw new ServiceCheckError(this.name)
    }
  }

  async install(): Promise<void> {
    this.log('start installing')
    await this.downloadGitZip()
    await this.unzipGit()

    // cleanup
    if (filesystem.existsSync(this.zipPath)) {
      filesystem.removeSync(this.zipPath)
    }
  }

  async repair(checkError: ServiceCheckError): Promise<void> {
    assert(checkError.component === this.name)
    await this.install()
  }

  readonly remoteUrl =
    'https://github.com/git-for-windows/git/releases/download/v2.48.1.windows.1/PortableGit-2.48.1-64-bit.7z.exe'
  readonly sha256 = 'a4335111b3363871cac632be93d7466154d8eb08782ff55103866b67d6722257'
  readonly zipPath = path.resolve(path.join(this.baseDir, 'portable-git.7z.exe'))
  readonly unzipExePath = path.resolve(path.join(this.baseDir, '7zr.exe'))

  private async checkGitZip(): Promise<boolean> {
    if (!filesystem.existsSync(this.zipPath)) {
      return false
    }
    const sha256sum = await filesystem
      .readFile(this.zipPath)
      .then((data) => createHash('sha256').update(data).digest('hex'))
    return sha256sum === this.sha256
  }

  private async downloadGitZip(): Promise<void> {
    this.log('downloading git archive')
    // Reuse existing zip if checksum matches
    if (await this.checkGitZip()) {
      this.log('Using existing git archive')
      return
    }

    // Delete existing zip if checksum does not match
    if (filesystem.existsSync(this.zipPath)) {
      this.logError('Removing broken git archive')
      filesystem.removeSync(this.zipPath)
    }

    // Using electron net for better proxy support
    const response = await net.fetch(this.remoteUrl)
    if (!response.ok || response.status !== 200 || !response.body) {
      throw new Error(`Failed to download git: ${response.statusText}`)
    }
    const buffer = await response.arrayBuffer()
    await filesystem.writeFile(this.zipPath, Buffer.from(buffer))
    if (!(await this.checkGitZip())) {
      throw new Error(`Checksum mismatch: ${this.zipPath}`)
    }
    this.log('git archive successfully downloaded')
  }

  private async unzipGit(): Promise<void> {
    try {
      await exec(`"${this.unzipExePath}" x "${this.zipPath}" -o"${this.dir}"`)
      this.log('Unzipping git archive successful')
    } catch (error) {
      throw new Error(`Unzip error: ${error}`)
    }
  }
}

export const aiBackendServiceDir = () =>
  path.resolve(
    app.isPackaged
      ? path.join(process.resourcesPath, 'service')
      : path.join(__dirname, '../../../service'),
  )

export interface ApiService {
  readonly name: string
  readonly baseUrl: string
  readonly port: number
  readonly isRequired: boolean
  currentStatus: BackendStatus
  isSetUp: boolean

  selectDevice(deviceId: string): Promise<void>
  detectDevices(): Promise<void>
  set_up(): AsyncIterable<SetupProgress>
  start(): Promise<BackendStatus>
  stop(): Promise<BackendStatus>
  updateSettings(settings: ServiceSettings): Promise<void>
  getSettings(): Promise<ServiceSettings>
  uninstall(): Promise<void>
  get_info(): ApiServiceInformation
  ensureBackendReadiness(llmModelName: string, embeddingModelName?: string): Promise<void>
}

export abstract class LongLivedPythonApiService implements ApiService {
  readonly name: BackendServiceName
  readonly baseUrl: string
  readonly port: number
  readonly win: BrowserWindow
  readonly settings: LocalSettings
  abstract readonly isRequired: boolean
  abstract healthEndpointUrl: string

  encapsulatedProcess: ChildProcess | null = null

  readonly baseDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../../')
  readonly prototypicalPythonEnv = app.isPackaged
    ? path.join(this.baseDir, 'prototype-python-env')
    : path.join(this.baseDir, 'build-envs/online/prototype-python-env')
  readonly wheelDir = path.join(
    app.isPackaged ? this.baseDir : path.join(__dirname, '../../external/'),
  )
  abstract readonly pythonEnvDir: string
  abstract readonly serviceDir: string
  abstract isSetUp: boolean
  abstract devices: InferenceDevice[]

  desiredStatus: BackendStatus = 'uninitializedStatus'
  currentStatus: BackendStatus = 'uninitializedStatus'

  readonly appLogger = appLoggerInstance

  constructor(name: BackendServiceName, port: number, win: BrowserWindow, settings: LocalSettings) {
    this.win = win
    this.name = name
    this.port = port
    this.baseUrl = `http://127.0.0.1:${port}`
    this.settings = settings
  }

  abstract serviceIsSetUp(): boolean
  abstract detectDevices(): Promise<void>

  async selectDevice(deviceId: string): Promise<void> {
    if (!this.devices.find((d) => d.id === deviceId)) return
    this.devices = this.devices.map((d) => ({ ...d, selected: d.id === deviceId }))
    this.updateStatus()
  }

  updateSettings(settings: ServiceSettings): Promise<void> {
    this.appLogger.info(
      `updating settings with ${settings}, but settings are not implemented`,
      this.name,
    )
    return Promise.resolve()
  }

  getSettings(): Promise<ServiceSettings> {
    this.appLogger.info(`get settings called, but settings are not implemented`, this.name)
    return Promise.resolve({ serviceName: this.name })
  }

  setStatus(status: BackendStatus) {
    this.currentStatus = status
    this.updateStatus()
  }

  updateStatus() {
    this.win.webContents.send('serviceInfoUpdate', this.get_info())
  }

  get_info(): ApiServiceInformation {
    if (this.currentStatus === 'uninitializedStatus') {
      this.currentStatus = this.isSetUp ? 'notYetStarted' : 'notInstalled'
    }
    return {
      serviceName: this.name,
      status: this.currentStatus,
      baseUrl: this.baseUrl,
      port: this.port,
      isSetUp: this.isSetUp,
      isRequired: this.isRequired,
      devices: this.devices,
    }
  }

  abstract set_up(): AsyncIterable<SetupProgress>

  async uninstall(): Promise<void> {
    this.stop()
    this.appLogger.info(`removing python env of ${this.name} service`, this.name)
    await filesystem.remove(this.pythonEnvDir)
    this.appLogger.info(`removed python env of ${this.name} service`, this.name)
    this.setStatus('notInstalled')
  }

  async start(): Promise<BackendStatus> {
    if (
      this.desiredStatus === 'stopped' &&
      !(this.currentStatus === 'stopped' || this.currentStatus === 'notYetStarted')
    ) {
      throw new Error('Server currently stopping. Cannot start it.')
    }
    if (this.currentStatus === 'running') {
      return 'running'
    }
    if (this.desiredStatus === 'running') {
      throw new Error('Server startup already requested')
    }

    this.desiredStatus = 'running'
    this.setStatus('starting')
    try {
      this.appLogger.info(` trying to start ${this.name} python API`, this.name)
      const trackedProcess = await this.spawnAPIProcess()
      this.encapsulatedProcess = trackedProcess.process
      this.pipeProcessLogs(trackedProcess.process)
      if (await this.listenServerReady(trackedProcess.didProcessExitEarlyTracker)) {
        this.currentStatus = 'running'
        this.appLogger.info(`started server ${this.name} on ${this.baseUrl}`, this.name)
        this.isSetUp = true
      } else {
        this.currentStatus = 'failed'
        this.desiredStatus = 'failed'
        this.isSetUp = false
        this.appLogger.error(`server ${this.name} failed to boot`, this.name)
        this.encapsulatedProcess?.kill()
      }
    } catch (error) {
      this.appLogger.error(` failed to start server due to ${error}`, this.name)
      this.currentStatus = 'failed'
      this.desiredStatus = 'failed'
      this.isSetUp = false
      this.encapsulatedProcess?.kill()
      this.encapsulatedProcess = null
    } finally {
      this.win.webContents.send('serviceInfoUpdate', this.get_info())
    }
    return this.currentStatus
  }

  async stop(): Promise<BackendStatus> {
    this.appLogger.info(
      `Stopping backend ${this.name}. It was in state ${this.currentStatus}`,
      this.name,
    )
    this.desiredStatus = 'stopped'
    this.setStatus('stopping')
    this.encapsulatedProcess?.kill()
    await new Promise((resolve) => {
      setTimeout(() => {
        resolve('killedprocess (hopefully)')
      }, 1000)
    })

    this.encapsulatedProcess = null
    this.setStatus('stopped')
    return 'stopped'
  }

  async ensureBackendReadiness(llmModelName: string, embeddingModelName?: string): Promise<void> {
    this.appLogger.info(
      `ensureBackendReadiness called for LLM: ${llmModelName}, Embedding: ${embeddingModelName ?? 'none'}`,
      this.name,
    )
  }

  abstract spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }>

  pipeProcessLogs(process: ChildProcess) {
    process.stdout!.on('data', (message) => {
      if (message.toString().startsWith('INFO')) {
        this.appLogger.info(`${message}`, this.name)
      } else if (message.toString().startsWith('WARN')) {
        this.appLogger.warn(`${message}`, this.name)
      } else {
        this.appLogger.error(`${message}`, this.name)
      }
    })

    process.stderr!.on('data', (message) => {
      this.appLogger.error(`${message}`, this.name)
    })
    process.on('error', (message) => {
      this.appLogger.error(
        `backend process ${this.name} exited abruptly due to : ${message}`,
        this.name,
      )
    })
  }

  async listenServerReady(didProcessExitEarlyTracker: Promise<boolean>): Promise<boolean> {
    const startTime = performance.now()
    const processStartupCompletePromise = new Promise<boolean>(async (resolve) => {
      const queryIntervalMs = 250
      const startupPeriodMaxMs = 300000
      while (performance.now() < startTime + startupPeriodMaxMs) {
        try {
          const serviceHealthResponse = await fetch(this.healthEndpointUrl)
          this.appLogger.info(`received response: ${serviceHealthResponse.status}`, this.name)
          if (serviceHealthResponse.status === 200) {
            const endTime = performance.now()
            this.appLogger.info(
              `${this.name} server startup complete after ${(endTime - startTime) / 1000} seconds`,
              this.name,
            )
            resolve(true)
            break
          }
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (e: unknown) {
          //fetch will simply fail while server not up
        }
        await new Promise<void>((resolve) => setTimeout(resolve, queryIntervalMs))
      }
      if (performance.now() >= startTime + startupPeriodMaxMs) {
        this.appLogger.warn(
          `Server ${this.name} did not return healthy response within ${startupPeriodMaxMs / 1000} seconds`,
          this.name,
        )
        resolve(false)
      }
    })

    const processStartupFailedDueToEarlyExit = didProcessExitEarlyTracker.then(
      (earlyExit) => !earlyExit,
    )

    return await Promise.race([processStartupFailedDueToEarlyExit, processStartupCompletePromise])
  }
}

export type XpuDevice = { id: number; name: string; arch: Arch }
const XpuSmiDiscoverySchema = z.object({
  device_list: z.array(
    z.object({
      device_id: z.number(),
      device_name: z.string(),
      device_type: z.string(),
      pci_bdf_address: z.string(),
      pci_device_id: z.string(),
      uuid: z.string(),
      vendor_name: z.string(),
    }),
  ),
})

export class DeviceService extends ExecutableService {
  constructor() {
    super('device-service', '')
    this.dir = path.resolve(path.join(this.baseDir, 'device-service'))
  }

  getExePath(): string {
    return path.resolve(path.join(this.dir, '/xpu-smi.exe'))
  }

  async run(_args: string[] = [], extraEnv?: object, workDir?: string): Promise<string> {
    const env = {
      ...extraEnv,
      ONEAPI_DEVICE_SELECTOR: 'level_zero:*',
    }
    return super.run(['discovery', '-j'], env, workDir)
  }

  async check(): Promise<void> {}

  async install(): Promise<void> {}

  async repair(_checkError: ServiceCheckError): Promise<void> {}

  private uuidToChipId(uuid: string): number {
    return parseInt(uuid.slice(-8, -4), 16)
  }

  async getDevices(): Promise<XpuDevice[]> {
    const result = await this.run()
    const devices: XpuDevice[] = XpuSmiDiscoverySchema.parse(JSON.parse(result)).device_list.map(
      (d) => {
        return {
          id: d.device_id,
          name: d.device_name,
          arch: getDeviceArch(this.uuidToChipId(d.uuid)),
        }
      },
    )
    devices.sort((a, b) => getArchPriority(b.arch) - getArchPriority(a.arch))
    return devices
  }
}
