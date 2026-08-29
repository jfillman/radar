import { describe, expect, it } from 'vitest'
import { isMinorOrMajorUpdate, parseMajorMinor } from './version'

describe('Radar version helpers', () => {
  it('parses major and minor versions with an optional v prefix', () => {
    expect(parseMajorMinor('v1.12.3')).toEqual({ major: 1, minor: 12 })
    expect(parseMajorMinor('dev')).toBeNull()
  })

  it('distinguishes patch updates from minor and major updates', () => {
    expect(isMinorOrMajorUpdate('1.2.3', '1.2.4')).toBe(false)
    expect(isMinorOrMajorUpdate('1.2.3', '1.3.0')).toBe(true)
    expect(isMinorOrMajorUpdate('1.2.3', '2.0.0')).toBe(true)
  })
})
