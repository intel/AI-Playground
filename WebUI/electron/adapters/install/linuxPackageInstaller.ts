/**
 * Shared helpers for apt-based Linux package installation. Used by both
 * ComfyUI (Intel GPU / Level Zero) and OpenVINO system dependency setup.
 */
import { promisify } from 'util'
import { exec } from 'child_process'
import { spawn } from 'node:child_process'

const execAsync = promisify(exec)

export async function hasAptGet(): Promise<boolean> {
  try {
    await execAsync('command -v apt-get')
    return true
  } catch {
    return false
  }
}

export async function hasPkexec(): Promise<boolean> {
  try {
    await execAsync('command -v pkexec')
    return true
  } catch {
    return false
  }
}

export async function isAptPackageInstalled(packageName: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync("dpkg-query -W -f='${db:Status-Status}' " + packageName)
    return stdout.trim() === 'installed'
  } catch {
    return false
  }
}

export async function isAptPackageAvailable(packageName: string): Promise<boolean> {
  try {
    await execAsync(`apt-cache show ${packageName}`)
    return true
  } catch {
    return false
  }
}

export async function getMissingPackages(packages: string[]): Promise<string[]> {
  const installed = await Promise.all(packages.map((pkg) => isAptPackageInstalled(pkg)))
  return packages.filter((_, i) => !installed[i])
}

export function parseAptMissingPackages(output: string): string[] {
  const missing = new Set<string>()
  const unableRegex = /^E:\s+Unable to locate package\s+(.+)$/gm
  const noCandidateRegex = /^Package\s+(.+)\s+has no installation candidate$/gm
  let match: RegExpExecArray | null
  while ((match = unableRegex.exec(output)) !== null) {
    if (match[1]) missing.add(match[1].trim())
  }
  while ((match = noCandidateRegex.exec(output)) !== null) {
    if (match[1]) missing.add(match[1].trim())
  }
  return [...missing]
}

/**
 * Resolve the first available package from each alternatives set, plus any
 * unconditional packages, into a single install list.
 *
 * Example:
 *   alternativeSets = [['libze1', 'level-zero'], ['libze-intel-gpu1', 'intel-level-zero-gpu']]
 *   unconditional   = ['intel-opencl-icd']
 */
export async function resolvePackageList(
  alternativeSets: string[][],
  unconditional: string[] = [],
): Promise<string[]> {
  const resolved: string[] = [...unconditional]
  const picks = await Promise.all(
    alternativeSets.map(async (alternatives) => {
      const availability = await Promise.all(alternatives.map((pkg) => isAptPackageAvailable(pkg)))
      const idx = availability.findIndex(Boolean)
      return idx >= 0 ? alternatives[idx] : undefined
    }),
  )
  for (const pick of picks) {
    if (pick) resolved.push(pick)
  }
  return resolved
}

/**
 * Install packages via pkexec (graphical privilege escalation).
 * @param packages  Packages to pass to `apt-get install -y`.
 * @param preInstallScript  Optional bash snippet run (as root) before the install step
 *                          (e.g. to add an apt repository). Must be safe to re-run.
 */
export async function runPkexecInstall(
  packages: string[],
  preInstallScript?: string,
): Promise<{ success: boolean; output: string }> {
  const parts = ['export DEBIAN_FRONTEND=noninteractive']
  if (preInstallScript) parts.push(preInstallScript)
  parts.push(`apt-get install -y ${packages.join(' ')}`)
  const installCommand = parts.join('\n')

  return new Promise((resolve) => {
    const child = spawn('pkexec', ['bash', '-lc', installCommand], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', (err: Error) => {
      resolve({ success: false, output: `${stderr}\n${err.message}`.trim() })
    })
    child.on('exit', (code: number | null) => {
      resolve({ success: code === 0, output: `${stdout}\n${stderr}`.trim() })
    })
  })
}

/**
 * Fallback: open a terminal emulator and run the install there (uses sudo).
 * @param packages        Packages to install.
 * @param preInstallScript  Optional bash snippet prepended to the terminal command.
 */
export async function waitForTerminalInstall(
  packages: string[],
  preInstallScript?: string,
): Promise<boolean> {
  const parts: string[] = []
  if (preInstallScript) parts.push(preInstallScript)
  parts.push(`sudo apt-get install -y ${packages.join(' ')}`)
  const installCommand = parts.join('\n') + '\necho\nread -p "Press Enter to close..."'

  try {
    const child = spawn('x-terminal-emulator', ['-e', 'bash', '-lc', installCommand], {
      stdio: 'inherit',
    })
    await new Promise<void>((resolve) => {
      child.on('exit', resolve)
      child.on('error', resolve)
    })
    return true
  } catch {
    return false
  }
}
