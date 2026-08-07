import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { connect, type Socket } from 'node:net'
import { connect as connectTls, type ConnectionOptions, type TLSSocket } from 'node:tls'
import { createHash } from 'node:crypto'
import type OpenAI from 'openai'
import { createAnthropicProxyClient } from './anthropic'
import { createOpenAIProxyClient } from './openai-fetch'
import { createVercelAIProxyFetch } from './vercel-ai'
import type {
  CreateAnthropicProxyClientOptions,
  CreateOpenAIProxyClientOptions,
  FetchConfigurableClient,
  AgentProxyTransport,
  OpenAIClientConstructor,
  RemoteAgentProxyBinding,
  RemoteAgentProxyHooks,
  RemoteAgentProxyOptions,
  RemoteAgentProxyRelayErrorEvent,
  RemoteAgentProxySessionRefreshEvent,
  RemoteAgentProxyStartError,
  RemoteAgentProxyStartResult,
  RemoteAgentProxyStopResult,
} from './types'

declare const __AGENT_PROXY_VERSION__: string

type RemoteSession = {
  session_id: string
  session_token: string
  expires_at: string
  proxy_url: string
  protocol: string
  proxy_ca?: { key_id: string; sha256: string; pem: string }
}

type ResolvedBinding = RemoteAgentProxyBinding & {
  from: string
  header: string
  placeholder: string
  valueTemplate: string
}

type ActiveRemoteProxy<Names extends string> = AgentProxyTransport<Names> & {
  stop(): Promise<RemoteAgentProxyStopResult>
}

const CONTROL_PLANE_TIMEOUT_MS = 10_000
const RELAY_TIMEOUT_MS = 15_000
const USER_AGENT = `stashbase/agent-proxy/${__AGENT_PROXY_VERSION__}`

class RemoteProxyStartupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number | null = null,
    readonly details?: unknown
  ) {
    super(message)
  }
}

function resolveBindings(
  bindings: Record<string, RemoteAgentProxyBinding>
): Record<string, ResolvedBinding> {
  return Object.fromEntries(
    Object.entries(bindings).map(([name, binding]) => {
      const header = binding.header ?? 'authorization'
      const valueTemplate =
        binding.valueTemplate ??
        (header.toLowerCase() === 'authorization' ? 'Bearer {secret}' : '{secret}')
      if (!binding.hosts.length || !header.trim() || !valueTemplate.includes('{secret}')) {
        throw new Error(`Remote Agent Proxy binding ${name} is invalid`)
      }
      return [
        name,
        {
          ...binding,
          from: binding.from ?? name,
          header,
          placeholder: binding.placeholder ?? `\${STASHBASE_${name}}`,
          valueTemplate,
        },
      ]
    })
  )
}

