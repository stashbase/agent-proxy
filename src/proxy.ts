import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import { createSecureContext, TLSSocket } from 'node:tls'
import { createCertificateAuthority } from './certificates'
import type {
  AgentProxyBinding,
  AgentProxyError,
  AgentProxyErrorCode,
  LocalAgentProxy,
  StartLocalAgentProxyOptions,
} from './types'

type ResolvedOptions = Omit<StartLocalAgentProxyOptions, 'bindings'> & {
  bindings: Record<string, AgentProxyBinding & { header: string; valueTemplate: string }>
}

function error(code: AgentProxyErrorCode): AgentProxyError {
  const message: Record<AgentProxyErrorCode, string> = {
    'proxy.host_denied': 'Agent Proxy policy denied destination',
    'proxy.unknown_placeholder': 'Agent Proxy did not recognize the credential placeholder',
    'proxy.credential_host_denied': 'Agent Proxy policy denied credential for destination',
    'proxy.request_invalid': 'Agent Proxy received an invalid request',
    'proxy.session_expired': 'Agent Proxy session has expired',
  }
  return { error: { code, message: message[code] } }
}

function writeError(
  response: ServerResponse | Socket | TLSSocket,
  code: AgentProxyErrorCode
): void {
  const body = JSON.stringify(error(code))
  if ('writeHead' in response) {
    response.writeHead(403, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    })
    response.end(body)
    return
  }
  response.end(
    `HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`
  )
}

function matchesHost(host: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const normalized = pattern.toLowerCase()
    return (
      normalized === '*' ||
      normalized === host ||
      (normalized.startsWith('*.') && host.endsWith(normalized.slice(1)))
    )
  })
}

function parseAuthority(value: string): { host: string; port: number } | undefined {
  try {
    const url = new URL(`http://${value}`)
    return url.hostname
      ? { host: url.hostname.toLowerCase(), port: Number(url.port || 443) }
      : undefined
  } catch {
    return undefined
  }
}

function canInspect(host: string, options: ResolvedOptions): boolean {
  return (
    matchesHost(host, options.egressHosts) ||
    Object.values(options.bindings).some((binding) => matchesHost(host, binding.hosts))
  )
}

function isDenied(host: string, options: ResolvedOptions): boolean {
  return matchesHost(host, options.denyHosts ?? [])
}

function isEgressAllowed(host: string, options: ResolvedOptions): boolean {
  return !isDenied(host, options) && matchesHost(host, options.egressHosts)
}

function validateOptions(options: StartLocalAgentProxyOptions): void {
  for (const [name, binding] of Object.entries(options.bindings)) {
    if (!binding.valueTemplate?.includes('{secret}') || !binding.header?.trim()) {
      throw new Error('Agent Proxy received an invalid binding configuration')
    }
  }
}

/**
 * Starts an in-process localhost TLS interception proxy. It reduces accidental
 * secret exposure, but does not isolate against malicious same-user code that
 * can inspect the Node process or its memory.
 */
export async function startLocalAgentProxy<
  const Bindings extends Record<string, AgentProxyBinding>,
>(
  options: Omit<StartLocalAgentProxyOptions, 'bindings'> & { bindings: Bindings }
): Promise<LocalAgentProxy<Extract<keyof Bindings, string>>> {
  const bindings = Object.fromEntries(
    Object.entries(options.bindings).map(([name, binding]) => {
      const header = binding.header ?? 'authorization'
      return [
        name,
        {
          ...binding,
          header,
          valueTemplate:
            binding.valueTemplate ??
            (header.toLowerCase() === 'authorization' ? 'Bearer {secret}' : '{secret}'),
        },
      ]
    })
  ) as ResolvedOptions['bindings']
  const normalizedOptions: ResolvedOptions = { ...options, bindings }
  validateOptions(normalizedOptions)
  for (const name of Object.keys(normalizedOptions.bindings)) {
    if (!normalizedOptions.bindings[name].secret)
      throw new Error(`Agent Proxy binding ${name} does not have a secret value`)
  }
  const resolvedOptions: ResolvedOptions = normalizedOptions
  const authority = await createCertificateAuthority()
  const placeholders = Object.fromEntries(
    Object.keys(resolvedOptions.bindings).map((name) => [name, `\${STASHBASE_${name}}`])
  ) as LocalAgentProxy<Extract<keyof Bindings, string>>['placeholders']
  const childEnv: Record<string, string> = {
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    NODE_EXTRA_CA_CERTS: authority.caPath,
    NODE_USE_ENV_PROXY: '1',
    NO_PROXY: '',
    no_proxy: '',
    ALL_PROXY: '',
    all_proxy: '',
    npm_config_proxy: '',
    npm_config_https_proxy: '',
  }
  for (const [name, binding] of Object.entries(resolvedOptions.bindings))
    if (binding.env) childEnv[binding.env] = placeholders[name]
  const sockets = new Set<Socket>()
  let stopped = false
  const server = createHttpServer((request, response) =>
    handlePlainRequest(request, response, resolvedOptions)
  )
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('connect', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const target = parseAuthority(request.url ?? '')
    if (
      !target ||
      isDenied(target.host, resolvedOptions) ||
      !canInspect(target.host, resolvedOptions)
    )
      return writeError(socket, 'proxy.host_denied')
    const leaf = authority.createLeaf(target.host)
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) socket.unshift(head)
    const tlsSocket = new TLSSocket(socket, {
      isServer: true,
      secureContext: createSecureContext(leaf),
    })
    tlsSocket.once('secure', () =>
      handleTlsRequest(tlsSocket, target.host, target.port, resolvedOptions, placeholders)
    )
    tlsSocket.on('error', () => tlsSocket.destroy())
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
    throw new Error('Agent Proxy did not receive a TCP address')
  const url = `http://127.0.0.1:${address.port}`
  childEnv.HTTP_PROXY = url
  childEnv.HTTPS_PROXY = url
  return {
    url,
    caPath: authority.caPath,
    placeholders,
    childEnv,
    async stop() {
      if (stopped) return
      stopped = true
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await authority.cleanup()
    },
  }
}

