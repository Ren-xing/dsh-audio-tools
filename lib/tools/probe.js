import { formatBitrate, formatBytes, formatClock, formatDuration } from '../format.js'
import { ffprobeJson, normalizeProbe } from '../media.js'

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    container: { type: 'string' },
    formatLongName: { type: 'string' },
    durationSec: { type: 'number' },
    sizeBytes: { type: 'number' },
    bitrateKbps: { type: 'number' },
    tags: { type: 'object' },
    audioStreams: { type: 'array', items: { type: 'object' } },
    videoStreams: { type: 'array', items: { type: 'object' } },
    hasAudio: { type: 'boolean' },
    hasVideo: { type: 'boolean' },
  },
  required: ['path', 'durationSec', 'audioStreams', 'videoStreams', 'hasAudio', 'hasVideo'],
  additionalProperties: true,
}

/**
 * @param {ReturnType<import('../runtime.js').createRuntime>} runtime
 * @returns {object} a `ctx.tools.register()` definition.
 */
export function createProbeTool(runtime) {
  return {
    name: 'audio_probe',
    description:
      'Inspect an audio or video file with ffprobe: container, duration, size, overall bitrate, tags, '
      + 'and every audio/video stream (codec, sample rate, channels, bitrate, language). '
      + 'Use it before converting or transcribing to learn what the file actually contains.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the audio or video file.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderProbe(value) }] },
    async execute(args) {
      const file = runtime.assertFile(args?.path)
      const { path: ffprobe } = runtime.ffprobe()
      const json = await ffprobeJson({ ffprobe, file, timeoutMs: Math.min(runtime.config.timeoutMs, 120000) })
      const probe = normalizeProbe(json, file)
      if (!probe.hasAudio && !probe.hasVideo) {
        throw new Error(`ffprobe found no audio or video stream in ${file}; is this a media file?`)
      }
      // Keep the value inside the published output schema even for streams
      // where ffprobe omits duration/size.
      return { ...probe, durationSec: probe.durationSec ?? 0, sizeBytes: probe.sizeBytes ?? 0 }
    },
  }
}

function renderProbe(probe) {
  const lines = []
  const kind = [probe.formatLongName || probe.container || 'unknown format']
  if (probe.hasVideo) kind.push(`${probe.videoStreams.length} video stream(s)`)
  if (probe.hasAudio) kind.push(`${probe.audioStreams.length} audio stream(s)`)
  lines.push(`${probe.path}`)
  lines.push(`Format: ${kind.join(', ')}`)
  lines.push(
    `Duration: ${formatDuration(probe.durationSec ?? 0)} (${formatClock(probe.durationSec ?? 0)})`
    + ` · Size: ${formatBytes(probe.sizeBytes ?? 0)}`
    + ` · Overall bitrate: ${formatBitrate(probe.bitrateKbps)}`,
  )
  const tags = Object.entries(probe.tags ?? {})
  if (tags.length) lines.push(`Tags: ${tags.map(([key, value]) => `${key}=${value}`).join(', ')}`)
  for (const [index, stream] of probe.audioStreams.entries()) {
    const parts = [
      `Audio #${index}: ${stream.codec}`,
      stream.sampleRate ? `${stream.sampleRate} Hz` : 'unknown rate',
      channelLabel(stream.channels),
      formatBitrate(stream.bitrateKbps),
    ]
    if (stream.language) parts.push(`lang=${stream.language}`)
    if (stream.title) parts.push(`title=${stream.title}`)
    if (stream.default) parts.push('default')
    lines.push(parts.join(' · '))
  }
  for (const [index, stream] of probe.videoStreams.entries()) {
    const parts = [`Video #${index}: ${stream.codec}`]
    if (stream.width && stream.height) parts.push(`${stream.width}x${stream.height}`)
    if (stream.fps) parts.push(`${stream.fps} fps`)
    lines.push(parts.join(' · '))
  }
  if (!probe.hasAudio) lines.push('No audio stream — nothing to convert or transcribe.')
  return lines.join('\n')
}

function channelLabel(channels) {
  if (!Number.isFinite(channels)) return '? channels'
  if (channels === 1) return 'mono'
  if (channels === 2) return 'stereo'
  return `${channels} channels`
}
