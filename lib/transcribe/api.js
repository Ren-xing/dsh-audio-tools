import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'

const API_FILE_LIMIT = 24 * 1024 * 1024

/**
 * Transcribe through any OpenAI-compatible `/audio/transcriptions` endpoint
 * (OpenAI, SiliconFlow, a self-hosted gateway, …).
 * @param {object} options
 * @param {ReturnType<import('../runtime.js').createRuntime>} options.runtime
 * @param {string} options.file absolute input path.
 * @param {string|null} options.language ISO code or null.
 * @returns {Promise<{text: string, segments: object[], language: string|null, model: string, backend: 'api', durationSec: number}>}
 */
export async function transcribeWithApi({ runtime, file, language }) {
  const { config } = runtime
  if (!config.apiBaseUrl) {
    throw new Error(
      'backend "api" needs config.apiBaseUrl (e.g. "https://api.openai.com/v1" or your gateway URL) and config.apiKey.\n'
      + 'Alternatively switch back to the local engine: config.backend: "cli".',
    )
  }
  if (!config.apiKey) throw new Error('backend "api" needs config.apiKey (sent as "Authorization: Bearer …").')

  const size = statSync(file).size
  if (size > API_FILE_LIMIT) {
    throw new Error(
      `file is ${(size / 1024 / 1024).toFixed(1)} MB; the transcription API accepts at most 24 MB. `
      + 'Trim it first with audio_convert, or use backend "cli" for local transcription.',
    )
  }

  const url = config.apiBaseUrl.replace(/\/+$/, '').endsWith('/audio/transcriptions')
    ? config.apiBaseUrl
    : `${config.apiBaseUrl.replace(/\/+$/, '')}/audio/transcriptions`

  const form = new FormData()
  form.append('file', new Blob([readFileSync(file)]), basename(file))
  form.append('model', config.apiModel)
  form.append('response_format', 'verbose_json')
  if (language) form.append('language', language)

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new Error(`transcription API timed out after ${Math.round(config.timeoutMs / 1000)}s: ${url}`)
    throw new Error(`transcription API request failed: ${error.message}`)
  }

  const body = await response.text()
  if (!response.ok) {
    const hint = response.status === 401 ? ' (check config.apiKey)' : response.status === 413 ? ' (file too large for this endpoint)' : ''
    throw new Error(`transcription API returned HTTP ${response.status}${hint}:\n${body.slice(0, 2000)}`)
  }

  let data
  try {
    data = JSON.parse(body)
  } catch {
    throw new Error(`transcription API returned non-JSON output:\n${body.slice(0, 1000)}`)
  }

  const segments = (Array.isArray(data.segments) ? data.segments : [])
    .map(segment => ({
      start: Number(segment.start),
      end: Number(segment.end),
      text: String(segment.text ?? '').trim(),
    }))
    .filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end))
  const text = String(data.text ?? segments.map(segment => segment.text).join(' ')).trim()

  return {
    text,
    segments,
    language: typeof data.language === 'string' ? data.language : language,
    model: config.apiModel,
    backend: 'api',
    durationSec: segments.at(-1)?.end ?? (Number(data.duration) || 0),
  }
}