async function createRemoteProxy<Bindings extends Record<string, RemoteAgentProxyBinding>>(
  options: Omit<RemoteAgentProxyOptions, 'bindings'> & { bindings: Bindings }
): Promise<ActiveRemoteProxy<Extract<keyof Bindings, string>>> {
  const bindings = resolveBindings(options.bindings)
  const apiUrl = (options.apiUrl ?? 'https://api.stashbase.dev').replace(/\/$/, '')
  const session = await requestSession(options, bindings, apiUrl)
  const sockets = new Set<Socket>()
  const upstreamRequests = new Set<ReturnType<typeof requestToRemote>>()
  let directory: string | undefined
  let caPath: string | undefined
  let server: ReturnType<typeof createHttpServer> | undefined

  try {
    const proxyCa = session.proxy_ca!
    const currentCaPath = options.caFilePath
      ? resolve(options.caFilePath)
      : join((directory = await mkdtemp(join(tmpdir(), 'stashbase-remote-agent-proxy-'))), 'ca.pem')
    caPath = currentCaPath
    if (options.caFilePath) await mkdir(dirname(currentCaPath), { recursive: true })
    await writeFile(currentCaPath, proxyCa.pem, { mode: 0o600 })
    await chmod(currentCaPath, 0o600)

    const remoteUrl = new URL(session.proxy_url, apiUrl)
    const transportIdentity = `${remoteUrl.href}\n${proxyCa.sha256.toLowerCase()}`
    let stopped = false
    server = createHttpServer((request, response) => {
      const upstream = requestToRemote(
        remoteUrl,
        currentCaPath,
        () => session.session_token,
        request
      )
      upstreamRequests.add(upstream)
      upstream.once('close', () => upstreamRequests.delete(upstream))
      upstream.once('error', (error) => {
        emitRelayError(options.hooks, {
          kind: 'request',
          host: relayHost(request),
          error: relayError(error),
        })
        if (!response.headersSent) response.writeHead(502)
        response.end()
      })
      upstream.once('response', (remoteResponse) => {
        response.writeHead(remoteResponse.statusCode ?? 502, remoteResponse.headers)
        remoteResponse.pipe(response)
      })
      request.pipe(upstream)
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    server.on('connect', (request, socket, head) => {
      const target = request.url
      if (!target || /[/?#@]/.test(target)) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
        return
      }
      void openRemoteConnection(remoteUrl, currentCaPath)
        .then((upstream) => {
          let connectTimeout: ReturnType<typeof setTimeout> | undefined
          sockets.add(upstream)
          upstream.once('close', () => sockets.delete(upstream))
          upstream.once('error', (error) => {
            if (connectTimeout) clearTimeout(connectTimeout)
            emitRelayError(options.hooks, {
              kind: 'connect',
              host: hostFromAuthority(target),
              error: relayError(error),
            })
            socket.destroy()
          })
          upstream.write(
            `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Bearer ${session.session_token}\r\n\r\n`
          )
          connectTimeout = setTimeout(() => {
            socket.end('HTTP/1.1 504 Gateway Timeout\r\n\r\n')
            upstream.destroy(relayTimeoutError('Remote Agent Proxy CONNECT timed out'))
          }, RELAY_TIMEOUT_MS)
          let response = Buffer.alloc(0)
          const receiveConnect = (chunk: Buffer) => {
            response = Buffer.concat([response, chunk])
            const end = response.indexOf('\r\n\r\n')
            if (end < 0) return
            upstream.off('data', receiveConnect)
            if (connectTimeout) clearTimeout(connectTimeout)
            const header = response.subarray(0, end + 4)
            const remaining = response.subarray(end + 4)
            if (!/^HTTP\/1\.[01] 200\b/.test(header.toString('latin1'))) {
              emitRelayError(options.hooks, {
                kind: 'connect',
                host: hostFromAuthority(target),
                error: {
                  code: 'remote.relay_rejected',
                  message: 'Remote Agent Proxy rejected the CONNECT request',
                },
              })
              socket.end(header)
              upstream.destroy()
              return
            }
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            if (head.length) upstream.write(head)
            if (remaining.length) socket.write(remaining)
            socket.pipe(upstream).pipe(socket)
          }
          upstream.on('data', receiveConnect)
        })
        .catch((error) => {
          emitRelayError(options.hooks, {
            kind: 'connect',
            host: hostFromAuthority(target),
            error: relayError(error),
          })
          socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        })
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', () => {
        server!.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Remote Agent Proxy did not receive a TCP address')
    const rotation = new AbortController()
    const rotationTask = rotateSessions(
      options,
      bindings,
      apiUrl,
      session,
      transportIdentity,
      rotation.signal
    )
    const url = `http://127.0.0.1:${address.port}`
    const placeholders = Object.fromEntries(
      Object.entries(bindings).map(([name, binding]) => [name, binding.placeholder])
    ) as ActiveRemoteProxy<Extract<keyof Bindings, string>>['placeholders']
    const childEnv: Record<string, string> = {
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
      http_proxy: url,
      https_proxy: url,
      NODE_EXTRA_CA_CERTS: currentCaPath,
      NODE_USE_ENV_PROXY: '1',
      NO_PROXY: '',
      no_proxy: '',
      ALL_PROXY: '',
      all_proxy: '',
      npm_config_proxy: '',
      npm_config_https_proxy: '',
      SSL_CERT_FILE: currentCaPath,
      CURL_CA_BUNDLE: currentCaPath,
      GIT_SSL_CAINFO: currentCaPath,
    }
    for (const [name, binding] of Object.entries(bindings))
      childEnv[binding.env ?? name] = placeholders[name]
    return {
      url,
      caPath: currentCaPath,
      placeholders,
      childEnv,
      async stop() {
        if (stopped) return { ok: true, data: null, error: null, status: null }
        stopped = true
        rotation.abort()
        await rotationTask
        let cleanupError: unknown
        try {
          for (const upstream of upstreamRequests) upstream.destroy()
          for (const socket of sockets) socket.destroy()
          server!.closeAllConnections()
          await new Promise<void>((resolve) => server!.close(() => resolve()))
          if (directory) await rm(directory, { recursive: true, force: true })
          else if (caPath) await rm(caPath, { force: true })
        } catch (error) {
          cleanupError = error
        }
        try {
          const response = await fetch(`${apiUrl}/v1/agent-proxy/sessions/current`, {
            method: 'DELETE',
            headers: {
              authorization: `Bearer ${options.apiKey}`,
              'x-stashbase-session': session.session_token,
              'x-stashbase-end-agent-run': 'true',
              'user-agent': USER_AGENT,
            },
            signal: AbortSignal.timeout(5_000),
          })
          if (response.ok) {
            return cleanupError
              ? remoteStopError(cleanupError)
              : { ok: true, data: null, error: null, status: response.status }
          }
          return remoteStopError(await responseError(response))
        } catch (error) {
          return remoteStopError(error)
        }
      },
    }
  } catch (error) {
    for (const upstream of upstreamRequests) upstream.destroy()
    for (const socket of sockets) socket.destroy()
    server?.closeAllConnections()
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()))
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
    else if (caPath) await rm(caPath, { force: true }).catch(() => {})
    await revokeSession(apiUrl, options.apiKey, session.session_token, true)
    throw error
  }
}

async function requestSession(
  options: RemoteAgentProxyOptions,
  bindings: Record<string, ResolvedBinding>,
  apiUrl: string,
  previousSessionToken?: string
): Promise<RemoteSession> {
  const signal = AbortSignal.timeout(CONTROL_PLANE_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`${apiUrl}/v1/agent-proxy/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
        ...(previousSessionToken ? { 'x-stashbase-previous-session': previousSessionToken } : {}),
      },
      body: JSON.stringify({
        project_id: options.project,
        environment_id: options.environment,
        egress_hosts: options.egressHosts,
        deny_hosts: options.denyHosts ?? [],
        bindings: Object.entries(bindings).map(([name, binding]) => ({
          name,
          from: binding.from,
          hosts: binding.hosts,
          header: binding.header,
          placeholder: binding.placeholder,
          value_template: binding.valueTemplate,
        })),
      }),
      signal,
    })
  } catch (error) {
    if (signal.aborted) {
      throw new RemoteProxyStartupError(
        'remote.session_request_timeout',
        'Remote Agent Proxy session request timed out'
      )
    }
    throw error
  }
  if (!response.ok) {
    const body = await response.text()
    let details: unknown = body || undefined
    let message = `Remote Agent Proxy session request failed (${response.status})`
    let code = 'remote.session_request_failed'
    try {
      const parsed = JSON.parse(body) as {
        error?: { code?: string; message?: string; details?: unknown }
      }
      details = parsed
      if (parsed.error?.code) code = parsed.error.code
      if (parsed.error?.message) message = parsed.error.message
    } catch {
      // Some gateways return plain text or an empty error response.
    }
    throw new RemoteProxyStartupError(code, message, response.status, details)
  }
  const session = (await response.json()) as RemoteSession
  if (
    !session.session_token ||
    !session.proxy_url ||
    session.protocol !== 'http/1.1-forward-proxy-tls-intercept' ||
    !session.proxy_ca?.pem
  ) {
    throw new RemoteProxyStartupError(
      'remote.session_invalid',
      'Remote Agent Proxy returned an unsupported session'
    )
  }
  const digest = createHash('sha256').update(session.proxy_ca.pem).digest('hex')
  if (digest !== session.proxy_ca.sha256.toLowerCase()) {
    throw new RemoteProxyStartupError(
      'remote.session_invalid',
      'Remote Agent Proxy returned a CA with an invalid SHA-256 digest'
    )
  }
  if (!Number.isFinite(Date.parse(session.expires_at))) {
    throw new RemoteProxyStartupError(
      'remote.session_invalid',
      'Remote Agent Proxy returned an invalid expiry'
    )
  }
  return session
}

async function rotateSessions(
  options: RemoteAgentProxyOptions,
  bindings: Record<string, ResolvedBinding>,
  apiUrl: string,
  initialSession: RemoteSession,
  transportIdentity: string,
  signal: AbortSignal
): Promise<void> {
  let current = initialSession
  while (!signal.aborted) {
    const expiresAt = Date.parse(current.expires_at)
    const remaining = Math.max(0, expiresAt - Date.now())
    const leadTime = Math.max(1_000, Math.min(120_000, Math.floor(remaining / 5)))
    try {
      await sleep(Math.max(1_000, remaining - leadTime), signal)
      const replacement = await requestSession(options, bindings, apiUrl, current.session_token)
      const replacementUrl = new URL(replacement.proxy_url, apiUrl)
      if (
        `${replacementUrl.href}\n${replacement.proxy_ca!.sha256.toLowerCase()}` !==
        transportIdentity
      ) {
        await revokeSession(apiUrl, options.apiKey, replacement.session_token)
        emitSessionRefresh(options.hooks, {
          state: 'failed',
          expiresAt: current.expires_at,
          retryInMs: 0,
          error: {
            code: 'remote.rotation_incompatible',
            message: 'Remote Agent Proxy changed its transport or CA during session rotation',
            status: null,
          },
        })
        return
      }
      const previousToken = current.session_token
      // JavaScript assignments are atomic: existing tunnels retain their old
      // connection, while each new relay request reads this latest token.
      current = replacement
      initialSession.session_token = replacement.session_token
      initialSession.expires_at = replacement.expires_at
      await fetch(`${apiUrl}/v1/agent-proxy/sessions/current/retire`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'x-stashbase-session': previousToken,
          'user-agent': USER_AGENT,
        },
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {})
      emitSessionRefresh(options.hooks, { state: 'succeeded', expiresAt: replacement.expires_at })
    } catch (error) {
      if (signal.aborted) return
      // The active session stays usable through its advertised expiry. Retrying
      // at most once per minute gives transient control-plane failures a chance
      // to recover without churning requests.
      const retryFor = Math.min(60_000, Math.max(0, expiresAt - Date.now()))
      const failure = remoteStartError(error)
      emitSessionRefresh(options.hooks, {
        state: 'failed',
        expiresAt: current.expires_at,
        retryInMs: retryFor,
        error: { ...failure.error, status: failure.status },
      })
      if (!retryFor) return
      try {
        await sleep(retryFor, signal)
      } catch {
        return
      }
    }
  }
}

function emitSessionRefresh(
  hooks: RemoteAgentProxyHooks | undefined,
  event: RemoteAgentProxySessionRefreshEvent
): void {
  if (!hooks?.onSessionRefresh) return
  void Promise.resolve()
    .then(() => hooks.onSessionRefresh!(Object.freeze({ ...event })))
    .catch(() => {})
}

function emitRelayError(
  hooks: RemoteAgentProxyHooks | undefined,
  event: RemoteAgentProxyRelayErrorEvent
): void {
  if (!hooks?.onRelayError) return
  void Promise.resolve()
    .then(() => hooks.onRelayError!(Object.freeze({ ...event })))
    .catch(() => {})
}

function relayError(error: unknown): { code: string; message: string } {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return {
      code: error.code,
      message: error instanceof Error ? error.message : 'Remote Agent Proxy relay failed',
    }
  }
  return {
    code: 'remote.relay_failed',
    message: error instanceof Error ? error.message : 'Remote Agent Proxy relay failed',
  }
}

function relayTimeoutError(message: string): Error & { code: 'ETIMEDOUT' } {
  return Object.assign(new Error(message), { code: 'ETIMEDOUT' as const })
}

function hostFromAuthority(authority: string): string | undefined {
  try {
    return new URL(`http://${authority}`).hostname || undefined
  } catch {
    return undefined
  }
}

function relayHost(request: IncomingMessage): string | undefined {
  try {
    return new URL(request.url ?? '').hostname || undefined
  } catch {
    return request.headers.host ? hostFromAuthority(request.headers.host) : undefined
  }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })
}

async function revokeSession(
  apiUrl: string,
  apiKey: string,
  token: string,
  endsAgentRun = false
): Promise<void> {
  await fetch(`${apiUrl}/v1/agent-proxy/sessions/current`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'x-stashbase-session': token,
      ...(endsAgentRun ? { 'x-stashbase-end-agent-run': 'true' } : {}),
      'user-agent': USER_AGENT,
    },
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {})
}

