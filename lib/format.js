/** Pure helpers shared by the tools: time, size and path formatting. */

const TIME_PATTERN = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/

/**
 * Parse a time written as seconds, `mm:ss` or `hh:mm:ss[.sss]`.
 * @param {unknown} value number of seconds or a clock string.
 * @param {string} [label] argument name used in the error message.
 * @returns {number} seconds.
 * @throws {Error} when the value is not a valid non-negative time.
 */
export function parseTime(value, label = 'time') {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 0) throw new Error(`invalid ${label}: ${value} is negative`)
    return value
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`invalid ${label}: expected seconds or "hh:mm:ss", got ${JSON.stringify(value)}`)
  }
  const text = value.trim()
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text)
  const match = TIME_PATTERN.exec(text)
  if (!match) throw new Error(`invalid ${label}: ${JSON.stringify(value)}; use seconds, "mm:ss" or "hh:mm:ss")`)
  const hours = Number(match[1] ?? 0)
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  if (minutes > 59 || seconds >= 60) {
    throw new Error(`invalid ${label}: ${JSON.stringify(value)}; minutes must be < 60 and seconds < 60`)
  }
  return hours * 3600 + minutes * 60 + seconds
}

/**
 * Format seconds as `hh:mm:ss.mmm`.
 * @param {number} seconds
 * @returns {string}
 */
export function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--:--'
  const totalMs = Math.round(seconds * 1000)
  const ms = totalMs % 1000
  const totalSec = Math.floor(totalMs / 1000)
  const s = totalSec % 60
  const m = Math.floor(totalSec / 60) % 60
  const h = Math.floor(totalSec / 3600)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

/**
 * Format seconds as an SRT timestamp (`hh:mm:ss,mmm`).
 * @param {number} seconds
 * @returns {string}
 */
export function formatSrtTimestamp(seconds) {
  return formatClock(seconds).replace('.', ',')
}

/**
 * Format a byte count for humans.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`
}

/**
 * Format seconds as `1h 02m 03s` / `1m 02s` / `3.2s`.
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '?'
  const whole = Math.floor(seconds)
  const ms = seconds - whole
  const h = Math.floor(whole / 3600)
  const m = Math.floor(whole / 60) % 60
  const s = whole % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return ms > 0.05 ? `${(whole + ms).toFixed(1)}s` : `${s}s`
}

/**
 * Format a bitrate in kbit/s.
 * @param {number|null|undefined} kbps
 * @returns {string}
 */
export function formatBitrate(kbps) {
  return Number.isFinite(kbps) && kbps > 0 ? `${Math.round(kbps)} kbps` : '?'
}
