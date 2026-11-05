/** Convert only at a source-declared boundary; never guess units from magnitude. */
export function timestampMilliseconds(value: unknown, unit: 'seconds' | 'milliseconds'): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return unit === 'seconds' ? value * 1000 : value
}
