import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  net: {},
}))

const {
  buildLlmServerArgs,
  parseLlamaCppBuildNumber,
  sanitizeUserLlamaCppParameters,
  splitParameterString,
} = await import('../../subprocesses/llamaCppBackendService.ts')

// Parameters are written as one string (the settings box, and `llamaCppArgs` in
// the catalog), but some flags take a sentence — `--reasoning-budget-message`
// is what the model reads when its thinking is cut short.
describe('splitParameterString', () => {
  it('keeps a quoted sentence in one token and drops the quotes', () => {
    expect(
      splitParameterString('--reasoning-budget 2048 --reasoning-budget-message "Act now."'),
    ).toEqual(['--reasoning-budget', '2048', '--reasoning-budget-message', 'Act now.'])
  })

  it('handles single quotes and runs of whitespace', () => {
    expect(splitParameterString("  -fa  on   --msg 'two words'  ")).toEqual([
      '-fa',
      'on',
      '--msg',
      'two words',
    ])
  })

  it('keeps an explicitly empty value rather than swallowing it', () => {
    expect(splitParameterString('--msg ""')).toEqual(['--msg', ''])
  })
})

// An installed build only counts as installed if its version can be read back,
// and llama.cpp changed how it prints one around b10000.
describe('parseLlamaCppBuildNumber', () => {
  it('reads the build number out of the current format', () => {
    expect(
      parseLlamaCppBuildNumber(
        'version: 0.1.1-dev (build 10472, commit 60eeeb608)\n' +
          'built with AppleClang 21.0.0.21000101 for Darwin arm64\n',
      ),
    ).toBe('b10472')
  })

  it('still reads the format older installs print', () => {
    expect(
      parseLlamaCppBuildNumber(
        'version: 9590 (d2462f8f7)\nbuilt with AppleClang 21.0.0.21000099 for Darwin arm64\n',
      ),
    ).toBe('b9590')
  })

  it('reports nothing rather than a wrong version when it cannot tell', () => {
    expect(parseLlamaCppBuildNumber('llama-server: command not found')).toBeUndefined()
    expect(parseLlamaCppBuildNumber('')).toBeUndefined()
  })
})

// The flags a model asks for come from `models.json`, which the app also
// refreshes from a remote repo — so they are sanitized exactly like the user's,
// and they are placed where a hand-written flag can still override them.
describe('buildLlmServerArgs', () => {
  const base = {
    modelPath: '/models/qwen.gguf',
    port: 39100,
    contextSize: 32768,
    modelParameters: [] as string[],
    userParameters: [] as string[],
  }

  it('puts the model’s own flags before the user’s so the user wins', () => {
    const args = buildLlmServerArgs({
      ...base,
      modelParameters: ['--spec-default', '--spec-type', 'draft-mtp'],
      userParameters: ['--gpu-layers', '999', '--spec-type', 'none'],
    })
    expect(args.indexOf('draft-mtp')).toBeLessThan(args.lastIndexOf('--spec-type'))
    expect(args.at(-3)).toBe('none')
  })

  it('keeps the server on loopback whatever the flags say', () => {
    const args = buildLlmServerArgs({
      ...base,
      modelParameters: sanitizeUserLlamaCppParameters('--host 0.0.0.0 --spec-default'),
    })
    expect(args.filter((arg) => arg === '--host')).toHaveLength(1)
    expect(args.at(-1)).toBe('127.0.0.1')
    expect(args).toContain('--spec-default')
  })

  it('is the plain command line when no model asks for anything', () => {
    expect(buildLlmServerArgs({ ...base, userParameters: ['--jinja'] })).toEqual([
      '--model',
      '/models/qwen.gguf',
      '--port',
      '39100',
      '--ctx-size',
      '32768',
      '--jinja',
      '--host',
      '127.0.0.1',
    ])
  })
})
