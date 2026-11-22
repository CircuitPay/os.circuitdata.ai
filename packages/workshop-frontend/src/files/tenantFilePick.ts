/** The most files a gatekeeper app is handed from one pick. */
export const MAX_PICKED_FILES = 10

const MAX_ACCEPT_ENTRIES = 20
const MAX_ACCEPT_ENTRY_LENGTH = 100
const MAX_TARGET_DEPTH = 8
const MAX_TARGET_TEXT_LENGTH = 1_000

/** What a gatekeeper app may ask the member to pick. */
export type TenantFilePickRequest = {
  /** Extensions (".csv") and MIME types ("text/csv", "text/*") a file must match; empty accepts any. */
  accept: string[]
  /** Whether several files, up to MAX_PICKED_FILES, may be chosen. */
  multiple: boolean
}

const invalid = () => new TypeError('Invalid tenant file pick request.')

// The target travels from the untrusted frame to the gatekeeper untouched, so only plain data is
// relayed: never a stub or a function the frame could have smuggled into the host's backend session.
const isPlainData = (value: unknown, depth: number): boolean => {
  if (depth > MAX_TARGET_DEPTH) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.length <= MAX_TARGET_TEXT_LENGTH
  if (Array.isArray(value)) return value.every(item => isPlainData(item, depth + 1))
  if (typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(value).every(item => isPlainData(item, depth + 1))
}

const isAcceptEntry = (entry: unknown): entry is string =>
  typeof entry === 'string' &&
  entry.length > 0 &&
  entry.length <= MAX_ACCEPT_ENTRY_LENGTH &&
  (entry.startsWith('.') || entry.includes('/'))

/**
 * Validates a pick request arriving from a sandboxed gatekeeper app before the host opens the picker.
 * The app is untrusted input, so the shape is checked here.
 */
export const parseTenantFilePickRequest = (
  request: unknown,
): TenantFilePickRequest & { target: unknown } => {
  if (typeof request !== 'object' || request === null) throw invalid()
  const { accept, multiple, target } = request as Record<string, unknown>
  if (!Array.isArray(accept) || accept.length > MAX_ACCEPT_ENTRIES || !accept.every(isAcceptEntry)) {
    throw invalid()
  }
  if (typeof multiple !== 'boolean') throw invalid()
  if (target === undefined || !isPlainData(target, 0)) throw invalid()
  return { accept: accept.map(entry => entry.toLowerCase()), multiple, target }
}

/** Whether a file's name or type matches one of `accept` (lower-case entries); empty accepts any. */
export const acceptsFile = (accept: string[], file: { name: string; contentType: string }): boolean => {
  if (accept.length === 0) return true
  const name = file.name.toLowerCase()
  const contentType = file.contentType.toLowerCase()
  return accept.some(entry => {
    if (entry.startsWith('.')) return name.endsWith(entry)
    if (entry.endsWith('/*')) return contentType.startsWith(entry.slice(0, -1))
    return contentType === entry
  })
}
