import path from 'node:path'
import fsp from 'node:fs/promises'
import { nativeImage } from 'electron'
import type { IFileSystem } from 'just-bash'
import { Type } from 'typebox'
import type {
  BashOperations,
  EditOperations,
  FindOperations,
  LsOperations,
  ReadOperations,
  ToolDefinition,
  WriteOperations,
} from '@earendil-works/pi-coding-agent'
import { appLoggerInstance } from '../logging/logger.ts'
import { loadJustBash, loadPi, type JustBashModule, type PiModule } from './piRuntime.ts'
import type { AgentSkill } from './piCustomTools.ts'

// ── Agent Mode file/shell access ─────────────────────────────────────────────
//
// Pi's built-in tools (read, write, edit, bash, grep, find, ls) each accept
// pluggable `*Operations`, so the host decides what "the filesystem" and "the
// shell" mean without Pi knowing. Two modes:
//
//  - sandboxed (default): every operation is served by a just-bash sandbox
//    whose virtual filesystem mounts ONLY the user-selected workspace folder
//    (real files, read-write) at `/workspace`. The emulated shell has python3
//    and js-exec enabled but no host process ever spawns, so nothing outside
//    the workspace is reachable — by construction, not by path checking.
//
//  - host shell (opt-in per workspace, see the agentMode store): Pi's own local
//    operations run against the real filesystem and a real shell, so `node`,
//    `npm` and `python` work. Containment is then enforced here: file writes
//    and edits are rejected outside the workspace, and the shell is pinned to
//    the workspace as its working directory.
//
// Either way the model sees the same tools with the same schemas, and the
// workspace is the same real folder the user picked.

const logger = appLoggerInstance
const LOG_SOURCE = 'piToolOperations'

/** Mount point (and Pi's cwd) of the workspace inside the sandbox. */
export const SANDBOX_WORKDIR = '/workspace'

/**
 * Where the app's skills appear inside the sandbox. Pi advertises a skill by
 * telling the model to `read` its file, so the file has to exist in whatever
 * filesystem the read tool is backed by — the sandbox gets an in-memory copy
 * here rather than a mount of the host's userData directory.
 */
export const SANDBOX_SKILLS_DIR = '/skills'

/**
 * Sandbox HOME, deliberately outside the workspace mount so Pi's own
 * scaffolding stays in the in-memory filesystem instead of the user's folder.
 */
const SANDBOX_HOME = '/home/agent'

export type AgentToolAccess = {
  /** Pi tool definitions for the built-in file/shell tools. */
  definitions: ToolDefinition[]
  /** Pi's working directory: the sandbox mount point, or the real folder. */
  cwd: string
  /** Directory the model can read the app's skills from, in this mode. */
  skillsRoot: string
  /** Release sandbox resources. No-op in host-shell mode. */
  dispose: () => Promise<void>
}

export type AgentToolAccessOptions = {
  workspaceDir: string
  unsandboxed: boolean
  /** Host directory holding the written SKILL.md files. */
  skillsDir: string
  skills: AgentSkill[]
  /**
   * Builtin tools to keep, when a capability owns the session and says which
   * ones its workflow uses. The whole toolbox when absent.
   */
  baseTools?: string[]
  /**
   * Workspace-relative paths the file tools may write, for a capability whose
   * output is a fixed set of files. Any path when absent.
   */
  writableFiles?: string[]
}

