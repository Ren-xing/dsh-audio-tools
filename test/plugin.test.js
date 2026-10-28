import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'

/** Minimal Cordis-like context: one tool registry, one skills registry. */
function stubContext() {
  const tools = new Map()
  const skills = []
  const warnings = []
  const ctx = {
    logger: { warn: message => warnings.push(message) },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    skills: {
      register(definition) {
        skills.push(definition)
        return () => {}
      },
    },
    effect(fn) {
      return fn()
    },
    inject(_deps, callback) {
      return callback(ctx)
    },
  }
  return { ctx, tools, skills, warnings }
}

test('apply registers the three audio tools', () => {
  const { ctx, tools } = stubContext()
  apply(ctx, {})
  assert.deepEqual([...tools.keys()].sort(), ['audio_convert', 'audio_probe', 'audio_transcribe'])
  for (const [name, definition] of tools) {
    assert.equal(typeof definition.description, 'string', `${name} has a description`)
    assert.ok(definition.description.length > 40, `${name} description is useful`)
    assert.equal(definition.parameters.type, 'object')
    assert.equal(definition.parameters.additionalProperties, false)
    const required = name === 'audio_probe' ? ['path'] : ['input']
    assert.deepEqual(definition.parameters.required, required)
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.schema, 'object')
    assert.equal(typeof definition.output.render, 'function')
  }
})

test('apply registers the usage skill', () => {
  const { ctx, skills } = stubContext()
  apply(ctx, {})
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, 'dsh-audio')
  assert.match(skills[0].content, /audio_probe/)
  assert.equal(skills[0].source, 'bundled')
  assert.ok(skills[0].resourceBase.path.endsWith('skills\\dsh-audio') || skills[0].resourceBase.path.endsWith('skills/dsh-audio'))
})

test('config warnings go to the host logger', () => {
  const { ctx, warnings } = stubContext()
  apply(ctx, { nonsense: true })
  assert.ok(warnings.some(message => message.includes('unknown config key')))
})

test('audio_probe rejects a missing file with a clear message', async () => {
  const { ctx, tools } = stubContext()
  apply(ctx, {})
  await assert.rejects(
    tools.get('audio_probe').execute({ path: join(tmpdir(), 'dsh-audio-does-not-exist.wav') }),
    /does not exist/,
  )
})

test('audio_convert requires a target format or a usable output extension', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-audio-test-'))
  try {
    const file = join(dir, 'input.wav')
    writeFileSync(file, 'not really audio')
    const { ctx, tools } = stubContext()
    apply(ctx, {})
    await assert.rejects(tools.get('audio_convert').execute({ input: file }), /specify format/)
    await assert.rejects(tools.get('audio_convert').execute({ input: file, output: join(dir, 'x.xyz') }), /cannot infer format/)
    await assert.rejects(tools.get('audio_convert').execute({ input: file, format: 'mp3', start: '1:99' }), /invalid start/)
    await assert.rejects(tools.get('audio_convert').execute({ input: file, format: 'mp3', sampleRate: 1 }), /sampleRate/)
    await assert.rejects(tools.get('audio_convert').execute({ input: file, format: 'wav', bitrate: '320k' }), /lossless/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('audio_transcribe reports a missing apiBaseUrl before touching the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-audio-test-'))
  try {
    const file = join(dir, 'input.mp3')
    writeFileSync(file, 'not really audio')
    const { ctx, tools } = stubContext()
    apply(ctx, { backend: 'api' })
    await assert.rejects(
      tools.get('audio_transcribe').execute({ input: file }),
      /apiBaseUrl/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('audio_transcribe rejects an unknown backend value', async () => {
  const { ctx, tools } = stubContext()
  apply(ctx, {})
  await assert.rejects(
    tools.get('audio_transcribe').execute({ input: 'whatever.wav', backend: 'cloud' }),
    /invalid backend/,
  )
})
