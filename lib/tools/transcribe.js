import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { SUPPORTED_MODELS } from '../config.js'
import { formatDuration } from '../format.js'
import { toSrt, transcribeWithCli } from '../transcribe/whisper-cli.js'
import { transcribeWithApi } from '../transcribe/api.js'

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    input: { type: 'string' },
    text: { type: 'string' },
    language: { type: 'string' },
    model: { type: 'string' },
    backend: { type: 'string' },
    durationSec: { type: 'number' },
    segments: { type: 'array', items: { type: 'object' } },
    srtPath: { type: 'string' },
    textPath: { type: 'string' },
  },
  required: ['input', 'text', 'backend', 'model', 'segments'],
  additionalProperties: true,
}

/** `auto` → null (whisper auto-detects); `zh-CN` → `zh`. */
function normalizeLanguage(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim().toLowerCase()
  if (!text || text === 'auto' || text === 'detect') return null
  return text.split(/[-_]/)[0]
}

/** Write a transcript/subtitle file, creating parent directories. */
function writeOutput(file, content) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
  return file
}

/**
 * @param {ReturnType<import('../runtime.js').createRuntime>} runtime
 * @returns {object} a `ctx.tools.register()` definition.
 */
export function createTranscribeTool(runtime) {
  return {
    name: 'audio_transcribe',
    description:
      'Transcribe speech to text. Local engine: whisper.cpp (CLI) — fully offline, needs whisper-cli + a ggml model. '
      + 'Remote engine: any OpenAI-compatible /audio/transcriptions endpoint (config.backend = "api"). '
      + 'Returns the transcript, language and timed segments; can also save .txt / .srt files. '
      + 'For video input only the audio track is transcribed.',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Audio or video file to transcribe.' },
        language: { type: 'string', description: 'ISO-639-1 code ("zh", "en", …) or "auto" to detect. Defaults to config.language.' },
        model: { type: 'string', enum: SUPPORTED_MODELS, description: 'Local whisper model size (cli backend). Defaults to config.defaultModel.' },
        backend: { type: 'string', enum: ['cli', 'api'], description: 'Override config.backend for this call.' },
        prompt: { type: 'string', description: 'cli backend only: initial prompt with names or domain terms to bias recognition.' },
        srt: { type: 'boolean', description: 'Also write an .srt subtitle file beside the input (or beside output).' },
        output: { type: 'string', description: 'Write the plain transcript to this path (.srt extension writes subtitles instead).' },
      },
      required: ['input'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderTranscript(value) }] },
    async execute(args) {
      const config = runtime.config
      if (args?.backend !== undefined && args.backend !== 'cli' && args.backend !== 'api') {
        throw new Error(`invalid backend "${args.backend}"; expected "cli" or "api"`)
      }
      const input = runtime.assertFile(args?.input)
      const backend = args?.backend ?? config.backend
      const language = normalizeLanguage(args?.language ?? config.language)
      const model = args?.model ?? config.defaultModel

      const result = backend === 'cli'
        ? await transcribeWithCli({ runtime, file: input, model, language, threads: config.threads, prompt: args?.prompt })
        : await transcribeWithApi({ runtime, file: input, language })

      if (!result.text) {
        throw new Error(
          `no speech was recognized in ${input} (backend: ${backend}).\n`
          + 'Check that the file has an audible speech track, or try a larger model.',
        )
      }

      const value = {
        input,
        text: result.text,
        language: result.language ?? language ?? 'unknown',
        model: result.model ?? model,
        backend: result.backend ?? backend,
        durationSec: result.durationSec ?? 0,
        segments: result.segments ?? [],
      }

      const requested = typeof args?.output === 'string' && args.output.trim() !== '' ? resolve(args.output) : null
      if (requested && extname(requested).toLowerCase() === '.srt') {
        if (!value.segments.length) throw new Error('cannot write .srt: this backend returned no timed segments')
        value.srtPath = writeOutput(requested, toSrt(value.segments))
      } else if (requested) {
        value.textPath = writeOutput(requested, `${value.text}\n`)
      }
      if (args?.srt === true && !value.srtPath) {
        if (!value.segments.length) throw new Error('cannot write .srt: this backend returned no timed segments')
        value.srtPath = writeOutput(join(dirname(input), `${basename(input, extname(input))}.srt`), toSrt(value.segments))
      }

      return value
    },
  }
}

function renderTranscript(value) {
  const lines = [
    `Transcribed: ${value.input}`,
    `Language: ${value.language} · Model: ${value.model} · Backend: ${value.backend}`
    + ` · Speech: ${formatDuration(value.durationSec)} · Segments: ${value.segments.length}`,
  ]
  if (value.srtPath) lines.push(`Subtitles: ${value.srtPath}`)
  if (value.textPath) lines.push(`Transcript: ${value.textPath}`)
  lines.push('', value.text.length > 6000 ? `${value.text.slice(0, 6000)}\n[…transcript truncated in this view; the full text is in the tool result]` : value.text)
  return lines.join('\n')
}
