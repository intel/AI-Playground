import { describe, expect, it } from 'vitest'
import { formatHumanSize, parseHumanSize, sumHumanSizes } from './humanSize'

describe('parseHumanSize', () => {
  it('reads the shapes the download API produces', () => {
    expect(parseHumanSize('3.20G')).toBe(3.2 * 1024 ** 3)
    expect(parseHumanSize('512')).toBe(512)
    expect(parseHumanSize('715B')).toBe(715)
    expect(parseHumanSize('35.00M')).toBe(35 * 1024 ** 2)
    // The renderer's own formatter writes "GB"; accept it so the two agree.
    expect(parseHumanSize('2.0 GB')).toBe(2 * 1024 ** 3)
  })

  it('refuses anything else', () => {
    // "???" is what the dialog shows while sizes are still being fetched.
    expect(parseHumanSize('???')).toBeUndefined()
    expect(parseHumanSize('')).toBeUndefined()
    expect(parseHumanSize('unknown')).toBeUndefined()
  })
})

describe('sumHumanSizes', () => {
  it('totals what it can parse', () => {
    expect(sumHumanSizes(['1.00G', '512.00M', '512.00M'])).toBe('2.00G')
  })

  it('ignores unparseable entries but still totals the rest', () => {
    // A batch where one size failed to load is still worth summarising.
    expect(sumHumanSizes(['1.00G', '???'])).toBe('1.00G')
  })

  it('gives no total when nothing could be parsed', () => {
    // Better silent than a confident "0B" while every size is still loading.
    expect(sumHumanSizes(['???', ''])).toBeUndefined()
  })
})

describe('formatHumanSize', () => {
  it('matches the units the API uses', () => {
    expect(formatHumanSize(0)).toBe('0B')
    expect(formatHumanSize(1024)).toBe('1.00K')
    expect(formatHumanSize(3.2 * 1024 ** 3)).toBe('3.20G')
  })
})