function requestToRemote(
  remoteUrl: URL,
  caPath: string,
  token: () => string,
  request: IncomingMessage
) {
  const requestOptions = {
    protocol: remoteUrl.protocol,
    hostname: remoteUrl.hostname,
    port: remoteUrl.port || undefined,
    method: request.method,
    path: request.url,
    headers: { ...request.headers, 'proxy-authorization': `Bearer ${token()}` },
    ...(remoteUrl.protocol === 'https:' ? { ca: readFileSync(caPath) } : {}),
  }
  const upstream = (remoteUrl.protocol === 'https:' ? httpsRequest : httpRequest)(requestOptions)
  upstream.setTimeout(RELAY_TIMEOUT_MS, () => {
    upstream.destroy(relayTimeoutError('Remote Agent Proxy did not respond in time'))
  })
  return upstream
}

function openRemoteConnection(remoteUrl: URL, caPath: string): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const port = Number(remoteUrl.port || (remoteUrl.protocol === 'https:' ? 443 : 80))
    const socket =
      remoteUrl.protocol === 'https:'
        ? connectTls({
            host: remoteUrl.hostname,
            port,
            ca: readFileSync(caPath),
          } as ConnectionOptions)
        : connect(port, remoteUrl.hostname)
    const timeout = setTimeout(() => {
      socket.destroy(relayTimeoutError('Remote Agent Proxy connection timed out'))
    }, RELAY_TIMEOUT_MS)
    const onError = (error: Error) => {
      clearTimeout(timeout)
      reject(error)
    }
    socket.once('error', onError)
    socket.once(remoteUrl.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      clearTimeout(timeout)
      socket.off('error', onError)
      resolve(socket)
    })
  })
}

