import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { normalizeConfig } from '../lib/config.js'
import { createRuntime } from '../lib/runtime.js'
import { findOnPath } from '../lib/media.js'
import { runProcess } from '../lib/exec.js'
import { createProbeTool } from '../lib/tools/probe.js'
import { createConvertTool } from '../lib/tools/convert.js'
import { createTranscribeTool } from '../lib/tools/transcribe.js'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FFMPEG = process.env.DSH_AUDIO_FFMPEG || findOnPath('ffmpeg')
const FFPROBE = process.env.DSH_AUDIO_FFPROBE || findOnPath('ffprobe')
const WITH_FFMPEG = FFMPEG && FFPROBE
const SKIP = WITH_FFMPEG ? false : 'ffmpeg/ffprobe not found (set DSH_AUDIO_FFMPEG and DSH_AUDIO_FFPROBE)'

function makeTools(extra = {}) {
  const config = normalizeConfig({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, ...extra })
  const runtime = createRuntime(config, { pluginRoot: PLUGIN_ROOT, warn: () => {} })
  return {
    runtime,
    probe: createProbeTool(runtime),
    convert: createConvertTool(runtime),
    transcribe: createTranscribeTool(runtime),
  }
}

async function ffmpeg(args) {
  const result = await runProcess(FFMPEG, args, { timeoutMs: 120000 })
  assert.equal(result.code, 0, `ffmpeg failed: ${result.stderr.slice(-1500)}`)
  return result
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-audio-it-'))
}

test('audio_probe reads real container, duration and stream data', { skip: SKIP }, async () => {
  const dir = tempDir()
  try {
    const wav = join(dir, 'tone.wav')
    await ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ac', '2', '-ar', '44100', wav])
    const { probe } = makeTools()
    const value = await probe.execute({ path: wav })
    assert.equal(value.path, wav)
    assert.ok(Math.abs(value.durationSec - 2) < 0.15, `duration ${value.durationSec}`)
    assert.equal(value.hasVideo, false)
    assert.equal(value.hasAudio, true)
    assert.equal(value.audioStreams.length, 1)
    assert.equal(value.audioStreams[0].sampleRate, 44100)
    assert.equal(value.audioStreams[0].channels, 2)
    const text = probe.output.render({}, value)[0].text
    assert.match(text, /44100 Hz/)
    assert.match(text, /stereo/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('audio_convert transcodes wav to mp3 with a bitrate', { skip: SKIP }, async () => {
  const dir = tempDir()
  try {
    const wav = join(dir, 'tone.wav')
    const mp3 = join(dir, 'tone.mp3')
    await ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', wav])
    const { convert, probe } = makeTools()
    const value = await convert.execute({ input: wav, format: 'mp3', bitrate: '96k', output: mp3 })
    assert.equal(value.output, mp3)
    assert.ok(existsSync(mp3))
    assert.equal(value.format, 'mp3')
    assert.equal(value.codec, 'mp3')
    assert.ok(value.bitrateKbps > 60 && value.bitrateKbps < 140, `bitrate ${value.bitrateKbps}`)
    const probed = await probe.execute({ path: mp3 })
    assert.equal(probed.audioStreams[0].codec, 'mp3')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('audio_convert extracts the audio track from a video', { skip: SKIP }, async () => {
  const dir = tempDir()
  try {
    const video = join(dir, 'clip.mp4')
    const mp3 = join(dir, 'clip.mp3')
    await ffmpeg([
      '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-shortest', '-c:v', 'mpeg4', '-c:a', 'aac', video,
    ])
    const { convert, probe } = makeTools()
    const source = await probe.execute({ path: video })
    assert.equal(source.hasVideo, true)
    assert.equal(source.hasAudio, true)

    const value = await convert.execute({ input: video, format: 'mp3', output: mp3 })
    assert.ok(existsSync(mp3))
    const output = await probe.execute({ path: mp3 })
    assert.equal(output.hasVideo, false)
    assert.equal(output.hasAudio, true)
    assert.ok(Math.abs(value.durationSec - 2) < 0.3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('audio_convert trims with start and duration', { skip: SKIP }, async () => {
  const dir = tempDir()
  try {
    const wav = join(dir, 'tone.wav')
    const trimmed = join(dir, 'trimmed.mp3')
    await ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', wav])
    const { convert } = makeTools()
    const value = await convert.execute({ input: wav, format: 'mp3', output: trimmed, start: '00:00:01', duration: 1.2 })
    assert.ok(Math.abs(value.durationSec - 1.2) < 0.25, `duration ${value.durationSec}`)
    assert.equal(value.startSec, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('audio_convert refuses to overwrite unless asked', { skip: SKIP }, async () => {
  const dir = tempDir()
  try {
    const wav = join(dir, 'tone.wav')
    const mp3 = join(dir, 'tone.mp3')
    await ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', wav])
    const { convert } = makeTools()
    await convert.execute({ input: wav, format: 'mp3', output: mp3 })
    await assert.rejects(convert.execute({ input: wav, format: 'mp3', output: mp3 }), /already exists/)
    const again = await convert.execute({ input: wav, format: 'mp3', output: mp3, overwrite: true })
    assert.equal(again.output, mp3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('audio_transcribe talks to an OpenAI-compatible endpoint', { skip: SKIP }, async () => {
  const dir = tempDir()
  const requests = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      requests.push({ url: request.url, auth: request.headers.authorization, body: Buffer.concat(chunks).toString('utf8') })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        text: '你好，世界。',
        language: 'zh',
        duration: 2,
        segments: [{ start: 0, end: 1.5, text: '你好，世界。' }],
      }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const wav = join(dir, 'tone.wav')
    await ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', wav])
    const { transcribe } = makeTools({
      backend: 'api',
      apiBaseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test',
      apiModel: 'whisper-1',
    })
    const value = await transcribe.execute({ input: wav })
    assert.equal(value.text, '你好，世界。')
    assert.equal(value.backend, 'api')
    assert.equal(value.language, 'zh')
    assert.equal(value.segments.length, 1)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, '/v1/audio/transcriptions')
    assert.equal(requests[0].auth, 'Bearer sk-test')
    assert.match(requests[0].body, /name="model"/)
    assert.match(requests[0].body, /whisper-1/)
    assert.match(requests[0].body, /name="file"; filename="tone.wav"/)
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

const WHISPER = process.env.DSH_AUDIO_WHISPER
const MODELS = process.env.DSH_AUDIO_MODELS
const SPEECH = process.env.DSH_AUDIO_SPEECH_WAV
const WHISPER_SKIP = WHISPER && MODELS && SPEECH && existsSync(SPEECH)
  ? false
  : 'set DSH_AUDIO_WHISPER, DSH_AUDIO_MODELS and DSH_AUDIO_SPEECH_WAV to run the local whisper test'

test('audio_transcribe runs local whisper.cpp and writes SRT', { skip: WHISPER_SKIP }, async () => {
  const dir = tempDir()
  try {
    const language = process.env.DSH_AUDIO_SPEECH_LANG ?? 'zh'
    const { transcribe } = makeTools({ whisperPath: WHISPER, modelDir: MODELS, defaultModel: 'tiny', language, timeoutMs: 600000 })
    const srt = join(dir, 'speech.srt')
    const value = await transcribe.execute({ input: SPEECH, output: srt })
    assert.ok(value.text.trim().length > 0, 'transcript is not empty')
    assert.ok(value.segments.length > 0, 'has timed segments')
    assert.equal(value.backend, 'cli')
    assert.ok(existsSync(srt))
    assert.match(readFileSync(srt, 'utf8'), /-->/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
