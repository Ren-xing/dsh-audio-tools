#!/usr/bin/env node
// ---------------------------------------------------------------------------
// setup-whisper.mjs — install the local speech engine used by audio_transcribe.
//
// Downloads (pinned release, sha256 printed):
//   <plugin>/vendor/whisper/whisper-cli.exe    whisper.cpp Windows binary
//   ~/.dsh/audio-models/ggml-<model>.bin       ggml model (default: small)
//
// Usage:
//   node scripts/setup-whisper.mjs [--model small] [--force]
//                                  [--models-dir <dir>] [--binary-dir <dir>]
//                                  [--mirror hf-mirror|hf] [--skip-binary] [--skip-model]
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto'
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WHISPER_RELEASE = 'b5454'
const RELEASE_BASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE}`
const MIRRORS = Object.freeze({
  'hf-mirror': 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main',
  hf: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main',
})
const MODELS = Object.freeze({
  tiny: 77e6,
  'tiny.en': 77e6,
  base: 148e6,
  'base.en': 148e6,
  small: 488e6,
  'small.en': 488e6,
  medium: 1.53e9,
  'medium.en': 1.53e9,
  'large-v3': 3.1e9,
})

function parseArgs(argv) {
  const options = {
    model: 'small',
    force: false,
    modelsDir: join(homedir(), '.dsh', 'audio-models'),
    binaryDir: join(PLUGIN_ROOT, 'vendor', 'whisper'),
    mirror: 'hf-mirror',
    skipBinary: false,
    skipModel: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined) fail(`missing value for ${arg}`)
      index += 1
      return value
    }
    switch (arg) {
      case '--model': options.model = next(); break
      case '--models-dir': options.modelsDir = next(); break
      case '--binary-dir': options.binaryDir = next(); break
      case '--mirror': options.mirror = next(); break
      case '--force': options.force = true; break
      case '--skip-binary': options.skipBinary = true; break
      case '--skip-model': options.skipModel = true; break
      case '-h':
      case '--help':
        console.log(helpText())
        process.exit(0)
        break
      default:
        fail(`unknown argument: ${arg}\n\n${helpText()}`)
    }
  }
  if (!MODELS[options.model]) fail(`unknown model "${options.model}"; expected ${Object.keys(MODELS).join(', ')}`)
  if (!MIRRORS[options.mirror]) fail(`unknown mirror "${options.mirror}"; expected ${Object.keys(MIRRORS).join(', ')}`)
  return options
}

function helpText() {
  return [
    'Install whisper.cpp (Windows binary) and a ggml model for dsh-audio.',
    '',
    'Options:',
    '  --model <name>      tiny | base | small | medium | large-v3 (default: small)',
    '  --models-dir <dir>  where ggml-*.bin goes (default: ~/.dsh/audio-models)',
    '  --binary-dir <dir>  where whisper-cli.exe goes (default: <plugin>/vendor/whisper)',
    '  --mirror <name>     hf-mirror (default, works in CN) | hf',
    '  --skip-binary       download only the model',
    '  --skip-model        download only the binary',
    '  --force             re-download even when a file already exists',
  ].join('\n')
}

function fail(message) {
  console.error(`\n[setup-whisper] ${message}`)
  process.exit(1)
}

function log(message) {
  console.log(`[setup-whisper] ${message}`)
}

/** Streaming sha256 — a 3 GB model never has to fit in memory. */
function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function download(url, target, expectedBytes) {
  const candidates = [url]
  if (url.startsWith('https://github.com/')) {
    // GitHub release assets are frequently unreachable from mainland networks.
    candidates.push(`https://gh-proxy.com/${url}`, `https://ghproxy.net/${url}`)
  }
  let lastError
  for (const candidate of candidates) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await downloadOnce(candidate, target, expectedBytes)
        return
      } catch (error) {
        lastError = error
        log(`attempt ${attempt} failed for ${candidate}: ${error.message}`)
      }
    }
  }
  throw lastError ?? new Error(`could not download ${url}`)
}

async function downloadOnce(url, target, expectedBytes) {
  const part = `${target}.part`
  rmSync(part, { force: true })
  log(`GET ${url}`)
  // Abort only if the connection/headers stall; the body may legitimately take
  // many minutes on a slow link, so the timer is cleared once headers arrive.
  const controller = new AbortController()
  const connectTimer = setTimeout(() => controller.abort(), 60000)
  let response
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'dsh-audio-setup' },
    })
  } finally {
    clearTimeout(connectTimer)
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  const total = Number(response.headers.get('content-length')) || expectedBytes || 0
  let done = 0
  let nextReport = 10
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      done += chunk.length
      const percent = total ? Math.floor((done / total) * 100) : 0
      if (percent >= nextReport) {
        log(`${basename(target)}: ${percent}%`)
        nextReport = percent + 10
      }
      callback(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(part))
  if (total && done !== total) throw new Error(`short download for ${url}: ${done}/${total} bytes`)
  renameSync(part, target)
  log(`${basename(target)}: ${(statSync(target).size / 1e6).toFixed(1)} MB, sha256=${await sha256(target)}`)
}