/**
 * A Stashbase-managed, control-plane-backed proxy. It is intentionally
 * separate from `AgentProxy`: use that local constructor when all credentials
 * and policy enforcement should remain local, without a Stashbase API call.
 *
 * Construct this trusted parent-process object with an API key, project, and
 * environment, then call {@link start}. Agent code receives only placeholders,
 * a localhost relay URL, and the public remote-proxy CA. The CA is stored at a
 * temporary `ca.pem` path for child processes and removed on shutdown. Provide
 * {@link RemoteAgentProxyOptions.caFilePath} to choose that managed file path.
 */
export class RemoteAgentProxy<
  const Bindings extends Record<string, RemoteAgentProxyBinding> = Record<
    string,
    RemoteAgentProxyBinding
  >,
> implements AgentProxyTransport<Extract<keyof Bindings, string>> {
  #current?: ActiveRemoteProxy<Extract<keyof Bindings, string>>
  #last?: ActiveRemoteProxy<Extract<keyof Bindings, string>>
  #starting?: Promise<ActiveRemoteProxy<Extract<keyof Bindings, string>>>
  constructor(
    private readonly options: Omit<RemoteAgentProxyOptions, 'bindings'> & { bindings: Bindings }
  ) {}
  get started() {
    return this.#current !== undefined
  }
  get url() {
    return this.active().url
  }
  get caPath() {
    return this.active().caPath
  }
  get placeholders() {
    return this.active().placeholders
  }
  get childEnv() {
    return this.active().childEnv
  }
  createOpenAIClient(
    openai: OpenAI | OpenAIClientConstructor,
    options: Omit<CreateOpenAIProxyClientOptions, 'proxy'> = {}
  ): OpenAI {
    return createOpenAIProxyClient(openai, { ...options, proxy: this })
  }
  createAnthropicClient<Client extends FetchConfigurableClient<Client>>(anthropic: Client): Client {
    return createAnthropicProxyClient(anthropic, { proxy: this })
  }
  createVercelAIFetch(): typeof fetch {
    return createVercelAIProxyFetch(this)
  }
  /** Starts the session and returns a Node SDK-style success or failure result. */
  async start(): Promise<RemoteAgentProxyStartResult<this>> {
    if (this.#current) return { ok: true, data: this, error: null, status: null }
    if (!this.#starting) {
      this.#starting = createRemoteProxy(this.options).then((proxy) => {
        this.#current = proxy
        this.#last = proxy
        return proxy
      })
    }
    const starting = this.#starting
    try {
      await starting
      return { ok: true, data: this, error: null, status: null }
    } catch (error) {
      const failure = remoteStartError(error)
      return { ok: false, data: null, error: failure.error, status: failure.status }
    } finally {
      if (this.#starting === starting) this.#starting = undefined
    }
  }
  /** Starts the session and throws if startup fails. */
  async startOrThrow(): Promise<this> {
    const result = await this.start()
    if (result.ok) return result.data
    throw new RemoteProxyStartupError(
      result.error.code,
      result.error.message,
      result.status,
      result.error.details
    )
  }
  /** Stops the local relay, revokes the remote session, and marks the agent run ended. */
  async stop(): Promise<RemoteAgentProxyStopResult> {
    if (this.#starting) {
      try {
        await this.#starting
      } catch (error) {
        return remoteStopError(error)
      }
    }
    const proxy = this.#current
    this.#current = undefined
    return proxy ? await proxy.stop() : { ok: true, data: null, error: null, status: null }
  }
  private active() {
    const proxy = this.#current ?? this.#last
    if (!proxy) throw new Error('Remote Agent Proxy has not been started')
    return proxy
  }
}

