import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { runChecked } from '../exec.js'
import { formatSrtTimestamp } from '../format.js'

const WHISPER_SETUP_HINT =
  'whisper-cli was not found. Install the local speech engine with:\n'
  + '  node "<plugin>/scripts/setup-whisper.mjs" --model small\n'
  + '(downloads whisper.cpp’s Windows binary and a ggml model, ~100–500 MB depending on the model).\n'
  + 'Or set config.whisperPath to an existing whisper-cli.exe and config.modelDir to the folder with ggml-*.bin.'

/**
 * whisper.cpp opens model/audio files through narrow (ANSI) Windows APIs, so a
 * path containing non-ASCII characters (中文, emoji, …) crashes it with
 * 0xC0000409 instead of failing cleanly. Stage those files through an ASCII
 * working directory.
 */
export function isAsciiPath(value) {
  return /^[\x20-\x7E]*$/.test(value)
}

/** Prove a directory is writable by this process; creating one does not imply it. */
function isWritableDir(dir) {
  const probe = join(dir, `.dsh-audio-probe-${process.pid}-${Date.now()}`)
  try {
    writeFileSync(probe, '')
    return true
  } catch {
    return false
  } finally {
    try { rmSync(probe, { force: true }) } catch { /* best effort */ }
  }
}

/**
 * Pick a working directory for whisper.cpp.
 *
 * Two constraints, both learned the hard way:
 *  - whisper.cpp opens files through narrow (ANSI) Windows APIs, so the path must
 *    be ASCII (Chinese folder names crash it with 0xC0000409);
 *  - the directory must really be writable by the process, which is not implied by
 *    a successful mkdir (sandboxed hosts can create a folder but deny file writes
 *    inside it), so every candidate is probed with a real write.
 *
 * @param {string|null} [preferred] `config.tempDir`, tried first.
 */
export function createWorkDir(preferred = null) {
  if (preferred) {
    if (!isAsciiPath(preferred)) {
      throw new Error(
        `config.tempDir "${preferred}" is not an ASCII path, and whisper.cpp crashes on non-ASCII paths `
        + '(0xC0000409). Point config.tempDir at an ASCII folder, or clear it to auto-detect.',
      )
    }
    try {
      if (!existsSync(preferred)) mkdirSync(preferred, { recursive: true })
      if (!isWritableDir(preferred)) throw new Error('not writable')
      return mkdtempSync(join(preferred, 'dsh-audio-'))
    } catch (error) {
      throw new Error(
        `config.tempDir "${preferred}" is not usable: ${error.code || error.message}. `
        + 'Point it at a folder this process can write to, or clear it to auto-detect.',
      )
    }
  }

  const publicRoot = process.env.PUBLIC || 'C:\\Users\\Public'
  const candidates = [
    tmpdir(),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp') : null,
    join(publicRoot, 'dsh-audio-tmp'),
    process.env.SystemRoot ? join(process.env.SystemRoot, 'Temp') : null,
  ]
  const rejected = []
  for (const base of candidates) {
    if (!base) continue
    if (!isAsciiPath(base)) {
      rejected.push(`${base} (path is not ASCII)`)
      continue
    }
    try {
      if (!existsSync(base)) mkdirSync(base, { recursive: true })
      if (!isWritableDir(base)) {
        rejected.push(`${base} (not writable)`)
        continue
      }
      return mkdtempSync(join(base, 'dsh-audio-'))
    } catch (error) {
      rejected.push(`${base} (${error.code || error.message})`)
    }
  }
  throw new Error(
    'whisper.cpp needs an ASCII working directory that this process can actually write to, '
    + 'and no candidate was usable.\n'
    + `Tried: ${rejected.join('; ') || '(none)'}\n`
    + 'Set config.tempDir to such a folder (an ASCII path that this process may write to), '
    + 'or switch this tool to backend: "api".',
  )
}

/** Hard-link when the volume allows it (free), otherwise copy. */
export function stageFile(source, target) {
  try {
    linkSync(source, target)
  } catch {
    copyFileSync(source, target)
  }
}

/**
 * Parse the JSON whisper.cpp writes with `-oj`.
 * Newer builds nest segments under `transcription` with `offsets` in ms and
 * `timestamps` as SRT clock strings; older builds only ship the clock strings.
 * @param {string} file path to `<base>.json`.
 * @returns {{text: string, segments: {start: number, end: number, text: string}[], language: string|null}}
 */
export function parseWhisperJson(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const segments = []
  const items = Array.isArray(raw?.transcription) ? raw.transcription : []
  for (const item of items) {
    const text = String(item?.text ?? '').trim()
    let start = Number(item?.offsets?.from)
    let end = Number(item?.offsets?.to)
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      start = parseSrtClock(item?.timestamps?.from)
      end = parseSrtClock(item?.timestamps?.to)
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    segments.push({ start: start / 1000, end: end / 1000, text })
  }
  const text = joinSegmentText(segments.map(segment => segment.text).filter(Boolean))
  const language = raw?.result?.language ?? raw?.params?.language ?? null
  return { text, segments, language: typeof language === 'string' ? language : null }
}

