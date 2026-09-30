import { describe, expect, it } from 'vitest'
import { withSharedUvLinkMode } from '../../subprocesses/uvBasedBackends/uvLinkMode.ts'

describe('withSharedUvLinkMode', () => {
  it('forces copy on a shared install, after any caller link mode', () => {
    expect(withSharedUvLinkMode({ UV_LINK_MODE: 'hardlink', UV_NO_CONFIG: '1' }, true)).toEqual({
      UV_LINK_MODE: 'copy',
      UV_NO_CONFIG: '1',
    })
  })

  it('leaves a per-user install on the caller link mode', () => {
    expect(withSharedUvLinkMode({ UV_LINK_MODE: 'clone' }, false)).toEqual({
      UV_LINK_MODE: 'clone',
    })
  })
})
