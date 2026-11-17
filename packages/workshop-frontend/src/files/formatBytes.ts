const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** A size for people: `512 B`, `1.5 MB`, `5 GB`. Decimal units, matching how the limits are stated. */
export const formatBytes = (bytes: number): string => {
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1
  return `${value.toFixed(digits).replace(/\.0$/, '')} ${UNITS[unit]}`
}
