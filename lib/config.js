import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Plugin defaults. Every key is optional; `normalizeConfig()` never throws so a
 * typo in a profile cannot take the whole DSH profile down at startup.
 */
export const DEFAULTS = Object.freeze({
  ffmpegPath: null,
  ffprobePath: null,
  whisperPath: null,
  modelDir: join(homedir(), '.dsh', 'audio-models'),
  defaultModel: 'small',
  language: 'zh',
  backend: 'cli',
  apiBaseUrl: '',
  apiKey: '',
  apiModel: 'whisper-1',
  outputDir: null,
  timeoutMs: 600000,
  threads: 0,
})

const TYPES = Object.freeze({
  ffmpegPath: 'string|null',
  ffprobePath: 'string|null',
  whisperPath: 'string|null',
  modelDir: 'string',
  defaultModel: 'string',
  language: 'string',
  backend: 'string',
  apiBaseUrl: 'string',
  apiKey: 'string',
  apiModel: 'string',
  outputDir: 'string|null',
  timeoutMs: 'number',
  threads: 'number',
})

export const SUPPORTED_MODELS = Object.freeze([
  'tiny',
  'tiny.en',
  'base',
  'base.en',
  'small',
  'small.en',
  'medium',
  'medium.en',
  'large-v3',
])

const BACKENDS = Object.freeze(['cli', 'api'])

/** Expand `~`, `%VAR%` and `$VAR` in a configured path. */
export function expandPath(value) {
  if (typeof value !== 'string') return value
  let out = value.trim()
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = join(homedir(), out.slice(1))
  }
  out = out.replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole)
  out = out.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced, plain) => {
    const name = braced ?? plain
    return process.env[name] ?? whole
  })
  return out
}

function checkType(key, value) {
  const kind = TYPES[key]
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (kind === 'string|null') return actual === 'string' || actual === 'null'
  if (kind === 'number') return actual === 'number' && Number.isFinite(value)
  return actual === kind
}

/**
 * Validate and normalize the profile config block.
 * @param {unknown} raw the `config:` value from cordis.yml / cordis.patch.yml.
 * @param {{warn?: (message: string) => void}} [options] warning sink.
 * @returns {typeof DEFAULTS} a complete, typed config object.
 */
export function normalizeConfig(raw, { warn = () => {} } = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {}
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    warn(`ignoring config: expected an object, got ${Array.isArray(raw) ? 'array' : typeof raw}`)
  }
  // `config: { options: {...} }` is accepted too; some other plugins use it.
  const nested = input.options && typeof input.options === 'object' && !Array.isArray(input.options)
    ? input.options
    : null
  const source = nested ? { ...nested, ...input } : input
  delete source.options

  const config = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    const value = source[key]
    if (value === undefined) continue
    if (!checkType(key, value)) {
      warn(`ignoring config.${key}: expected ${TYPES[key]}, got ${value === null ? 'null' : typeof value}`)
      continue
    }
    const pathLike = key.endsWith('Path') || key === 'outputDir' || key === 'modelDir'
    config[key] = pathLike && typeof value === 'string' ? expandPath(value) : value
  }

  const unknown = Object.keys(source).filter(key => !Object.prototype.hasOwnProperty.call(DEFAULTS, key))
  if (unknown.length > 0) warn(`ignoring unknown config key(s): ${unknown.join(', ')}`)

  if (!SUPPORTED_MODELS.includes(config.defaultModel)) {
    warn(`config.defaultModel "${config.defaultModel}" is not one of ${SUPPORTED_MODELS.join(', ')}; falling back to "small"`)
    config.defaultModel = 'small'
  }
  if (!BACKENDS.includes(config.backend)) {
    warn(`config.backend "${config.backend}" is not one of ${BACKENDS.join(', ')}; falling back to "cli"`)
    config.backend = 'cli'
  }
  config.timeoutMs = Math.min(Math.max(Math.round(config.timeoutMs), 5000), 6 * 60 * 60 * 1000)
  config.threads = Math.min(Math.max(Math.round(config.threads), 0), 64)
  for (const key of ['ffmpegPath', 'ffprobePath', 'whisperPath', 'outputDir']) {
    if (config[key] === '') config[key] = null
  }
  return config
}
