import { existsSync, statSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { SUPPORTED_MODELS } from './config.js'
import { missingFfmpegError, resolveTool } from './media.js'

/**
 * Resolve helper binaries lazily. A missing ffmpeg must not stop the plugin
 * from loading: the profile still starts, and only the tool call that needs
 * ffmpeg reports the actionable error.
 * @param {ReturnType<import('./config.js').normalizeConfig>} config
 * @param {{pluginRoot: string, warn: (message: string) => void}} options
 */
export function createRuntime(config, { pluginRoot, warn }) {
  const whisperDir = join(pluginRoot, 'vendor', 'whisper')

  const resolve = (kind) => {
    const found = kind === 'ffmpeg'
      ? resolveTool({ configured: config.ffmpegPath, name: 'ffmpeg' })
      : resolveTool({ configured: config.ffprobePath, name: 'ffprobe' })
    if (!found) throw missingFfmpegError(kind)
    return found
  }

  return {
    config,
    pluginRoot,
    warn,
    /** @returns {{path: string, source: string}} */
    ffmpeg() {
      return resolve('ffmpeg')
    },
    /** @returns {{path: string, source: string}} */
    ffprobe() {
      return resolve('ffprobe')
    },
    /**
     * Locate whisper-cli (or an `whisper` binary on PATH).
     * @returns {{path: string, source: string}|null}
     */
    whisper() {
      return resolveTool({ configured: config.whisperPath, name: 'whisper-cli', extraDirs: [whisperDir] })
        ?? resolveTool({ configured: null, name: 'whisper', extraDirs: [whisperDir] })
    },
    /**
     * Resolve a ggml model: an absolute `.bin` path is used as-is, otherwise
     * `<modelDir>/ggml-<name>.bin`.
     * @param {string} model
     * @returns {string}
     */
    modelPath(model) {
      if (typeof model === 'string' && (model.includes('\\') || model.includes('/')) && model.endsWith('.bin')) {
        if (!existsSync(model)) throw new Error(`model file not found: ${model}`)
        return model
      }
      if (!SUPPORTED_MODELS.includes(model)) {
        throw new Error(`unknown model "${model}"; expected one of ${SUPPORTED_MODELS.join(', ')} or a path to a .bin file`)
      }
      const candidate = join(config.modelDir, `ggml-${model}.bin`)
      if (!existsSync(candidate)) {
        throw new Error(
          `whisper model "${model}" is missing: ${candidate}\n`
          + 'Download it with:\n'
          + `  node "${join(pluginRoot, 'scripts', 'setup-whisper.mjs')}" --model ${model}\n`
          + 'or set config.modelDir to the folder holding ggml-*.bin files.',
        )
      }
      return candidate
    },
    /** Ensure a path is an existing regular file. */
    assertFile(file, label = 'input') {
      if (typeof file !== 'string' || file.trim() === '') throw new Error(`${label} is required`)
      const absolute = isAbsolute(file) ? file : join(process.cwd(), file)
      if (!existsSync(absolute)) throw new Error(`${label} does not exist: ${absolute}`)
      if (!statSync(absolute).isFile()) throw new Error(`${label} is not a regular file: ${absolute}`)
      return absolute
    },
  }
}
