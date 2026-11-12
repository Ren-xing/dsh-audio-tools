import { existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { formatBitrate, formatBytes, formatDuration, parseTime } from '../format.js'
import { FORMAT_NAMES, FORMATS, ffprobeJson, normalizeProbe } from '../media.js'
import { runChecked } from '../exec.js'

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    input: { type: 'string' },
    output: { type: 'string' },
    format: { type: 'string' },
    codec: { type: 'string' },
    durationSec: { type: 'number' },
    sizeBytes: { type: 'number' },
    bitrateKbps: { type: 'number' },
    sampleRate: { type: 'number' },
    channels: { type: 'number' },
    startSec: { type: 'number' },
    elapsedMs: { type: 'number' },
  },
  required: ['input', 'output', 'format', 'durationSec', 'sizeBytes'],
  additionalProperties: true,
}

/** Parse `192`, `192k`, `1.5M`, `192000` into an ffmpeg `-b:a` value. */
function normalizeBitrate(value, format) {
  const spec = FORMATS[format]
  if (value === undefined || value === null) return spec.bitrate
  if (!spec.lossy) {
    throw new Error(`format "${format}" is lossless or uncompressed; bitrate does not apply`)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid bitrate: ${value}`)
    return value > 1000 ? `${Math.round(value)}` : `${Math.round(value)}k`
  }
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?(?:[kKmM])?$/.test(value.trim())) {
    throw new Error(`invalid bitrate: ${JSON.stringify(value)}; use e.g. "192k", "320k", "1.5M" or 192000`)
  }
  return value.trim()
}

/** Where to write, and whether the caller asked for the input path itself. */
function deriveOutput({ input, output, format, config, overwrite }) {
  const spec = FORMATS[format]
  const target = output
    ? resolve(output)
    : join(
        config.outputDir ? resolve(config.outputDir) : dirname(input),
        `${basename(input, extname(input))}.${spec.ext}`,
      )
  if (extname(target).toLowerCase() !== `.${spec.ext}`) {
    throw new Error(`output "${target}" must end in ".${spec.ext}" for format "${format}"`)
  }
  const samePath = target.toLowerCase() === input.toLowerCase()
  if (samePath && !overwrite) {
    throw new Error(
      `refusing to overwrite the input in place: ${input}\n`
      + 'Pass a different output path, or overwrite: true to re-encode into place.',
    )
  }
  if (!samePath && existsSync(target) && !overwrite) {
    throw new Error(`output already exists: ${target}\nPass overwrite: true to replace it.`)
  }
  return { target, samePath }
}

/**
 * @param {ReturnType<import('../runtime.js').createRuntime>} runtime
 * @returns {object} a `ctx.tools.register()` definition.
 */
export function createConvertTool(runtime) {
  return {
    name: 'audio_convert',
    description:
      'Transcode audio with ffmpeg, or extract the audio track from a video. '
      + 'Optionally trim, resample, downmix and loudness-normalize in the same pass. '
      + 'Supports mp3 / wav / flac / m4a / aac / ogg / opus / wma / aiff. '
      + 'Never modifies the input file unless overwrite: true.',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Source audio or video file.' },
        format: {
          type: 'string',
          enum: FORMAT_NAMES,
          description: 'Target format. Required unless output has a supported extension.',
        },
        output: { type: 'string', description: 'Target path. Defaults to the input name with the new extension beside the input (or config.outputDir).' },
        bitrate: { type: 'string', description: 'Lossy bitrate, e.g. "192k", "320k" or "192000" (bps). Not valid for wav/flac/aiff.' },
        sampleRate: { type: 'number', description: 'Output sample rate in Hz, e.g. 16000, 44100, 48000.' },
        channels: { type: 'number', enum: [1, 2], description: '1 = mono, 2 = stereo.' },
        start: { type: 'string', description: 'Trim start: "12.5" (seconds), "01:30" or "00:01:30.5".' },
        duration: { type: 'string', description: 'Length to keep from start: "90" (seconds), "01:30" or "00:01:30.5".' },
        normalize: { type: 'boolean', description: 'Apply EBU R128 loudness normalization (loudnorm, -16 LUFS).' },
        audioStream: { type: 'number', description: 'Which audio stream to convert when there are several (0-based, default 0).' },
        overwrite: { type: 'boolean', description: 'Replace an existing output file (default false).' },
      },
      required: ['input'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderConvert(value) }] },
    async execute(args) {
      const config = runtime.config
      const input = runtime.assertFile(args?.input)

      let format = typeof args?.format === 'string' ? args.format.toLowerCase() : null
      if (format && !FORMATS[format]) throw new Error(`unsupported format "${format}"; expected ${FORMAT_NAMES.join(', ')}`)
      if (!format && typeof args?.output === 'string') {
        const guess = extname(args.output).slice(1).toLowerCase()
        if (FORMATS[guess]) format = guess
        else throw new Error(`cannot infer format from output "${args.output}"; pass format explicitly`)
      }
      if (!format) throw new Error(`specify format (${FORMAT_NAMES.join(', ')}) or an output path with one of those extensions`)

      const spec = FORMATS[format]
      const bitrate = normalizeBitrate(args?.bitrate, format)

      const sampleRate = args?.sampleRate
      if (sampleRate !== undefined && (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000)) {
        throw new Error(`invalid sampleRate: ${sampleRate}; expected an integer between 8000 and 192000`)
      }
      const channels = args?.channels
      if (channels !== undefined && channels !== 1 && channels !== 2) {
        throw new Error(`invalid channels: ${channels}; expected 1 (mono) or 2 (stereo)`)
      }
      const audioStream = args?.audioStream ?? 0
      if (!Number.isInteger(audioStream) || audioStream < 0) {
        throw new Error(`invalid audioStream: ${audioStream}; expected a 0-based integer`)
      }
      const startSec = args?.start === undefined ? null : parseTime(args.start, 'start')
      const keepSec = args?.duration === undefined ? null : parseTime(args.duration, 'duration')
      if (keepSec !== null && keepSec <= 0) throw new Error('duration must be greater than 0')

      const overwrite = args?.overwrite === true
      const { target, samePath } = deriveOutput({ input: resolve(input), output: args?.output, format, config, overwrite })
      const { path: ffmpeg } = runtime.ffmpeg()
      const { path: ffprobe } = runtime.ffprobe()

      // Re-encoding onto the source path goes through a sibling temp file: a
      // failure mid-encode must not leave the user with a truncated original.
      const write = samePath ? join(dirname(target), `.dsh-audio-${randomUUID()}.${spec.ext}`) : target

      const ffArgs = ['-hide_banner', '-nostdin', '-y']
      if (startSec !== null) ffArgs.push('-ss', String(startSec))
      ffArgs.push('-i', input, '-map', `0:a:${audioStream}`, '-vn', '-c:a', spec.codec)
      if (bitrate) ffArgs.push('-b:a', bitrate)
      if (sampleRate !== undefined) ffArgs.push('-ar', String(sampleRate))
      if (channels !== undefined) ffArgs.push('-ac', String(channels))
      if (args?.normalize === true) ffArgs.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11')
      if (keepSec !== null) ffArgs.push('-t', String(keepSec))
      ffArgs.push('-map_metadata', '0')
      if (format === 'mp3') ffArgs.push('-id3v2_version', '3')
      ffArgs.push(write)

      try {
        const run = await runChecked(ffmpeg, ffArgs, {
          timeoutMs: config.timeoutMs,
          what: `ffmpeg (${basename(input)} → ${basename(target)})`,
        })
        if (samePath) {
          // rename() replaces the existing file atomically; never delete first.
          renameSync(write, target)
        }
        const json = await ffprobeJson({ ffprobe, file: target, timeoutMs: 60000 })
        const probe = normalizeProbe(json, target)
        const audioStreamInfo = probe.audioStreams[0] ?? {}
        return {
          input,
          output: target,
          format,
          codec: audioStreamInfo.codec ?? spec.codec,
          durationSec: probe.durationSec ?? 0,
          sizeBytes: statSync(target).size,
          bitrateKbps: probe.bitrateKbps ?? audioStreamInfo.bitrateKbps ?? null,
          sampleRate: audioStreamInfo.sampleRate ?? null,
          channels: audioStreamInfo.channels ?? null,
          startSec: startSec ?? 0,
          elapsedMs: run.elapsedMs,
        }
      } catch (error) {
        if (samePath) rmSync(write, { force: true })
        throw error
      }
    },
  }
}

function renderConvert(value) {
  const channelText = value.channels === 1 ? 'mono' : value.channels === 2 ? 'stereo' : value.channels ? `${value.channels} ch` : ''
  return [
    `Converted: ${value.input} → ${value.output}`,
    `Format: ${value.format} (${value.codec})`
    + ` · ${formatBitrate(value.bitrateKbps)}`
    + (value.sampleRate ? ` · ${value.sampleRate} Hz` : '')
    + (channelText ? ` · ${channelText}` : ''),
    `Duration: ${formatDuration(value.durationSec)} · Size: ${formatBytes(value.sizeBytes)}`,
  ].join('\n')
}
