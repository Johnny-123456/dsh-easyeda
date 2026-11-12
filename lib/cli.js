import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Install locations tried when the plugin config names no executable. */
const CANDIDATES = [
  'D:/APP/lceda-pro/lceda-pro.exe',
  'C:/Program Files/lceda-pro/lceda-pro.exe',
  'C:/Program Files/EasyEDA Pro/easyeda-pro.exe',
  'D:/APP/easyeda-pro/easyeda-pro.exe',
]

/** Raised for a CLI envelope with `ok: false`, keeping the CLI error code. */
export class EdaCliError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'EdaCliError'
    this.code = code
    this.detail = detail
  }
}

/** Resolve the client executable once, preferring an explicit config value. */
export function resolveExecutable(configured) {
  const explicit = typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : undefined
  if (explicit !== undefined) {
    if (existsSync(explicit)) return { path: explicit, source: 'config' }
    return { path: explicit, source: 'config-missing' }
  }
  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) return { path: candidate.replaceAll('/', '\\'), source: 'detected' }
  }
  return { path: 'lceda-pro', source: 'path' }
}

/** Spawn the client once and collect both streams. */
function spawnOnce(exe, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (cause) {
      reject(cause)
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (action) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action()
    }
    const timer = setTimeout(() => {
      finish(() => {
        try { child.kill() } catch { /* already gone */ }
        reject(new EdaCliError('CLI_TIMEOUT', `EasyEDA CLI did not answer within ${timeoutMs} ms (command: ${args[0]}).`))
      })
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (cause) => {
      finish(() => {
        const hint = cause && cause.code === 'ENOENT'
          ? `Cannot start "${exe}". Set the client path in this plugin's config (executable), or install the EasyEDA Pro desktop client v4.1.70+.`
          : `Cannot start "${exe}": ${cause && cause.message ? cause.message : String(cause)}`
        reject(new EdaCliError('SPAWN_FAILED', hint))
      })
    })
    child.on('close', (code) => {
      finish(() => resolve({ code, stdout, stderr }))
    })
  })
}

/** Extract the JSON envelope from output that may carry leading banners or trailing hints. */
function parseEnvelope(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/** Thin client over the EasyEDA Pro command-line interface. */
export function createCli(config = {}) {
  const resolved = resolveExecutable(config.executable)
  const baseTimeout = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 120_000

  /** Run one command and return the envelope value, or throw its error. */
  async function run(args, timeoutMs = baseTimeout) {
    const { code, stdout, stderr } = await spawnOnce(resolved.path, args, timeoutMs)
    const envelope = parseEnvelope(stdout) ?? parseEnvelope(stderr)
    if (envelope === undefined) {
      const detail = (stderr || stdout || '').trim()
      if (code !== 0) {
        throw new EdaCliError('CLI_EXIT', detail === '' ? `EasyEDA CLI exited with code ${code}.` : detail)
      }
      throw new EdaCliError('CLI_EMPTY', `EasyEDA CLI returned no JSON envelope for "${args.join(' ')}".`)
    }
    if (envelope.ok !== true) {
      const error = envelope.error ?? {}
      const message = typeof error.message === 'string' && error.message !== ''
        ? error.message
        : (stderr || stdout || '').trim() || 'EasyEDA CLI reported a failure.'
      throw new EdaCliError(typeof error.code === 'string' ? error.code : 'CLI_ERROR', message, error)
    }
    return envelope.value
  }

  return {
    executable: resolved,

    run,

    /** Client identity and bridge connectivity. */
    doctor() {
      return run(['doctor'], Math.min(baseTimeout, 30_000))
    },

    /** Every session the bridge knows, including closed ones. */
    listSessions() {
      return run(['session', 'list'], Math.min(baseTimeout, 30_000))
    },

    /** Open a project (or a bare editor) and return its session id. */
    openProject(path, headless) {
      const args = ['open']
      if (typeof path === 'string' && path !== '') args.push('--path', path)
      args.push('--headless', headless === false ? 'false' : 'true')
      return run(args, Math.max(baseTimeout, 180_000))
    },

    closeSession(sessionId, destroy = false) {
      const args = ['session', 'close', '--session', sessionId]
      if (destroy) args.push('--destroy')
      return run(args, Math.min(baseTimeout, 60_000))
    },

    /**
     * Run a script inside one editor session.
     * The script is shipped through a temp file so it never meets the Windows
     * command-line length limit.
     */
    async invoke({ sessionId, code, args, elevated = true, timeoutMs = 60_000 }) {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-easyeda-'))
      const file = join(dir, 'script.js')
      await writeFile(file, code, 'utf8')
      const cliArgs = ['invoke', '--session', sessionId, '--code-file', file, '--timeout', String(timeoutMs)]
      if (elevated) cliArgs.push('--ext-uuid', 'eda')
      if (args !== undefined) cliArgs.push('--args', JSON.stringify(args))
      try {
        return await run(cliArgs, timeoutMs + 30_000)
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    },

    /** Read a script file relative to the caller's path, for pass-through runs. */
    async readScriptFile(path) {
      return readFile(path, 'utf8')
    },

    /** Internal editor API reference served by the client itself. */
    documentation(args) {
      return run(['doc', ...args], Math.min(baseTimeout, 60_000))
    },
  }
}

/** Pick the session a command should target. */
export async function resolveSession(cli, requested, config = {}) {
  const sessions = await cli.listSessions()
  const list = Array.isArray(sessions) ? sessions : []
  const alive = list.filter((s) => s && s.status === 'alive')
  const wanted = (typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : undefined)
    ?? (typeof config.defaultSession === 'string' && config.defaultSession.trim() !== '' ? config.defaultSession.trim() : undefined)

  if (wanted !== undefined) {
    const match = list.find((s) => s.sessionId === wanted)
      ?? list.find((s) => s.sessionId.startsWith(wanted))
    if (match === undefined) {
      throw new EdaCliError('SESSION_NOT_FOUND', `No editor session "${wanted}". Open a project first; see eda_status for the sessions that exist.`)
    }
    if (match.status !== 'alive') {
      throw new EdaCliError('SESSION_CLOSED', `Session "${match.sessionId}" is ${match.status}. Reopen the project before running this command.`)
    }
    return match
  }

  if (alive.length === 1) return alive[0]
  if (alive.length === 0) {
    const hint = typeof config.defaultProject === 'string' && config.defaultProject !== ''
      ? ` Call eda_status with project "${config.defaultProject}" to open it.`
      : ''
    throw new EdaCliError(
      'NO_SESSION',
      `No EasyEDA editor session is open. Start the EasyEDA Pro desktop client, or pass a project path to eda_status to open one there.${hint}`,
    )
  }
  const labels = alive.map((s) => `${s.sessionId} (${s.title ?? s.path ?? 'untitled'})`).join('; ')
  throw new EdaCliError('SESSION_AMBIGUOUS', `Several editor sessions are open: ${labels}. Pass session to choose one.`)
}
