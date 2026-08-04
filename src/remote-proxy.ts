import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  LocalAgentProxy,
  OpenAIClientConstructor,
  RemoteAgentProxyBinding,
  RemoteAgentProxyOptions,
} from './types'

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

type ActiveRemoteProxy<Names extends string> = LocalAgentProxy<Names>

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
  let session = await requestSession(options, bindings, apiUrl)
  const proxyCa = session.proxy_ca!
  const directory = await mkdtemp(join(tmpdir(), 'stashbase-remote-agent-proxy-'))
  const caPath = join(directory, 'ca.pem')
  await writeFile(caPath, proxyCa.pem, { mode: 0o600 })

  const remoteUrl = new URL(session.proxy_url, apiUrl)
  const transportIdentity = `${remoteUrl.href}\n${proxyCa.sha256.toLowerCase()}`
  const rotation = new AbortController()
  const rotationTask = rotateSessions(options, bindings, apiUrl, session, transportIdentity, rotation.signal)
  const sockets = new Set<Socket>()
  let stopped = false
  const server = createHttpServer((request, response) => {
    const upstream = requestToRemote(remoteUrl, caPath, () => session.session_token, request)
    upstream.once('error', () => {
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
    void openRemoteConnection(remoteUrl, caPath)
      .then((upstream) => {
        sockets.add(upstream)
        upstream.once('close', () => sockets.delete(upstream))
        upstream.once('error', () => socket.destroy())
        upstream.write(
          `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Bearer ${session.session_token}\r\n\r\n`
        )
        let response = Buffer.alloc(0)
        const receiveConnect = (chunk: Buffer) => {
          response = Buffer.concat([response, chunk])
          const end = response.indexOf('\r\n\r\n')
          if (end < 0) return
          upstream.off('data', receiveConnect)
          const header = response.subarray(0, end + 4)
          const remaining = response.subarray(end + 4)
          if (!/^HTTP\/1\.[01] 200\b/.test(header.toString('latin1'))) {
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
      .catch(() => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Remote Agent Proxy did not receive a TCP address')
  const url = `http://127.0.0.1:${address.port}`
  const placeholders = Object.fromEntries(
    Object.entries(bindings).map(([name, binding]) => [name, binding.placeholder])
  ) as ActiveRemoteProxy<Extract<keyof Bindings, string>>['placeholders']
  const childEnv: Record<string, string> = {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NODE_EXTRA_CA_CERTS: caPath,
    NODE_USE_ENV_PROXY: '1',
    NO_PROXY: '',
    no_proxy: '',
    ALL_PROXY: '',
    all_proxy: '',
    npm_config_proxy: '',
    npm_config_https_proxy: '',
    SSL_CERT_FILE: caPath,
    CURL_CA_BUNDLE: caPath,
    GIT_SSL_CAINFO: caPath,
    CODEX_CA_CERTIFICATE: caPath,
  }
  for (const [name, binding] of Object.entries(bindings))
    childEnv[binding.env ?? name] = placeholders[name]
  return {
    url,
    caPath,
    placeholders,
    childEnv,
    async stop() {
      if (stopped) return
      stopped = true
      rotation.abort()
      await rotationTask
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
      await fetch(`${apiUrl}/v1/agent-proxy/sessions/current`, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'x-stashbase-session': session.session_token,
        },
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {})
    },
  }
}

async function requestSession(
  options: RemoteAgentProxyOptions,
  bindings: Record<string, ResolvedBinding>,
  apiUrl: string,
  previousSessionToken?: string
): Promise<RemoteSession> {
  const response = await fetch(`${apiUrl}/v1/agent-proxy/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      'content-type': 'application/json',
      ...(previousSessionToken ? { 'x-stashbase-previous-session': previousSessionToken } : {}),
    },
    body: JSON.stringify({
      project_id: options.project,
      environment_id: options.environment,
      egress_hosts: options.egressHosts,
      deny_hosts: options.denyHosts ?? [],
      bindings: Object.entries(bindings).map(([name, binding]) => ({
        name, from: binding.from, hosts: binding.hosts, header: binding.header,
        placeholder: binding.placeholder, value_template: binding.valueTemplate,
      })),
    }),
  })
  if (!response.ok) {
    const body = await response.text()
    let detail = body
    try {
      detail = JSON.stringify(JSON.parse(body))
    } catch {
      // Some gateways return plain text or an empty error response.
    }
    throw new Error(
      `Remote Agent Proxy session request failed (${response.status})${detail ? `: ${detail}` : ''}`
    )
  }
  const session = (await response.json()) as RemoteSession
  if (!session.session_token || !session.proxy_url || session.protocol !== 'http/1.1-forward-proxy-tls-intercept' || !session.proxy_ca?.pem) {
    throw new Error('Remote Agent Proxy returned an unsupported session')
  }
  const digest = createHash('sha256').update(session.proxy_ca.pem).digest('hex')
  if (digest !== session.proxy_ca.sha256.toLowerCase()) throw new Error('Remote Agent Proxy returned a CA with an invalid SHA-256 digest')
  if (!Number.isFinite(Date.parse(session.expires_at))) throw new Error('Remote Agent Proxy returned an invalid expiry')
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
      if (`${replacementUrl.href}\n${replacement.proxy_ca!.sha256.toLowerCase()}` !== transportIdentity) {
        await revokeSession(apiUrl, options.apiKey, replacement.session_token)
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
        headers: { authorization: `Bearer ${options.apiKey}`, 'x-stashbase-session': previousToken },
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {})
    } catch (error) {
      if (signal.aborted) return
      // The active session stays usable through its advertised expiry. Retrying
      // at most once per minute gives transient control-plane failures a chance
      // to recover without churning requests.
      const retryFor = Math.min(60_000, Math.max(0, expiresAt - Date.now()))
      if (!retryFor) return
      try { await sleep(retryFor, signal) } catch { return }
    }
  }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}

async function revokeSession(apiUrl: string, apiKey: string, token: string): Promise<void> {
  await fetch(`${apiUrl}/v1/agent-proxy/sessions/current`, {
    method: 'DELETE', headers: { authorization: `Bearer ${apiKey}`, 'x-stashbase-session': token }, signal: AbortSignal.timeout(5_000),
  }).catch(() => {})
}

function requestToRemote(remoteUrl: URL, caPath: string, token: () => string, request: IncomingMessage) {
  const requestOptions = {
    protocol: remoteUrl.protocol,
    hostname: remoteUrl.hostname,
    port: remoteUrl.port || undefined,
    method: request.method,
    path: request.url,
    headers: { ...request.headers, 'proxy-authorization': `Bearer ${token()}` },
    ...(remoteUrl.protocol === 'https:' ? { ca: readFileSync(caPath) } : {}),
  }
  return (remoteUrl.protocol === 'https:' ? httpsRequest : httpRequest)(requestOptions)
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
    socket.once('error', reject)
    socket.once(remoteUrl.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      socket.off('error', reject)
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
 * a localhost relay URL, and the public remote-proxy CA.
 */
export class RemoteAgentProxy<
  const Bindings extends Record<string, RemoteAgentProxyBinding> = Record<
    string,
    RemoteAgentProxyBinding
  >,
> implements LocalAgentProxy<Extract<keyof Bindings, string>> {
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
  async start(): Promise<this> {
    if (this.#current) return this
    if (!this.#starting)
      this.#starting = createRemoteProxy(this.options).then((proxy) => {
        this.#current = proxy
        this.#last = proxy
        return proxy
      })
    const starting = this.#starting
    try {
      await starting
    } finally {
      if (this.#starting === starting) this.#starting = undefined
    }
    return this
  }
  async stop(): Promise<void> {
    if (this.#starting) await this.#starting
    const proxy = this.#current
    this.#current = undefined
    await proxy?.stop()
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
): Promise<RemoteAgentProxy<Bindings>> {
  return new RemoteAgentProxy(options).start()
}
