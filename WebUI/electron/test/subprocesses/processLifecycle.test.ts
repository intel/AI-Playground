import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  killStaleProcesses,
  parsePosixSnapshot,
  parseWindowsSnapshot,
  spawnBackend,
  terminateProcessTree,
} from '../../subprocesses/processLifecycle'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}))

// Only `exec` is faked (the process-table snapshot); spawn stays real so the
// teardown tests below run against actual processes.
const scan = vi.hoisted(() => ({ table: '', commands: [] as string[] }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  type ExecCallback = (error: Error | null, result: { stdout: string; stderr: string }) => void
  return {
    ...actual,
    // `exec` is called both with and without an options argument.
    exec: (command: string, optionsOrCallback: unknown, maybeCallback?: unknown) => {
      const callback = (
        typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
      ) as ExecCallback
      scan.commands.push(command)
      callback(null, { stdout: scan.table, stderr: '' })
      return undefined
    },
  }
})

type LogCall = (message: string, source: string, alsoLogToFile?: boolean) => void

let logger: { info: Mock<LogCall>; warn: Mock<LogCall>; error: Mock<LogCall> }

beforeEach(() => {
  logger = { info: vi.fn<LogCall>(), warn: vi.fn<LogCall>(), error: vi.fn<LogCall>() }
})

afterEach(() => {
  vi.restoreAllMocks()
})

const onPosix = process.platform === 'win32' ? describe.skip : describe

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

// Below vitest's 5s per-test budget, so a regression fails on the assertion
// (naming the process that survived) instead of on a timeout.
const eventually = async (predicate: () => boolean, timeoutMs = 3000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return predicate()
}

onPosix('terminateProcessTree, with real processes', () => {
  it('reaps a grandchild, not just the direct child', async () => {
    // A shell that outlives a child of its own mirrors the real backends (uv ->
    // python, ovms -> its sub-servers): signalling the leader alone used to
    // leave the inner process orphaned onto init.
    const child = spawnBackend('sh', ['-c', 'sleep 60 & echo $!; wait'])

    const grandchildPid = await new Promise<number>((resolve, reject) => {
      child.stdout?.once('data', (data: Buffer) => resolve(Number.parseInt(data.toString(), 10)))
      child.once('error', reject)
      setTimeout(() => reject(new Error('the shell never reported its child pid')), 5000)
    })
    expect(Number.isInteger(grandchildPid)).toBe(true)
    expect(isAlive(grandchildPid)).toBe(true)

    await terminateProcessTree(child, { name: 'test', appLogger: logger })

    expect(await eventually(() => !isAlive(child.pid!))).toBe(true)
    expect(await eventually(() => !isAlive(grandchildPid))).toBe(true)
  })

  it('spawns a backend as its own process-group leader', () => {
    const child = spawnBackend('sh', ['-c', 'sleep 60'], { stdio: 'ignore' })
    try {
      expect(child.pid).toBeDefined()
      // Signal 0 only probes: a group with this id exists, which is true of a
      // leader and false for a child sharing our group.
      expect(() => process.kill(-child.pid!, 0)).not.toThrow()
    } finally {
      process.kill(-child.pid!, 'SIGKILL')
    }
  })
})

/** A child that reports its exit, enough to exercise the signalling paths. */
function fakeChild(pid: number): ChildProcess & { killCalls: (NodeJS.Signals | undefined)[] } {
  const child = new EventEmitter() as ChildProcess & {
    killCalls: (NodeJS.Signals | undefined)[]
  }
  return Object.assign(child, {
    pid,
    exitCode: null,
    signalCode: null,
    killCalls: [],
    kill(signal?: NodeJS.Signals) {
      child.killCalls.push(signal)
      setTimeout(() => child.emit('exit', null, signal), 0)
      return true
    },
  })
}

