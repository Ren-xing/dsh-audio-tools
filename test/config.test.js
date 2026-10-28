import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULTS, normalizeConfig } from '../lib/config.js'

test('normalizeConfig fills every default', () => {
  const config = normalizeConfig(undefined)
  assert.deepEqual(config, DEFAULTS)
  assert.equal(typeof config.modelDir, 'string')
})

test('normalizeConfig keeps valid values', () => {
  const config = normalizeConfig({
    ffmpegPath: 'C:/ffmpeg/bin/ffmpeg.exe',
    defaultModel: 'tiny',
    backend: 'api',
    apiBaseUrl: 'https://example.test/v1',
    timeoutMs: 120000,
    threads: 4,
  })
  assert.equal(config.ffmpegPath, 'C:/ffmpeg/bin/ffmpeg.exe')
  assert.equal(config.defaultModel, 'tiny')
  assert.equal(config.backend, 'api')
  assert.equal(config.timeoutMs, 120000)
  assert.equal(config.threads, 4)
})

test('normalizeConfig warns on unknown keys without throwing', () => {
  const warnings = []
  const config = normalizeConfig({ ffmpegPth: 'typo' }, { warn: message => warnings.push(message) })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /unknown config key\(s\): ffmpegPth/)
  assert.equal(config.ffmpegPath, null)
})

test('normalizeConfig rejects wrong types and falls back', () => {
  const warnings = []
  const config = normalizeConfig(
    { timeoutMs: 'soon', threads: 'many', defaultModel: 'huge', backend: 'quantum' },
    { warn: message => warnings.push(message) },
  )
  assert.equal(config.timeoutMs, DEFAULTS.timeoutMs)
  assert.equal(config.threads, DEFAULTS.threads)
  assert.equal(config.defaultModel, 'small')
  assert.equal(config.backend, 'cli')
  assert.equal(warnings.length, 4)
})

test('normalizeConfig accepts the nested options form', () => {
  const config = normalizeConfig({ options: { defaultModel: 'base', language: 'en' } })
  assert.equal(config.defaultModel, 'base')
  assert.equal(config.language, 'en')
})

test('normalizeConfig expands ~ and environment variables', () => {
  process.env.DSH_AUDIO_TEST_DIR = 'C:/tmp/audio'
  const config = normalizeConfig({ ffmpegPath: '%DSH_AUDIO_TEST_DIR%/ffmpeg.exe', modelDir: '~/models' })
  assert.equal(config.ffmpegPath, 'C:/tmp/audio/ffmpeg.exe')
  assert.ok(config.modelDir.endsWith('models'))
  delete process.env.DSH_AUDIO_TEST_DIR
})

test('normalizeConfig clamps timeout and thread counts', () => {
  assert.equal(normalizeConfig({ timeoutMs: 1 }).timeoutMs, 5000)
  assert.equal(normalizeConfig({ timeoutMs: 1e12 }).timeoutMs, 6 * 60 * 60 * 1000)
  assert.equal(normalizeConfig({ threads: -5 }).threads, 0)
  assert.equal(normalizeConfig({ threads: 500 }).threads, 64)
})

test('normalizeConfig treats empty path strings as unset', () => {
  const config = normalizeConfig({ ffmpegPath: '', whisperPath: '' })
  assert.equal(config.ffmpegPath, null)
  assert.equal(config.whisperPath, null)
})
