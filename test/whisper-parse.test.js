import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { joinSegmentText, parseWhisperJson, toSrt } from '../lib/transcribe/whisper-cli.js'

function withJson(value, run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-audio-json-'))
  try {
    const file = join(dir, 'out.json')
    writeFileSync(file, JSON.stringify(value))
    return run(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('parseWhisperJson reads offsets in milliseconds', () => {
  const parsed = withJson({
    result: { language: 'zh' },
    transcription: [
      { offsets: { from: 0, to: 1500 }, timestamps: { from: '00:00:00,000', to: '00:00:01,500' }, text: ' 你好' },
      { offsets: { from: 1500, to: 3200 }, timestamps: { from: '00:00:01,500', to: '00:00:03,200' }, text: ' 世界' },
    ],
  }, parseWhisperJson)
  assert.equal(parsed.language, 'zh')
  assert.equal(parsed.segments.length, 2)
  assert.deepEqual(parsed.segments[0], { start: 0, end: 1.5, text: '你好' })
  assert.equal(parsed.text, '你好世界')
})

test('parseWhisperJson falls back to SRT clock timestamps', () => {
  const parsed = withJson({
    transcription: [
      { timestamps: { from: '00:01:02,250', to: '00:01:04,000' }, text: 'second line' },
    ],
  }, parseWhisperJson)
  assert.equal(parsed.segments[0].start, 62.25)
  assert.equal(parsed.segments[0].end, 64)
  assert.equal(parsed.text, 'second line')
  assert.equal(parsed.language, null)
})

test('parseWhisperJson keeps Latin words spaced and CJK glued', () => {
  const parsed = withJson({
    transcription: [
      { offsets: { from: 0, to: 500 }, text: ' hello world' },
      { offsets: { from: 500, to: 900 }, text: ' 你好' },
    ],
  }, parseWhisperJson)
  assert.equal(parsed.text, 'hello world 你好')
})

test('joinSegmentText inserts a single space only between Latin pieces', () => {
  assert.equal(joinSegmentText(['你好', '世界']), '你好世界')
  assert.equal(joinSegmentText(['hello', 'world']), 'hello world')
  assert.equal(joinSegmentText(['你好', 'OK']), '你好 OK')
})

test('toSrt numbers segments and formats comma timestamps', () => {
  const srt = toSrt([
    { start: 0, end: 1.5, text: '第一句' },
    { start: 1.5, end: 3.2, text: 'second' },
  ])
  const lines = srt.split('\n')
  assert.equal(lines[0], '1')
  assert.equal(lines[1], '00:00:00,000 --> 00:00:01,500')
  assert.equal(lines[2], '第一句')
  assert.equal(lines[4], '2')
  assert.equal(lines[5], '00:00:01,500 --> 00:00:03,200')
})

test('isAsciiPath distinguishes Chinese and plain paths', async () => {
  const { isAsciiPath } = await import('../lib/transcribe/whisper-cli.js')
  assert.equal(isAsciiPath('C:/Users/31614/Temp'), true)
  assert.equal(isAsciiPath('C:/Users/31614/桌面/模型.bin'), false)
})

test('stageFile produces a usable copy at an ASCII target', async () => {
  const { stageFile } = await import('../lib/transcribe/whisper-cli.js')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-audio-stage-'))
  try {
    const source = join(dir, '模型.bin')
    const target = join(dir, 'staged.bin')
    writeFileSync(source, 'model-bytes')
    stageFile(source, target)
    assert.equal(readFileSync(target, 'utf8'), 'model-bytes')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createWorkDir returns an ASCII directory or explains why it cannot', async () => {
  const { createWorkDir, isAsciiPath } = await import('../lib/transcribe/whisper-cli.js')
  try {
    const dir = createWorkDir()
    assert.equal(isAsciiPath(dir), true, `unexpected non-ASCII work dir: ${dir}`)
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    assert.match(error.message, /non-ASCII|ASCII temp/)
  }
})

test('buildWhisperArgs pins the CLI contract', async () => {
  const { buildWhisperArgs } = await import('../lib/transcribe/whisper-cli.js')
  assert.deepEqual(
    buildWhisperArgs({ modelPath: 'M.bin', wavPath: 'in.wav', outBase: 'out', threads: 4, language: null }),
    ['-m', 'M.bin', '-f', 'in.wav', '-l', 'auto', '-oj', '-of', 'out', '-t', '4'],
  )
  assert.deepEqual(
    buildWhisperArgs({ modelPath: 'M.bin', wavPath: 'in.wav', outBase: 'out', threads: 2, language: 'zh', prompt: ' 张先生 ' }),
    ['-m', 'M.bin', '-f', 'in.wav', '-l', 'zh', '-oj', '-of', 'out', '-t', '2', '--prompt', '张先生'],
  )
})