/**
 * Starts a Stashbase-managed Remote Agent Proxy session immediately. Callers
 * who do not need remote secret resolution should use `startLocalAgentProxy`.
 */
export async function startRemoteAgentProxy<
  const Bindings extends Record<string, RemoteAgentProxyBinding>,
>(
  options: Omit<RemoteAgentProxyOptions, 'bindings'> & { bindings: Bindings }
): Promise<RemoteAgentProxyStartResult<RemoteAgentProxy<Bindings>>> {
  return new RemoteAgentProxy(options).start()
}

function remoteStartError(error: unknown): {
  error: RemoteAgentProxyStartError
  status: number | null
} {
  if (error instanceof RemoteProxyStartupError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
      status: error.status,
    }
  }
  return {
    error: {
      code: 'remote.start_failed',
      message: error instanceof Error ? error.message : 'Remote Agent Proxy failed to start',
    },
    status: null,
  }
}

async function responseError(response: Response): Promise<RemoteProxyStartupError> {
  const body = await response.text()
  let details: unknown = body || undefined
  let message = `Remote Agent Proxy session request failed (${response.status})`
  let code = 'remote.session_request_failed'
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } }
    details = parsed
    if (parsed.error?.code) code = parsed.error.code
    if (parsed.error?.message) message = parsed.error.message
  } catch {
    // Some gateways return plain text or an empty error response.
  }
  return new RemoteProxyStartupError(code, message, response.status, details)
}

function remoteStopError(error: unknown): RemoteAgentProxyStopResult {
  const failure = remoteStartError(error)
  return { ok: false, data: null, error: failure.error, status: failure.status }
}