onPosix('terminateProcessTree, signalling', () => {
  it('falls back to the child alone when it leads no group', async () => {
    const child = fakeChild(4242)
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (typeof pid === 'number' && pid < 0) {
        const error = new Error('no such process') as NodeJS.ErrnoException
        error.code = 'ESRCH'
        throw error
      }
      return true
    })

    await terminateProcessTree(child, { name: 'test', appLogger: logger })

    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(child.killCalls).toEqual(['SIGTERM'])
    // A child that leads no group is expected, not worth warning about.
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

const VENV_PYTHON = '/opt/backend/.venv/bin/python'
const signatures = [[VENV_PYTHON, 'web_api.py']]

/** `ps -Awwo pid=,ppid=,command=` output. */
const posixTable = (rows: [pid: number, ppid: number, commandLine: string][]): string =>
  rows.map(([pid, ppid, commandLine]) => `${pid} ${ppid} ${commandLine}`).join('\n')

onPosix('killStaleProcesses', () => {
  beforeEach(() => {
    scan.table = ''
    scan.commands = []
  })

  it('kills each match by group and spares the pids we still own', async () => {
    scan.table = posixTable([
      [111, 1, `${VENV_PYTHON} web_api.py --port 59000`],
      [222, 1, `${VENV_PYTHON} web_api.py --port 59001`],
      [333, 1, `${VENV_PYTHON} web_api.py --port 59002`],
      [444, 1, '/usr/bin/python3 something_else.py'],
    ])
    const killed: number[] = []
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      killed.push(pid as number)
      return true
    })

    await killStaleProcesses([{ name: 'test', signatures }], {
      excludePids: [222],
      appLogger: logger,
    })

    expect(killed).toEqual([-111, -333])
  })

  it('leaves our own tooling alone when it runs the same interpreter', async () => {
    // The uv setup check and device detection run out of the very same venv;
    // killing one makes a healthy backend report itself as not installed.
    scan.table = posixTable([
      [111, 1, `${VENV_PYTHON} web_api.py --port 59000`],
      [222, 1, `${VENV_PYTHON} -c import sys; print(sys.version)`],
    ])
    const killed: number[] = []
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      killed.push(pid as number)
      return true
    })

    await killStaleProcesses([{ name: 'test', signatures }], { appLogger: logger })

    expect(killed).toEqual([-111])
  })

  it('never kills a process this app started, however deep', async () => {
    // 111 is a leftover from an earlier session; 222 is a server we launched
    // ourselves through an intermediate process (uv -> python).
    scan.table = posixTable([
      [111, 1, `${VENV_PYTHON} web_api.py --port 59000`],
      [222, 900, `${VENV_PYTHON} web_api.py --port 59001`],
      [900, process.pid, 'uv run web_api.py'],
    ])
    const killed: number[] = []
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      killed.push(pid as number)
      return true
    })

    await killStaleProcesses([{ name: 'test', signatures }], { appLogger: logger })

    expect(killed).toEqual([-111])
  })
})

describe('killStaleProcesses on Windows', () => {
  const realPlatform = process.platform

  beforeEach(() => {
    scan.commands = []
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  })

  it('matches a quoted executable, as spawned from the default install path', async () => {
    // Windows quotes argv[0] when the path contains a space, and the default
    // install directory is `…\AI Playground\…`, so the exe and the script are
    // not adjacent on the command line.
    const python = 'C:\\Program Files\\AI Playground\\service\\.venv\\Scripts\\python.exe'
    scan.table = JSON.stringify([
      { ProcessId: 900, ParentProcessId: 1, CommandLine: `"${python}" web_api.py --port 59000` },
    ])

    await killStaleProcesses([{ name: 'test', signatures: [[python, 'web_api.py']] }], {
      appLogger: logger,
    })

    expect(scan.commands).toContain('taskkill /PID 900 /T /F')
  })

  it('matches despite the case the process table reports', async () => {
    const python = 'C:\\AI Playground\\service\\.venv\\Scripts\\python.exe'
    scan.table = JSON.stringify([
      {
        ProcessId: 900,
        ParentProcessId: 1,
        CommandLine: `"${python.toUpperCase()}" WEB_API.PY --port 1`,
      },
    ])

    await killStaleProcesses([{ name: 'test', signatures: [[python, 'web_api.py']] }], {
      appLogger: logger,
    })

    expect(scan.commands).toContain('taskkill /PID 900 /T /F')
  })

  it('takes a single process-table snapshot however many backends are swept', async () => {
    scan.table = JSON.stringify([{ ProcessId: 900, ParentProcessId: 1, CommandLine: 'idle.exe' }])

    await killStaleProcesses(
      [
        { name: 'a', signatures: [['a.exe']] },
        { name: 'b', signatures: [['b.exe']] },
        { name: 'c', signatures: [['c.exe']] },
      ],
      { appLogger: logger },
    )

    expect(scan.commands.filter((c) => c.includes('Win32_Process'))).toHaveLength(1)
  })
})

describe('process-table parsing and matching', () => {
  it('reads a POSIX listing, command line and all', () => {
    const entries = parsePosixSnapshot('  501     1 /opt/x/.venv/bin/python web_api.py --port 1\n')
    expect(entries).toEqual([
      { pid: 501, ppid: 1, commandLine: '/opt/x/.venv/bin/python web_api.py --port 1' },
    ])
  })

  it('reads a Windows listing, including a null command line', () => {
    const entries = parseWindowsSnapshot(
      JSON.stringify([
        { ProcessId: 4, ParentProcessId: 0, CommandLine: null },
        { ProcessId: 900, ParentProcessId: 4, CommandLine: 'C:\\x\\python.exe web_api.py' },
      ]),
    )
    expect(entries).toEqual([
      { pid: 4, ppid: 0, commandLine: '' },
      { pid: 900, ppid: 4, commandLine: 'C:\\x\\python.exe web_api.py' },
    ])
  })

  it('accepts the bare object PowerShell emits for a single process', () => {
    const entries = parseWindowsSnapshot(
      JSON.stringify({ ProcessId: 900, ParentProcessId: 4, CommandLine: 'x.exe' }),
    )
    expect(entries).toEqual([{ pid: 900, ppid: 4, commandLine: 'x.exe' }])
  })
})