function parseSrtClock(value) {
  if (typeof value !== 'string') return Number.NaN
  const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value.trim())
  if (!match) return Number.NaN
  return Number(match[1]) * 3600000 + Number(match[2]) * 60000 + Number(match[3]) * 1000 + Number(match[4])
}

/**
 * The exact whisper-cli argument list.
 * @param {{modelPath: string, wavPath: string, outBase: string, threads: number, language: string|null, prompt?: string}} options
 * @returns {string[]}
 */
export function buildWhisperArgs({ modelPath, wavPath, outBase, threads, language, prompt }) {
  // whisper.cpp defaults to English when -l is omitted; `auto` is what
  // language detection actually needs.
  const args = ['-m', modelPath, '-f', wavPath, '-l', language ?? 'auto', '-oj', '-of', outBase, '-t', String(threads)]
  if (typeof prompt === 'string' && prompt.trim()) args.push('--prompt', prompt.trim())
  return args
}

/**
 * Transcribe with a local whisper.cpp binary.
 * @param {object} options
 * @param {ReturnType<import('../runtime.js').createRuntime>} options.runtime
 * @param {string} options.file absolute input path.
 * @param {string} options.model model name or absolute .bin path.
 * @param {string|null} options.language ISO code, or null for auto-detect.
 * @param {number} options.threads worker threads (0 = auto).
 * @param {string} [options.prompt] initial prompt to bias names/terms.
 * @returns {Promise<{text: string, segments: object[], language: string|null, model: string, backend: 'cli', durationSec: number}>}
 */
export async function transcribeWithCli({ runtime, file, model, language, threads, prompt }) {
  const whisper = runtime.whisper()
  if (!whisper) throw new Error(WHISPER_SETUP_HINT)
  const modelPath = runtime.modelPath(model)
  const { path: ffmpeg } = runtime.ffmpeg()

  const dir = createWorkDir(runtime.config.tempDir)
  const wav = join(dir, 'input.wav')
  const base = join(dir, 'transcript')
  try {
    await runChecked(
      ffmpeg,
      ['-hide_banner', '-nostdin', '-y', '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', wav],
      { timeoutMs: runtime.config.timeoutMs, what: 'ffmpeg (prepare 16 kHz mono WAV)' },
    )

    // A model under a Chinese folder name would crash whisper.cpp on load.
    let whisperModel = modelPath
    if (!isAsciiPath(modelPath)) {
      whisperModel = join(dir, 'ggml-model.bin')
      stageFile(modelPath, whisperModel)
    }
    const threadCount = threads > 0 ? threads : Math.max(1, Math.min(8, cpus().length - 1))
    const whisperArgs = buildWhisperArgs({
      modelPath: whisperModel,
      wavPath: wav,
      outBase: base,
      threads: threadCount,
      language,
      prompt,
    })
    await runChecked(whisper.path, whisperArgs, {
      timeoutMs: runtime.config.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      what: 'whisper-cli',
    })

    const jsonFile = `${base}.json`
    if (existsSync(jsonFile)) {
      const parsed = parseWhisperJson(jsonFile)
      if (parsed.text) return { ...parsed, model, backend: 'cli', durationSec: lastEnd(parsed.segments) }
    }
    const txtFile = `${base}.txt`
    if (existsSync(txtFile)) {
      const text = readFileSync(txtFile, 'utf8').trim()
      if (text) return { text, segments: [], language, model, backend: 'cli', durationSec: 0 }
    }
    throw new Error(
      'whisper-cli finished but wrote no transcript. Check that the model file is valid and the audio contains speech.\n'
      + `Model: ${modelPath}\nBinary: ${whisper.path}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Join pieces without inserting spaces between two CJK characters. */
export function joinSegmentText(pieces) {
  let out = ''
  for (const piece of pieces) {
    if (!out) {
      out = piece
      continue
    }
    const needsSpace = !/[　-鿿＀-￯]$/.test(out) || !/^[　-鿿＀-￯]/.test(piece)
    out += needsSpace ? ` ${piece}` : piece
  }
  return out.trim()
}

function lastEnd(segments) {
  const last = segments.at(-1)
  return last ? last.end : 0
}

/**
 * Serialize segments as SRT.
 * @param {{start: number, end: number, text: string}[]} segments
 * @returns {string}
 */
export function toSrt(segments) {
  return segments.map((segment, index) => [
    String(index + 1),
    `${formatSrtTimestamp(segment.start)} --> ${formatSrtTimestamp(segment.end)}`,
    segment.text,
    '',
  ].join('\n')).join('\n')
}
