/**
 * Make a tool return value lossless JSON. Tool outputs are validated by the
 * harness, so `undefined`, NaN, Infinity, BigInt, Buffer, and Date must not
 * leak into a value that the model or UI receives.
 * @param {unknown} value arbitrary tool value
 * @param {WeakSet<object>} [seen] cycle guard
 * @returns {unknown} JSON-safe clone
 */
export function jsonSafe(value, seen = new WeakSet()) {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') {
    const number = Number(value)
    return Number.isSafeInteger(number) ? number : value.toString()
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return undefined
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    if (Array.isArray(value)) {
      const array = value.map((item) => {
        const safe = jsonSafe(item, seen)
        return safe === undefined ? null : safe
      })
      seen.delete(value)
      return array
    }
    const output = {}
    for (const [key, item] of Object.entries(value)) {
      const safe = jsonSafe(item, seen)
      if (safe !== undefined) output[key] = safe
    }
    seen.delete(value)
    return output
  }
  return undefined
}
