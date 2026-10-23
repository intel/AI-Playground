import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  net: {},
}))

const {
  LLAMACPP_CPU_DEVICE_ID,
  LLAMACPP_DEFAULT_PARAMETERS,
  splitParameterString,
  withCpuDevice,
  withCpuDeviceParameters,
} = await import('../../../adapters/backends/llamaCppBackendService.ts')

// llama-server only lists accelerators, so the CPU has to be offered by the app
// itself — that option is what lets a user route inference to the CPU.
describe('withCpuDevice', () => {
  it('offers the CPU next to the detected GPUs', () => {
    expect(withCpuDevice([{ id: '0', name: 'Intel Arc B580' }])).toEqual([
      { id: '0', name: 'Intel Arc B580' },
      { id: LLAMACPP_CPU_DEVICE_ID, name: 'CPU' },
    ])
  })

  it('gives a CPU the build lists itself the stable id', () => {
    expect(
      withCpuDevice([
        { id: '0', name: 'Intel Arc B580' },
        { id: 'CPU0', name: 'CPU' },
      ]),
    ).toEqual([
      { id: '0', name: 'Intel Arc B580' },
      { id: LLAMACPP_CPU_DEVICE_ID, name: 'CPU' },
    ])
  })

  it('keeps the auto fallback ahead of the CPU when nothing was detected', () => {
    expect(withCpuDevice([])).toEqual([
      { id: '0', name: 'Auto select device' },
      { id: LLAMACPP_CPU_DEVICE_ID, name: 'CPU' },
    ])
  })
})

// `--gpu-layers 0` is llama.cpp's "run on the CPU", and it replaces the full
// offload in the default parameter string rather than stacking a second flag.
describe('withCpuDeviceParameters', () => {
  const cpu = { id: LLAMACPP_CPU_DEVICE_ID, name: 'CPU' }
  const gpu = { id: '0', name: 'Intel Arc B580' }

  it('replaces the default full offload with zero layers', () => {
    expect(withCpuDeviceParameters(splitParameterString(LLAMACPP_DEFAULT_PARAMETERS), cpu)).toEqual(
      [
        '--log-prefix',
        '--jinja',
        '--no-mmap',
        '-fa',
        'on',
        '--cache-ram',
        '16384',
        '--gpu-layers',
        '0',
      ],
    )
  })

  it('removes every spelling of the offload flag', () => {
    expect(
      withCpuDeviceParameters(
        ['--gpu-layers', '999', '-ngl', '20', '--n-gpu-layers=12', '--gpu-layers=7', '--jinja'],
        cpu,
      ),
    ).toEqual(['--jinja', '--gpu-layers', '0'])
  })

  it('recognises a CPU the build lists under its own id', () => {
    expect(withCpuDeviceParameters(['--gpu-layers', '999'], { id: 'CPU0', name: 'CPU' })).toEqual([
      '--gpu-layers',
      '0',
    ])
  })

  it('leaves the parameters alone for a GPU device or no selection', () => {
    expect(withCpuDeviceParameters(['--gpu-layers', '999'], gpu)).toEqual(['--gpu-layers', '999'])
    expect(withCpuDeviceParameters(['--gpu-layers', '999'], undefined)).toEqual([
      '--gpu-layers',
      '999',
    ])
  })
})
