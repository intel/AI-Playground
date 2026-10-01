import { describe, expect, it } from 'vitest'
import { usersModifyIcaclsArgs } from '../sharedAcl.ts'

describe('usersModifyIcaclsArgs', () => {
  it('grants inheritable modify so files created in the folder inherit it', () => {
    expect(usersModifyIcaclsArgs('C:\\shared')).toEqual([
      'C:\\shared',
      '/grant',
      '*S-1-5-32-545:(OI)(CI)M',
      '/T',
      '/C',
    ])
  })
})
