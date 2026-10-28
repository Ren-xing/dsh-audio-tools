import { spawn } from 'node:child_process'

const isWindows = process.platform === 'win32'

/** Error raised when a helper process exits non-zero, times out or cannot spawn. */
export class ProcessError extends Error {
  /**
   * @param {string} message human-readable failure.
   * @param {{file?: string, code?: number|null, stdout?: string, stderr?: string, timedOut?: boolean, signal?: string|null}} [detail]
   */
  constructor(message, detail = {}) {
    super(message)
    this.name = 'ProcessError'
    this.file = detail.file
    this.code = detail.code ?? null
    this.stdout = detail.stdout ?? ''
    this.stderr = detail.stderr ?? ''
    this.timedOut = detail.timedOut ?? false
    this.signal = detail.signal ?? null
  }
}

/** Kill a child process and everything it started (ffmpeg spawns none, but be safe). */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (isWindows) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run a helper binary without a shell and capture its output.
 *
 * Arguments are passed as an array: no quoting, no globbing, no command
 * injection. Output is capped — ffmpeg on a corrupt file can be very chatty —
 * and the cap keeps the tail, which is where ffmpeg puts the real error.
 *
 * @param {string} file absolute path to the executable.
 * @param {readonly string[]} args arguments, verbatim.
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, maxBuffer?: number}} [options]
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string, elapsedMs: number, timedOut: boolean}>}
 */
export function runProcess(file, args, options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 600000,
    maxBuffer = 4 * 1024 * 1024,
  } = options

  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    /** @type {import('node:child_process').ChildProcess} */
    let child
    try {
      child = spawn(file, [...args], {
        cwd,
        env: env ?? process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(new ProcessError(`cannot start ${file}: ${error.message}`, { file }))
      return
    }

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false

    const collect = (chunk, target) => {
      const text = chunk.toString('utf8')
      const combined = target + text
      if (combined.length <= maxBuffer) return combined
      truncated = true
      return combined.slice(combined.length - maxBuffer)
    }

    child.stdout?.on('data', chunk => { stdout = collect(chunk, stdout) })
    child.stderr?.on('data', chunk => { stderr = collect(chunk, stderr) })

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    timer.unref?.()

    child.on('error', error => {
      clearTimeout(timer)
      reject(new ProcessError(`cannot start ${file}: ${error.message}`, { file, stdout, stderr }))
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (truncated) stderr += '\n[output truncated]'
      if (timedOut) {
        reject(new ProcessError(
          `${file} timed out after ${Math.round(timeoutMs / 1000)}s`,
          { file, code, signal, stdout, stderr, timedOut: true },
        ))
        return
      }
      resolve({ code, signal, stdout, stderr, elapsedMs: Date.now() - startedAt, timedOut: false })
    })
  })
}

/**
 * Run a helper and fail with the tool's own message when it exits non-zero.
 * @param {string} file executable path.
 * @param {readonly string[]} args arguments.
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, maxBuffer?: number, what?: string}} [options]
 * @returns {Promise<{stdout: string, stderr: string, elapsedMs: number}>}
 */
export async function runChecked(file, args, options = {}) {
  const { what = file, ...rest } = options
  const result = await runProcess(file, args, rest)
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim()
    const tail = detail.length > 4000 ? `…${detail.slice(-4000)}` : detail
    throw new ProcessError(
      `${what} failed (exit ${result.code ?? result.signal ?? 'unknown'})${tail ? `:\n${tail}` : ''}`,
      { file, ...result },
    )
  }
  return result
}
