import { spawn, spawnSync } from 'node:child_process'
import type {
  LocalAgentProxy,
  SandboxedToolExecutor,
  SandboxedToolExportName,
  SandboxedToolModule,
  SandboxedToolModuleOptions,
  SandboxedToolOptions,
} from './types'

type WorkerReply = { ok: true; value: unknown } | { ok: false; message: string }

const inheritedEnvironmentAllowList = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SystemRoot',
  'ComSpec',
]

let linuxSandboxAvailable = false

// Kept inline so both ESM and CommonJS package consumers can launch the same
// worker without relying on a sibling asset path at runtime.
const workerProgram = String.raw`
process.once('message', async (message) => {
  try {
    const module = await import(message.module)
    const execute = module[message.exportName]
    if (typeof execute !== 'function')
      throw new Error('Tool module does not export a function named ' + message.exportName)
    const value = await execute(message.input)
    JSON.stringify(value)
    process.send?.({ ok: true, value })
  } catch (cause) {
    process.send?.({ ok: false, message: cause instanceof Error ? cause.message : 'Tool worker failed' })
  }
})
`

/**
 * Creates an executor suitable for an OpenAI Agents SDK `tool({ execute })` callback.
 * Each invocation gets a fresh Node process, placeholders, and proxy configuration;
 * Stashbase secret values remain in the parent-owned local proxy.
 */
export function createSandboxedToolExecutor(options: SandboxedToolOptions): SandboxedToolExecutor {
  return {
    execute: (input) => runSandboxedTool(options, input),
  }
}

/**
 * Configures one sandboxed tool module and exposes explicitly selected exports.
 * Each executor invocation still starts a fresh isolated worker process.
 */
export function createSandboxedToolModule<
  Exports extends object = Record<string, (...args: any[]) => unknown>,
>(
  options: SandboxedToolModuleOptions
): SandboxedToolModule<Exports> {
  const moduleOptions = { ...options }

  return {
    export<Name extends SandboxedToolExportName<Exports>>(exportName: Name) {
      if (!exportName.trim()) {
        throw new Error('Sandboxed tool export name must not be empty')
      }

      return createSandboxedToolExecutor({ ...moduleOptions, exportName })
    },
  }
}

/** Runs a single exported tool function in an isolated Node child process. */
export function runSandboxedTool<Input, Output = unknown>(
  options: SandboxedToolOptions,
  input: Input
): Promise<Output> {
  const module = normalizeModule(options.module)

  if (options.sandbox === true && process.platform === 'linux') {
    assertLinuxSandboxAvailable()
  }

  const { command, args } = sandboxCommand(options.proxy, options.sandbox === true)
  const child = spawn(command, [...args, '-e', workerProgram], {
    env: childEnvironment(options.proxy, options.env),
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const timeoutMs = options.timeoutMs ?? 30_000

  return new Promise<Output>((resolve, reject) => {
    let settled = false
    let stderr = ''

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback()
    }

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      finish(() => reject(new Error(`Sandboxed tool timed out after ${timeoutMs}ms`)))
    }, timeoutMs)

    child.once('error', (cause) => finish(() => reject(cause)))
    child.once('exit', (code, signal) => {
      if (!settled) {
        const detail = stderr.trim()
        const suffix = detail ? `: ${detail}` : ''

        finish(() =>
          reject(
            new Error(
              `Sandboxed tool exited before returning a result (${signal ?? code ?? 1})${suffix}`
            )
          )
        )
      }
    })

    child.on('message', (reply: WorkerReply) => {
      if (reply.ok) {
        finish(() => resolve(reply.value as Output))
      } else {
        finish(() => reject(new Error(`Sandboxed tool failed: ${reply.message}`)))
      }
    })

    child.send({ module, exportName: options.exportName ?? 'default', input })
  })
}

function normalizeModule(module: URL | string): string {
  if (module instanceof URL) return module.href
  if (module.startsWith('file:')) return module

  if (!module.startsWith('/')) {
    throw new Error('Sandboxed tool module must be an absolute path or file URL')
  }

  return new URL(`file://${module}`).href
}

function childEnvironment(proxy: LocalAgentProxy, extra: Record<string, string> | undefined) {
  const safeRuntimeEnvironment = Object.fromEntries(
    inheritedEnvironmentAllowList.flatMap((name) => {
      const value = process.env[name]
      return value === undefined ? [] : [[name, value]]
    })
  )

  // Do not inherit the parent's arbitrary environment: it may contain unrelated
  // provider credentials. The proxy adds only its placeholders and transport vars.
  // Proxy transport settings and placeholders must win over user-provided
  // tool environment values so a caller cannot accidentally bypass the proxy
  // or replace a placeholder with a credential.
  return { ...safeRuntimeEnvironment, ...extra, ...proxy.childEnv }
}

function assertLinuxSandboxAvailable(): void {
  if (linuxSandboxAvailable) return

  const probe = spawnSync(
    'systemd-run',
    ['--user', '--scope', '--quiet', process.execPath, '-e', ''],
    { encoding: 'utf8', timeout: 5_000 }
  )

  if (probe.status === 0) {
    linuxSandboxAvailable = true
    return
  }

  const detail = [probe.error?.message, probe.stderr?.trim()].filter(Boolean).join(': ')
  throw new Error(
    `Linux sandbox requires a running systemd user manager accessible to this process${detail ? ` (${detail})` : ''}. ` +
      'It is not supported in Docker, ECS/Fargate, or other environments without one.'
  )
}

export function sandboxCommand(
  proxy: LocalAgentProxy,
  sandbox: boolean,
  platform = process.platform
): { command: string; args: string[] } {
  if (!sandbox) return { command: process.execPath, args: [] }

  const proxyUrl = new URL(proxy.url)
  if (proxyUrl.hostname !== '127.0.0.1' || !proxyUrl.port) {
    throw new Error('Sandboxed tool requires a localhost Agent Proxy URL')
  }

  if (platform === 'darwin') {
    const profile = `
      (version 1)
      (allow default)
      (deny network-inbound)
      (deny network-outbound)
      (allow network-outbound (remote ip "localhost:${proxyUrl.port}"))
    `
    return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, process.execPath] }
  }

  if (platform === 'linux') {
    return {
      command: 'systemd-run',
      args: [
        '--user',
        '--scope',
        '--quiet',
        '--property=IPAddressDeny=any',
        '--property=IPAddressAllow=127.0.0.1',
        '--property=IPAddressAllow=::1',
        '--',
        process.execPath,
      ],
    }
  }

  throw new Error('Sandboxed tools are currently supported on macOS and systemd-based Linux')
}
