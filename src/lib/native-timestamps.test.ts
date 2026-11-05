import { expect, it } from 'vitest'
import { timestampMilliseconds } from './native-timestamps'

it('converts the source-proven Hermes SQLite seconds boundary exactly once, preserving native milliseconds', () => {
  expect(timestampMilliseconds(1_700_000_000, 'seconds')).toBe(1_700_000_000_000)
  expect(timestampMilliseconds(1_700_000_000_000, 'milliseconds')).toBe(1_700_000_000_000)
  expect(timestampMilliseconds(null, 'seconds')).toBeNull()
  expect(timestampMilliseconds(Number.NaN, 'seconds')).toBeNull()
  expect(timestampMilliseconds(-1, 'seconds')).toBeNull()
})