/** Extract a zip on Windows (PowerShell) or with `unzip` elsewhere. */
async function extractZip(zip, destination) {
  mkdirSync(destination, { recursive: true })
  if (process.platform === 'win32') {
    const quote = value => `'${value.replace(/'/g, "''")}'`
    await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(destination)} -Force`,
    ])
    return
  }
  await run('unzip', ['-o', '-q', zip, '-d', destination])
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${file} exited with ${code}`))))
  })
}

/** Find whisper-cli.exe (or the legacy main.exe) below a directory. */
function findBinary(root) {
  if (!existsSync(root)) return null
  const wanted = new Set(['whisper-cli.exe', 'whisper-cli', 'main.exe', 'main'])
  const queue = [root]
  while (queue.length) {
    const dir = queue.shift()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (wanted.has(entry.name)) return full
    }
  }
  return null
}

/** Flatten the release layout (Release/…) into the target directory. */
function moveInto(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true })
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const from = join(sourceDir, entry.name)
    const to = join(targetDir, entry.name)
    rmSync(to, { recursive: true, force: true })
    renameSync(from, to)
  }
}

async function installBinary(binaryDir, force) {
  const existing = findBinary(binaryDir)
  if (existing && !force) {
    log(`whisper binary already present: ${existing} (use --force to reinstall)`)
    return existing
  }
  if (process.platform !== 'win32') {
    log('not Windows: install whisper.cpp yourself (e.g. `brew install whisper-cpp`) and set config.whisperPath.')
    return null
  }
  const asset = process.arch === 'arm64' ? 'whisper-bin-win-cpu-arm64.zip' : 'whisper-bin-x64.zip'
  const zip = join(tmpdir(), `dsh-audio-${WHISPER_RELEASE}-${asset}`)
  const unpack = join(tmpdir(), `dsh-audio-whisper-${process.pid}`)
  rmSync(unpack, { recursive: true, force: true })
  await download(`${RELEASE_BASE}/${asset}`, zip, 9e6)
  log(`extracting ${asset}`)
  await extractZip(zip, unpack)
  const binary = findBinary(unpack)
  if (!binary) throw new Error(`no whisper-cli.exe inside ${asset}`)
  moveInto(dirname(binary), binaryDir)
  rmSync(unpack, { recursive: true, force: true })
  rmSync(zip, { force: true })
  const installed = findBinary(binaryDir)
  if (!installed) throw new Error('binary extraction failed')
  log(`installed ${installed}`)
  return installed
}

async function installModel(modelsDir, model, mirror, force) {
  const target = join(modelsDir, `ggml-${model}.bin`)
  if (existsSync(target) && !force) {
    log(`model already present: ${target} (use --force to re-download)`)
    return target
  }
  mkdirSync(modelsDir, { recursive: true })
  const expected = MODELS[model]
  if (expected > 1e9) log(`note: ${model} is about ${(expected / 1e9).toFixed(1)} GB — this takes a while`)
  await download(`${MIRRORS[mirror]}/ggml-${model}.bin`, target, expected)
  if (statSync(target).size < 1e6) throw new Error(`model file looks too small: ${target}`)
  return target
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  log(`plugin: ${PLUGIN_ROOT}`)
  log(`model: ${options.model} (${(MODELS[options.model] / 1e6).toFixed(0)} MB), mirror: ${options.mirror}`)

  let binary = null
  let modelPath = null
  if (!options.skipBinary) binary = await installBinary(options.binaryDir, options.force)
  if (!options.skipModel) modelPath = await installModel(options.modelsDir, options.model, options.mirror, options.force)

  console.log('\nDone. If these paths differ from the plugin config, add them to the dsh-audio entry:\n')
  console.log('  - id: dsh-audio')
  console.log("    name: 'dsh-audio'")
  console.log('    config:')
  if (binary) console.log(`      whisperPath: '${binary.replace(/\\/g, '\\\\')}'`)
  if (modelPath) console.log(`      modelDir: '${options.modelsDir.replace(/\\/g, '\\\\')}'`)
  console.log(`      defaultModel: '${options.model}'`)
  console.log('\nRestart DSH, then ask: "转写 <音频文件> 的内容"')
}

main().catch(error => fail(error.stack ?? error.message))
