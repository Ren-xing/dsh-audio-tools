import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { runChecked } from './exec.js'

/**
 * Output formats the convert tool knows how to produce.
 * `null` bitrate means lossless / uncompressed — forcing `-b:a` there is an error.
 */
export const FORMATS = Object.freeze({
  mp3: { ext: 'mp3', codec: 'libmp3lame', bitrate: '192k', lossy: true },
  wav: { ext: 'wav', codec: 'pcm_s16le', bitrate: null, lossy: false },
  flac: { ext: 'flac', codec: 'flac', bitrate: null, lossy: false },
  m4a: { ext: 'm4a', codec: 'aac', bitrate: '192k', lossy: true },
  aac: { ext: 'aac', codec: 'aac', bitrate: '192k', lossy: true },
  ogg: { ext: 'ogg', codec: 'libvorbis', bitrate: '128k', lossy: true },
  opus: { ext: 'opus', codec: 'libopus', bitrate: '96k', lossy: true },
  wma: { ext: 'wma', codec: 'wmav2', bitrate: '192k', lossy: true },
  aiff: { ext: 'aiff', codec: 'pcm_s16be', bitrate: null, lossy: false },
})

export const FORMAT_NAMES = Object.freeze(Object.keys(FORMATS))

const isWindows = process.platform === 'win32'

/**
 * Look for a binary in the given directories (PATH by default).
 * @param {string} name executable name without extension.
 * @param {readonly string[]} [extraDirs] directories searched before PATH.
 * @returns {string|null} absolute-ish path, or null.
 */
export function findOnPath(name, extraDirs = []) {
  const dirs = [...extraDirs, ...(process.env.PATH ?? '').split(delimiter)]
  const suffixes = isWindows ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const dir of dirs) {
    if (!dir) continue
    for (const suffix of suffixes) {
      const candidate = join(dir, name + suffix)
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
      } catch {
        /* unreadable directory: keep looking */
      }
    }
  }
  return null
}

/**
 * Resolve one helper binary: an explicit config path wins, then the plugin's
 * bundled directory, then PATH.
 * @param {{configured?: string|null, name: string, extraDirs?: readonly string[]}} options
 * @returns {{path: string, source: 'config'|'bundled'|'path'}|null}
 */
export function resolveTool({ configured, name, extraDirs = [] }) {
  if (configured) {
    if (existsSync(configured) && statSync(configured).isFile()) return { path: configured, source: 'config' }
    throw new Error(
      `configured path for "${name}" does not exist: ${configured}\n`
      + 'Fix the plugin config or remove the key so the PATH lookup is used.',
    )
  }
  for (const dir of extraDirs) {
    for (const suffix of isWindows ? ['', '.exe'] : ['']) {
      const candidate = join(dir, name + suffix)
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return { path: candidate, source: 'bundled' }
      } catch {
        /* ignore */
      }
    }
  }
  const found = findOnPath(name)
  return found ? { path: found, source: 'path' } : null
}

/**
 * The error shown when ffmpeg/ffprobe is not installed.
 * @param {string} name
 * @returns {Error}
 */
export function missingFfmpegError(name) {
  return new Error(
    `${name} was not found. This plugin uses your own ffmpeg build and does not bundle one.\n`
    + 'Install it, then restart DSH (one of):\n'
    + '  winget install --id Gyan.FFmpeg -e\n'
    + '  scoop install ffmpeg\n'
    + '  or download https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip and put its bin\\ folder on PATH\n'
    + `If it is installed somewhere not on PATH, set config.${name}Path to the executable.`,
  )
}

/**
 * Probe a media file with ffprobe and return the raw JSON.
 * @param {{ffprobe: string, file: string, timeoutMs: number}} options
 * @returns {Promise<any>} ffprobe JSON.
 */
export async function ffprobeJson({ ffprobe, file, timeoutMs }) {
  const { stdout } = await runChecked(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_error', file],
    { timeoutMs, what: `ffprobe (${file})` },
  )
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`ffprobe returned unreadable JSON for ${file}:\n${stdout.slice(0, 2000)}`)
  }
}

/**
 * Normalize ffprobe JSON into the shape the tools return and render.
 * @param {any} json
 * @param {string} file
 * @returns {object}
 */
export function normalizeProbe(json, file) {
  const format = json?.format ?? {}
  const streams = Array.isArray(json?.streams) ? json.streams : []
  const number = (value) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  const audio = streams
    .filter(stream => stream.codec_type === 'audio')
    .map((stream, index) => ({
      index: stream.index ?? index,
      codec: stream.codec_name ?? 'unknown',
      profile: stream.profile ?? null,
      sampleRate: number(stream.sample_rate),
      channels: number(stream.channels),
      channelLayout: stream.channel_layout ?? null,
      bitrateKbps: number(stream.bit_rate) ? Number(stream.bit_rate) / 1000 : null,
      language: stream.tags?.language ?? null,
      title: stream.tags?.title ?? null,
      durationSec: number(stream.duration) ?? number(format.duration),
      default: stream.disposition?.default === 1,
    }))

  const video = streams
    .filter(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1)
    .map((stream, index) => ({
      index: stream.index ?? index,
      codec: stream.codec_name ?? 'unknown',
      width: number(stream.width),
      height: number(stream.height),
      fps: parseRate(stream.avg_frame_rate ?? stream.r_frame_rate),
      durationSec: number(stream.duration) ?? number(format.duration),
    }))

  const tags = {}
  for (const key of ['title', 'artist', 'album', 'album_artist', 'date', 'genre', 'comment', 'track']) {
    const value = format.tags?.[key]
    if (typeof value === 'string' && value.trim()) tags[key] = value.trim()
  }

  return {
    path: file,
    container: format.format_name ?? null,
    formatLongName: format.format_long_name ?? null,
    durationSec: number(format.duration),
    sizeBytes: number(format.size),
    bitrateKbps: number(format.bit_rate) ? Number(format.bit_rate) / 1000 : null,
    tags,
    audioStreams: audio,
    videoStreams: video,
    hasVideo: video.length > 0,
    hasAudio: audio.length > 0,
  }
}

function parseRate(value) {
  if (typeof value !== 'string' || !value.includes('/')) return null
  const [num, den] = value.split('/').map(Number)
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null
  return Math.round((num / den) * 100) / 100
}