function containedIn(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Reject a path that leaves `root`, so host-shell mode can't write anywhere. */
function assertContained(root: string, candidate: string, action: string): void {
  if (containedIn(root, path.resolve(candidate))) return
  throw new Error(
    `Refusing to ${action} outside the workspace folder: ${candidate}. ` +
      'All file operations must stay inside the workspace.',
  )
}

/**
 * Reject a write to a file a one-file session was never meant to produce.
 *
 * `relativePath` is already workspace-relative and POSIX-separated. The refusal
 * is written for the model to act on rather than to give up on: it is the only
 * thing standing between "put the whole game in `index.html`" as an instruction
 * and a small model that writes `index.html` plus a `game.js` anyway — which
 * leaves a game whose code never loads, and a hand-off summary that promises the
 * next agent one file.
 */
function assertWritableFile(relativePath: string, writableFiles: string[], action: string): void {
  const allowed = writableFiles.map((file) => file.split('\\').join('/').replace(/^\.\//, ''))
  if (allowed.includes(relativePath)) return
  const list = allowed.map((file) => `\`${file}\``).join(', ')
  throw new Error(
    `Refusing to ${action} ${relativePath}: this session writes ${list} and nothing else. ` +
      `Put the whole thing in ${allowed.length === 1 ? allowed[0] : 'those files'} instead — ` +
      'a second file is not loaded and the work in it is lost.',
  )
}

/**
 * Undo the host resolver's rewriting of a sandbox path.
 *
 * Pi resolves every path a tool is called with through `node:path` before
 * handing it to these operations. On Windows that is the win32 resolver, which
 * turns the POSIX sandbox path `/workspace/index.html` into
 * `C:\workspace\index.html` — a drive letter the virtual filesystem has never
 * heard of and separators it does not split on, so every read, write, list and
 * search misses. Stripping the drive and restoring `/` puts the path back in
 * the namespace the mounts are keyed by. On a POSIX host nothing is rewritten
 * and the path arrives here unchanged.
 */
function toSandboxPath(candidate: string): string {
  return candidate
    .replace(/^[A-Za-z]:/, '')
    .split('\\')
    .join('/')
}

/**
 * Same check for sandbox paths, which are always POSIX-style regardless of the
 * host platform (on Windows `path.relative` would mangle them).
 */
function assertInsideSandboxWorkspace(candidate: string, action: string): void {
  const resolved = path.posix.resolve(SANDBOX_WORKDIR, candidate)
  const relative = path.posix.relative(SANDBOX_WORKDIR, resolved)
  if (relative === '' || (!relative.startsWith('..') && !path.posix.isAbsolute(relative))) return
  // Without this the write would land in the sandbox's throwaway in-memory root
  // instead of the mounted workspace, and the model would be told it succeeded.
  throw new Error(
    `Refusing to ${action} outside the workspace: ${candidate}. Everything must stay under ` +
      `${SANDBOX_WORKDIR}, which is the workspace folder.`,
  )
}

// ── Sandboxed mode ──────────────────────────────────────────────────────────

/**
 * Restate a host filesystem refusal in terms the model can act on.
 *
 * The virtual filesystem reports these with the mount-relative path — a write
 * to `/workspace/index.html` that the operating system refuses comes back as
 * `EPERM: write '/index.html'`. That reads like a bad argument, so the model
 * "fixes" the path and writes somewhere else entirely instead of reporting that
 * the folder is unusable. macOS produces exactly this for folders under
 * Documents, Desktop and Downloads.
 */
async function reportingHostDenials<T>(
  action: string,
  sandboxPath: string,
  workspaceDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const denial = /^(EPERM|EACCES|EROFS)\b/.exec(message)
    if (!denial) throw error
    throw new Error(
      `Cannot ${action} ${sandboxPath}: the operating system denied access to the workspace ` +
        `folder on disk (${denial[1]}). The path is correct, so retrying with a different one ` +
        `will not help. Report this to the user: the app needs permission for ${workspaceDir}, ` +
        'or they should pick a workspace folder outside a protected location (on macOS the ' +
        'Documents, Desktop and Downloads folders are protected).',
    )
  }
}

/**
 * Name the image format a file holds, from its leading bytes.
 *
 * Pi's `read` gives the model an image as an attachment it can actually look at,
 * but only if the operations it was handed can recognize one — otherwise the
 * bytes are decoded as UTF-8 and arrive as mojibake. Pi's own sniffer ships
 * with its read tool's default operations, which the sandbox replaces, and is
 * not exported, so this covers the formats that tool documents. Being too
 * generous is harmless: Pi re-validates the image and falls back to a text note.
 */
function imageMimeType(buffer: Buffer): string | null {
  const ascii = (offset: number, text: string): boolean =>
    buffer.length >= offset + text.length &&
    buffer.toString('latin1', offset, offset + text.length) === text

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (ascii(0, '\x89PNG\r\n\x1a\n')) return 'image/png'
  if (ascii(0, 'GIF')) return 'image/gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  if (ascii(0, 'BM')) return 'image/bmp'
  return null
}

/** Longest edge, in pixels, an image is scaled down to before the model sees it. */
const MAX_IMAGE_EDGE = 1024

/** What the read tool should do with a file's bytes. */
type ReadableImage =
  | { kind: 'image'; bytes: Buffer; mimeType: string }
  /** An image no one downstream can read; say so instead of shipping it. */
  | { kind: 'undecodable'; mimeType: string }
  /** Not an image: read it as text, as always. */
  | { kind: 'other' }

/** Stands in for an image the model cannot be shown, in Pi's own wording. */
function undecodableNote(mimeType: string): Buffer {
  return Buffer.from(
    `[Image omitted: this ${mimeType} file could not be decoded, so it cannot be shown to ` +
      'the model. Ask the user to re-save it as a plain PNG or JPEG.]',
  )
}

/**
 * Decide how a file's bytes reach the model.
 *
 * Pi caps image size itself, but its resizer runs Photon (WASM) in a worker
 * thread that cannot be loaded from the bundled main process. It fails, Pi
 * replaces the picture with "[Image omitted: could not be resized below the
 * inline image size limit.]", and an attached sprite silently never reaches the
 * model — which then guesses at what it was asked to look at. Electron decodes
 * images anyway, so the cap is applied here and Pi is told (`autoResizeImages:
 * false`) to inline whatever these operations return.
 *
 * Re-encoding is not only about size. Inference servers decode images with
 * minimal decoders, and llama.cpp answers an exotic PNG with a 400 that fails
 * the entire turn, so anything Electron can read is handed on as a plain PNG.
 * JPEG passes through untouched unless it had to shrink, since re-encoding a
 * photo only costs quality.
 *
 * Some images (1-bit and palette PNGs among them) defeat Electron's decoder as
 * well. Those are the ones llama.cpp would reject, so they are reported as
 * undecodable rather than forwarded — a note the model can talk about beats a
 * dead turn.
 */
function imageForModel(buffer: Buffer): ReadableImage {
  const mimeType = imageMimeType(buffer)
  if (!mimeType) return { kind: 'other' }

  const decoded = nativeImage.createFromBuffer(buffer)
  if (decoded.isEmpty()) return { kind: 'undecodable', mimeType }

  const { width, height } = decoded.getSize()
  const oversized = Math.max(width, height) > MAX_IMAGE_EDGE
  const image = oversized
    ? decoded.resize(width >= height ? { width: MAX_IMAGE_EDGE } : { height: MAX_IMAGE_EDGE })
    : decoded

  if (mimeType === 'image/jpeg') {
    return { kind: 'image', bytes: oversized ? image.toJPEG(85) : buffer, mimeType }
  }
  return { kind: 'image', bytes: image.toPNG(), mimeType: 'image/png' }
}

/**
 * Wrap a plain byte read so images arrive model-ready. Only the `read` tool
 * gets this: `edit` reads to write the result back, and must stay byte-exact.
 */
function imageAwareReadOperations(
  readFile: (absolutePath: string) => Promise<Buffer>,
  access: (absolutePath: string) => Promise<void>,
): ReadOperations {
  return {
    readFile: async (absolutePath) => {
      const raw = await readFile(absolutePath)
      const image = imageForModel(raw)
      if (image.kind === 'image') return image.bytes
      // Pi reads anything without an image MIME type as UTF-8 text, which is
      // the only way to get a note in front of the model from out here.
      if (image.kind === 'undecodable') return undecodableNote(image.mimeType)
      return raw
    },
    access,
    detectImageMimeType: async (absolutePath) => {
      const image = imageForModel(await readFile(absolutePath))
      return image.kind === 'image' ? image.mimeType : null
    },
  }
}

/**
 * Operations backed by the sandbox's virtual filesystem. Pi hands these
 * absolute sandbox paths (rooted at SANDBOX_WORKDIR), which is exactly the
 * namespace the MountableFs understands, so no translation is needed.
 */
function sandboxFsOperations(vfs: IFileSystem, workspaceDir: string, writableFiles?: string[]) {
  /** Guard a sandbox write against the session's fixed file list, if it has one. */
  const assertWritable = (absolutePath: string, action: string): void => {
    if (!writableFiles) return
    assertWritableFile(path.posix.relative(SANDBOX_WORKDIR, absolutePath), writableFiles, action)
  }

  const readFile = async (hostPath: string): Promise<Buffer> => {
    const absolutePath = toSandboxPath(hostPath)
    return await reportingHostDenials('read', absolutePath, workspaceDir, async () =>
      Buffer.from(await vfs.readFileBuffer(absolutePath)),
    )
  }

  const read: ReadOperations = imageAwareReadOperations(readFile, async (hostPath) => {
    const absolutePath = toSandboxPath(hostPath)
    if (!(await vfs.exists(absolutePath))) {
      throw new Error(`File not found: ${absolutePath}`)
    }
  })

  const write: WriteOperations = {
    writeFile: async (hostPath, content) => {
      const absolutePath = toSandboxPath(hostPath)
      assertInsideSandboxWorkspace(absolutePath, 'write')
      assertWritable(absolutePath, 'write')
      await reportingHostDenials('write', absolutePath, workspaceDir, async () => {
        await vfs.mkdir(path.posix.dirname(absolutePath), { recursive: true })
        await vfs.writeFile(absolutePath, content)
      })
    },
    mkdir: async (hostPath) => {
      const dir = toSandboxPath(hostPath)
      assertInsideSandboxWorkspace(dir, 'create a directory')
      await reportingHostDenials('create a directory at', dir, workspaceDir, async () => {
        await vfs.mkdir(dir, { recursive: true })
      })
    },
  }

  const edit: EditOperations = {
    // The raw read, not the read tool's: an edit writes back what it reads.
    readFile,
    writeFile: async (hostPath, content) => {
      const absolutePath = toSandboxPath(hostPath)
      assertInsideSandboxWorkspace(absolutePath, 'edit')
      assertWritable(absolutePath, 'edit')
      await reportingHostDenials('edit', absolutePath, workspaceDir, async () => {
        await vfs.writeFile(absolutePath, content)
      })
    },
    access: read.access,
  }

  const ls: LsOperations = {
    exists: (hostPath) => vfs.exists(toSandboxPath(hostPath)),
    stat: async (hostPath) => {
      const stat = await vfs.stat(toSandboxPath(hostPath))
      return { isDirectory: () => stat.isDirectory }
    },
    readdir: (hostPath) => vfs.readdir(toSandboxPath(hostPath)),
  }

  // The sandbox has no `fd`, so globbing walks the virtual filesystem itself.
  const find: FindOperations = {
    exists: (hostPath) => vfs.exists(toSandboxPath(hostPath)),
    glob: async (pattern, hostCwd, options) => {
      const matcher = globToRegExp(pattern)
      const cwd = toSandboxPath(hostCwd)
      const root = cwd.endsWith('/') ? cwd : `${cwd}/`
      const matches: string[] = []
      for (const candidate of vfs.getAllPaths()) {
        if (!candidate.startsWith(root)) continue
        const relative = candidate.slice(root.length)
        if (!matcher.test(relative)) continue
        if (options.ignore.some((ignored) => globToRegExp(ignored).test(relative))) continue
        matches.push(relative)
        if (matches.length >= options.limit) break
      }
      return matches
    },
  }

  return { read, write, edit, find, ls }
}

/** Cap on grep hits, mirroring the order of magnitude of Pi's own grep tool. */
const SANDBOX_GREP_LIMIT = 100

const sandboxGrepSchema = Type.Object({
  pattern: Type.String({ description: 'Regular expression to search for.' }),
  path: Type.Optional(
    Type.String({ description: `File or directory to search. Defaults to ${SANDBOX_WORKDIR}.` }),
  ),
  glob: Type.Optional(
    Type.String({ description: "Only search files matching this glob, e.g. '**/*.ts'." }),
  ),
  ignoreCase: Type.Optional(Type.Boolean({ description: 'Case-insensitive search.' })),
  literal: Type.Optional(
    Type.Boolean({ description: 'Treat the pattern as literal text instead of a regex.' }),
  ),
  limit: Type.Optional(
    Type.Number({ description: `Maximum number of matches (default ${SANDBOX_GREP_LIMIT}).` }),
  ),
})

/**
 * A grep tool that searches the sandbox's virtual filesystem.
 *
 * Pi's own grep tool always shells out to ripgrep against the REAL filesystem —
 * its `operations` only supply context lines — so in sandboxed mode it would
 * both fail on the virtual workspace path and be able to read host files. This
 * replacement walks the mounted workspace instead, which is the only thing the
 * sandbox is allowed to see.
 */
function createSandboxGrepTool(pi: PiModule, vfs: IFileSystem): ToolDefinition {
  return pi.defineTool({
    name: 'grep',
    label: 'grep',
    description:
      'Search file contents for a pattern. Returns matching lines with file paths and line ' +
      'numbers. Searches the workspace only.',
    promptSnippet: 'Search file contents by regex',
    parameters: sandboxGrepSchema,
    execute: async (_toolCallId, params) => {
      const searchRoot = path.posix.resolve(
        SANDBOX_WORKDIR,
        toSandboxPath(params.path ?? SANDBOX_WORKDIR),
      )
      assertInsideSandboxWorkspace(searchRoot, 'search')
      const limit = params.limit ?? SANDBOX_GREP_LIMIT
      const expression = new RegExp(
        params.literal ? params.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : params.pattern,
        params.ignoreCase ? 'i' : '',
      )
      const globMatcher = params.glob ? globToRegExp(params.glob) : null

      const prefix = searchRoot.endsWith('/') ? searchRoot : `${searchRoot}/`
      const candidates = (await vfs.exists(searchRoot))
        ? (await vfs.stat(searchRoot)).isDirectory
          ? vfs.getAllPaths().filter((candidate) => candidate.startsWith(prefix))
          : [searchRoot]
        : []

      const lines: string[] = []
      let truncated = false
      for (const filePath of candidates) {
        if (globMatcher && !globMatcher.test(filePath.slice(prefix.length))) continue
        let content: string
        try {
          if ((await vfs.stat(filePath)).isDirectory) continue
          content = await vfs.readFile(filePath)
        } catch {
          continue
        }
        const relative = path.posix.relative(SANDBOX_WORKDIR, filePath) || filePath
        for (const [index, line] of content.split('\n').entries()) {
          if (!expression.test(line)) continue
          if (lines.length >= limit) {
            truncated = true
            break
          }
          lines.push(`${relative}:${index + 1}:${line}`)
        }
        if (truncated) break
      }

      const text = lines.length
        ? `${lines.join('\n')}${truncated ? `\n… truncated at ${limit} matches` : ''}`
        : 'No matches found.'
      return { content: [{ type: 'text', text }], details: undefined }
    },
  }) as ToolDefinition
}

/**
 * Translate a glob pattern to a RegExp: `**` spans separators, `*` and `?` stop
 * at them. Enough for the find tool's patterns without pulling in a glob lib
 * that would want a real filesystem.
 */
function globToRegExp(pattern: string): RegExp {
  let expression = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        // `**/` should also match zero directories.
        if (pattern[index + 2] === '/') {
          expression += '(?:.*/)?'
          index += 2
        } else {
          expression += '.*'
          index += 1
        }
      } else {
        expression += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      expression += '[^/]'
      continue
    }
    expression += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${expression}$`)
}

function createSandboxAccess(
  pi: PiModule,
  justBash: JustBashModule,
  options: AgentToolAccessOptions,
): AgentToolAccess {
  const { workspaceDir, skills } = options
  const vfs = new justBash.MountableFs()
  vfs.mount(SANDBOX_WORKDIR, new justBash.ReadWriteFs({ root: workspaceDir }))
  vfs.mount(
    SANDBOX_SKILLS_DIR,
    new justBash.InMemoryFs(Object.fromEntries(skills.map((s) => [s.relativePath, s.content]))),
  )
  const bashEnv = new justBash.Bash({
    fs: vfs,
    cwd: SANDBOX_WORKDIR,
    env: { HOME: SANDBOX_HOME, PWD: SANDBOX_WORKDIR },
    // Interpreters the model can actually use for scripting inside the sandbox.
    // There is deliberately no network and no node/npm here — that is what
    // host-shell mode is for.
    python: true,
    javascript: true,
    // just-bash's secondary hardening layer patches Module._load while a script
    // runs; the Electron main bundle is CJS with externalized dependencies, so
    // lazy require() calls inside the execution context (ReadWriteFs reaching
    // node:fs) trip it. The real isolation here is the ReadWriteFs root.
    defenseInDepth: false,
  })

  const operations = sandboxFsOperations(vfs, workspaceDir, options.writableFiles)
  const bash: BashOperations = {
    // just-bash resolves the whole script in-process and returns its output at
    // once, so there is a single onData call rather than incremental streaming.
    exec: async (command, cwd, { onData, signal, env }) => {
      const result = await bashEnv.exec(command, {
        cwd: toSandboxPath(cwd),
        ...(env ? { env: env as Record<string, string> } : {}),
        ...(signal ? { signal } : {}),
      })
      const output = `${result.stdout}${result.stderr}`
      if (output) onData(Buffer.from(output))
      return { exitCode: result.exitCode }
    },
  }

  return {
    cwd: SANDBOX_WORKDIR,
    skillsRoot: SANDBOX_SKILLS_DIR,
    definitions: [
      pi.createReadToolDefinition(SANDBOX_WORKDIR, {
        operations: operations.read,
        autoResizeImages: false,
      }),
      pi.createWriteToolDefinition(SANDBOX_WORKDIR, { operations: operations.write }),
      pi.createEditToolDefinition(SANDBOX_WORKDIR, { operations: operations.edit }),
      pi.createBashToolDefinition(SANDBOX_WORKDIR, { operations: bash }),
      createSandboxGrepTool(pi, vfs),
      pi.createFindToolDefinition(SANDBOX_WORKDIR, { operations: operations.find }),
      pi.createLsToolDefinition(SANDBOX_WORKDIR, { operations: operations.ls }),
    ] as ToolDefinition[],
    dispose: async () => {},
  }
}

// ── Host-shell mode ─────────────────────────────────────────────────────────

/**
 * Pi's own local operations, but with writes and edits confined to the
 * workspace and the shell pinned to it. Reads are left unrestricted on purpose:
 * a coding agent legitimately reads system headers, installed packages and
 * toolchain files, and read access is what the user already granted the app.
 */
function createHostShellAccess(pi: PiModule, options: AgentToolAccessOptions): AgentToolAccess {
  const { workspaceDir } = options
  return {
    cwd: workspaceDir,
    skillsRoot: options.skillsDir,
    definitions: [
      pi.createReadToolDefinition(workspaceDir, {
        operations: hostReadOperations(workspaceDir),
        autoResizeImages: false,
      }),
      pi.createWriteToolDefinition(workspaceDir, {
        operations: guardedWriteOperations(workspaceDir, options.writableFiles),
      }),
      pi.createEditToolDefinition(workspaceDir, {
        operations: guardedEditOperations(workspaceDir, options.writableFiles),
      }),
      pi.createBashToolDefinition(workspaceDir, {
        // Every command starts in the workspace, whatever cwd Pi passes.
        spawnHook: (context) => ({ ...context, cwd: workspaceDir }),
      }),
      pi.createGrepToolDefinition(workspaceDir),
      pi.createFindToolDefinition(workspaceDir),
      pi.createLsToolDefinition(workspaceDir),
    ] as ToolDefinition[],
    dispose: async () => {},
  }
}

/**
 * Pi's local read, kept unrestricted (see createHostShellAccess) but routed
 * through the same image handling the sandbox uses.
 */
function hostReadOperations(workspaceDir: string): ReadOperations {
  const readFile = async (absolutePath: string): Promise<Buffer> =>
    await reportingHostDenials(
      'read',
      absolutePath,
      workspaceDir,
      async () => await fsp.readFile(absolutePath),
    )
  return imageAwareReadOperations(readFile, async (absolutePath) => {
    await fsp.access(absolutePath)
  })
}

function guardedWriteOperations(workspaceDir: string, writableFiles?: string[]): WriteOperations {
  return {
    writeFile: async (absolutePath, content) => {
      assertContained(workspaceDir, absolutePath, 'write')
      assertHostWritable(workspaceDir, absolutePath, writableFiles, 'write')
      await reportingHostDenials('write', absolutePath, workspaceDir, async () => {
        await fsp.mkdir(path.dirname(absolutePath), { recursive: true })
        await fsp.writeFile(absolutePath, content, 'utf8')
      })
    },
    mkdir: async (dir) => {
      assertContained(workspaceDir, dir, 'create a directory')
      await reportingHostDenials('create a directory at', dir, workspaceDir, async () => {
        await fsp.mkdir(dir, { recursive: true })
      })
    },
  }
}

/** Host-path form of {@link assertWritableFile}; a no-op for an open session. */
function assertHostWritable(
  workspaceDir: string,
  absolutePath: string,
  writableFiles: string[] | undefined,
  action: string,
): void {
  if (!writableFiles) return
  const relative = path.relative(workspaceDir, path.resolve(absolutePath)).split('\\').join('/')
  assertWritableFile(relative, writableFiles, action)
}

function guardedEditOperations(workspaceDir: string, writableFiles?: string[]): EditOperations {
  return {
    readFile: async (absolutePath) =>
      await reportingHostDenials(
        'read',
        absolutePath,
        workspaceDir,
        async () => await fsp.readFile(absolutePath),
      ),
    writeFile: async (absolutePath, content) => {
      assertContained(workspaceDir, absolutePath, 'edit')
      assertHostWritable(workspaceDir, absolutePath, writableFiles, 'edit')
      await reportingHostDenials('edit', absolutePath, workspaceDir, async () => {
        await fsp.writeFile(absolutePath, content, 'utf8')
      })
    },
    access: async (absolutePath) => {
      assertContained(workspaceDir, absolutePath, 'edit')
      await fsp.access(absolutePath)
    },
  }
}

/**
 * Build the file/shell tools for a turn. `unsandboxed` comes from the explicit
 * per-workspace consent the user gave in Agent Settings.
 */
export async function createAgentToolAccess(
  options: AgentToolAccessOptions,
): Promise<AgentToolAccess> {
  const pi = await loadPi()
  const access = options.unsandboxed
    ? createHostShellAccess(pi, options)
    : createSandboxAccess(pi, await loadJustBash(), options)
  const definitions = keepTools(access.definitions, options.baseTools)
  logger.info(
    `agent tools: ${options.unsandboxed ? 'HOST SHELL' : 'sandboxed'} mode in ` +
      `${options.workspaceDir} (${definitions.map((tool) => tool.name).join(', ')})`,
    LOG_SOURCE,
  )
  return { ...access, definitions }
}

/**
 * Cut the toolbox down to what a session uses. Every tool costs its schema in
 * the prompt and invites the step that calls it, so a run that is one `write`
 * long is better off not being offered a shell, a search and an editor.
 */
function keepTools(definitions: ToolDefinition[], keep?: string[]): ToolDefinition[] {
  if (!keep) return definitions
  const wanted = new Set(keep)
  return definitions.filter((definition) => wanted.has(definition.name))
}

export const testables = {
  globToRegExp,
  containedIn,
  assertContained,
  assertInsideSandboxWorkspace,
  assertWritableFile,
  reportingHostDenials,
  toSandboxPath,
  imageForModel,
  MAX_IMAGE_EDGE,
}
