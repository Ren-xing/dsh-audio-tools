import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeConfig } from './config.js'
import { createRuntime } from './runtime.js'
import { createProbeTool } from './tools/probe.js'
import { createConvertTool } from './tools/convert.js'
import { createTranscribeTool } from './tools/transcribe.js'

/**
 * dsh-audio — a DSH tool plugin.
 *
 * Three model-facing tools over the machine's own ffmpeg:
 *   audio_probe       read container/codec/duration/tags (ffprobe)
 *   audio_convert     transcode, extract a video's audio track, trim, resample,
 *                     downmix, normalize loudness
 *   audio_transcribe  speech-to-text with local whisper.cpp or an
 *                     OpenAI-compatible /audio/transcriptions endpoint
 *
 * Everything is resolved lazily: a machine without ffmpeg still loads the
 * profile, and only the call that needs the binary explains how to install it.
 */
export const name = 'dsh-audio'

/** The tool registry is the one service this plugin cannot work without. */
export const inject = ['tools']

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Route warnings to the host logger when there is one. */
function warnWith(ctx) {
  return (message) => {
    const logger = ctx?.logger
    if (typeof logger?.warn === 'function') logger.warn(`[dsh-audio] ${message}`)
    else console.warn(`[dsh-audio] ${message}`)
  }
}

/**
 * Register the tools (and the usage skill) on the host context.
 * @param {import('cordis').Context} ctx plugin context.
 * @param {unknown} [rawConfig] the `config:` block from cordis.yml.
 */
export function apply(ctx, rawConfig) {
  const warn = warnWith(ctx)
  const config = normalizeConfig(rawConfig, { warn })
  const runtime = createRuntime(config, { pluginRoot, warn })

  const tools = [
    createProbeTool(runtime),
    createConvertTool(runtime),
    createTranscribeTool(runtime),
  ]
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-audio: ${tool.name}`)
  }

  // The skill is documentation, not a hard dependency: a profile without a
  // skills service still gets the tools.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (skillCtx) => {
      try {
        const skillDir = join(pluginRoot, 'skills', 'dsh-audio')
        const content = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
        skillCtx.effect(() => skillCtx.skills.register({
          name: 'dsh-audio',
          description: 'Inspect, convert, extract and transcribe audio/video files with ffmpeg and whisper.cpp.',
          whenToUse: 'Use when the user asks about an audio or video file’s duration/format/codec, wants a format conversion, '
            + 'wants the audio track ripped out of a video, wants volume normalized or audio trimmed, or wants speech turned into text/subtitles.',
          content,
          resourceBase: { kind: 'directory', path: skillDir },
          source: 'bundled',
        }), 'dsh-audio: skill')
      } catch (error) {
        warn(`skill registration skipped: ${error.message}`)
      }
    })
  }
}

export default { name, inject, apply }