function handleTlsRequest(
  socket: TLSSocket,
  host: string,
  port: number,
  options: ResolvedOptions,
  placeholders: Record<string, string>
): void {
  const server = createHttpServer((request, response) => {
    if (isDenied(host, options)) return writeError(response, 'proxy.host_denied')
    const credential = injectCredential(request, host, options, placeholders)
    if (credential) return writeError(response, credential)
    if (
      !isEgressAllowed(host, options) &&
      !hasAuthorizedCredential(request, host, options, placeholders)
    )
      return writeError(response, 'proxy.host_denied')
    forwardHttps(request, response, host, port)
  })
  server.emit('connection', socket)
}

function injectCredential(
  request: IncomingMessage,
  host: string,
  options: ResolvedOptions,
  placeholders: Record<string, string>
): AgentProxyErrorCode | undefined {
  for (const [name, placeholder] of Object.entries(placeholders)) {
    const binding = options.bindings[name]
    const header = binding.header.toLowerCase()
    const expected = binding.valueTemplate.replace('{secret}', placeholder)
    const value = request.headers[header]
    if (value !== expected) continue
    if (isDenied(host, options) || !matchesHost(host, binding.hosts))
      return 'proxy.credential_host_denied'
    request.headers[header] = binding.valueTemplate.replace('{secret}', binding.secret)
    return undefined
  }
  for (const value of Object.values(request.headers))
    if (typeof value === 'string' && value.includes('${STASHBASE_'))
      return 'proxy.unknown_placeholder'
  return undefined
}

function hasAuthorizedCredential(
  request: IncomingMessage,
  host: string,
  options: ResolvedOptions,
  placeholders: Record<string, string>
): boolean {
  return Object.entries(placeholders).some(
    ([name, placeholder]) =>
      request.headers[options.bindings[name].header.toLowerCase()] ===
        options.bindings[name].valueTemplate.replace('{secret}', options.bindings[name].secret) &&
      matchesHost(host, options.bindings[name].hosts)
  )
}

function handlePlainRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ResolvedOptions
): void {
  let destination: URL
  try {
    destination = new URL(request.url ?? '')
  } catch {
    return writeError(response, 'proxy.request_invalid')
  }
  if (destination.protocol !== 'http:' || !isEgressAllowed(destination.hostname, options))
    return writeError(response, 'proxy.host_denied')
  const upstream = httpRequest(
    destination,
    { method: request.method, headers: request.headers },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    }
  )
  upstream.on('error', () => response.end())
  request.pipe(upstream)
}

function forwardHttps(
  request: IncomingMessage,
  response: ServerResponse,
  host: string,
  port: number
): void {
  const authority = port === 443 ? host : `${host}:${port}`
  const upstream = httpsRequest(
    {
      hostname: host,
      port,
      method: request.method,
      path: request.url,
      // CONNECT authority is the approved destination; do not trust an inconsistent Host header.
      headers: { ...request.headers, host: authority },
    },
    (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        upstreamResponse.headers
      )
      upstreamResponse.pipe(response)
    }
  )
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { connection: 'close' })
    response.end()
  })
  request.pipe(upstream)
}
