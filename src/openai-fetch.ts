import OpenAI from 'openai'
import { readFileSync } from 'node:fs'
import { Agent, request as httpsRequest } from 'node:https'
import { connect } from 'node:net'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { connect as tlsConnect } from 'node:tls'
import type {
  CreateOpenAIProxyClientOptions,
  AgentProxyTransport,
  OpenAIClientConstructor,
} from './types'

/** Explicit HTTPS-proxy fetch for clients that do not honor environment proxy variables. */
export function createOpenAIProxyFetch(proxy: AgentProxyTransport): typeof fetch {
  const ca = readFileSync(proxy.caPath)
  const proxyUrl = new URL(proxy.url)

  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.protocol !== 'https:') {
      throw new TypeError('Agent Proxy fetch only supports HTTPS URLs')
    }

    const socket = await openTunnel(
      proxyUrl,
      url.hostname,
      Number(url.port || 443),
      ca,
      request.signal
    )

    return new Promise<Response>((resolve, reject) => {
      const agent = new Agent({ keepAlive: false })
      agent.createConnection = () => socket
      const upstream = httpsRequest(
        {
          hostname: url.hostname,
          port: Number(url.port || 443),
          method: request.method,
          path: `${url.pathname}${url.search}`,
          headers: Object.fromEntries(request.headers),
          agent,
        },
        (response) => {
          resolve(
            new Response(Readable.toWeb(response) as ReadableStream, {
              status: response.statusCode,
              statusText: response.statusMessage,
              headers: response.headers as HeadersInit,
            })
          )
        }
      )
      upstream.once('error', reject)

      const abort = () => upstream.destroy(abortError())
      if (request.signal.aborted) {
        abort()
      } else {
        request.signal.addEventListener('abort', abort, { once: true })
      }
      upstream.once('close', () => request.signal.removeEventListener('abort', abort))

      if (request.body) {
        Readable.fromWeb(request.body as unknown as NodeReadableStream).pipe(upstream)
      } else {
        upstream.end()
      }
    })
  }
}

/** Creates the official OpenAI TypeScript client without disclosing a real key to it. */
export function createOpenAIProxyClient(
  openai: OpenAI | OpenAIClientConstructor,
  options: CreateOpenAIProxyClientOptions
): OpenAI {
  if (typeof openai !== 'function') {
    // Trusted application code may deliberately configure its own API key. Preserve it;
    // only the transport is changed. Agent/third-party code should use a placeholder instead.
    return openai.withOptions({ fetch: createOpenAIProxyFetch(options.proxy) })
  }
  const binding = options.apiKeyBinding ?? 'OPENAI_API_KEY'
  const apiKey = options.proxy.placeholders[binding]
  if (!apiKey) {
    throw new Error(`Agent Proxy does not expose the ${binding} placeholder`)
  }

  return new openai({ apiKey, fetch: createOpenAIProxyFetch(options.proxy) })
}

function openTunnel(
  proxyUrl: URL,
  host: string,
  port: number,
  ca: Buffer,
  signal?: AbortSignal
): Promise<ReturnType<typeof tlsConnect>> {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(proxyUrl.port), proxyUrl.hostname)
    let tlsSocket: ReturnType<typeof tlsConnect> | undefined
    let settled = false

    function cleanup() {
      signal?.removeEventListener('abort', abort)
    }

    function rejectOnce(cause: Error) {
      if (settled) return

      settled = true
      cleanup()
      reject(cause)
    }

    function resolveOnce(secureSocket: ReturnType<typeof tlsConnect>) {
      if (settled) return

      settled = true
      cleanup()
      resolve(secureSocket)
    }

    function abort() {
      const cause = abortError()
      const activeSocket = tlsSocket ?? socket
      activeSocket.destroy(cause)
      rejectOnce(cause)
    }

    socket.once('error', rejectOnce)
    socket.once('connect', () =>
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
    )

    if (signal?.aborted) {
      abort()
      return
    }

    signal?.addEventListener('abort', abort, { once: true })
    let response = ''

    socket.on('data', (chunk) => {
      if (settled) return

      response += chunk.toString('latin1')

      if (!response.includes('\r\n\r\n')) return

      if (!response.startsWith('HTTP/1.1 200')) {
        socket.destroy()
        return rejectOnce(new Error(`Agent Proxy denied CONNECT to ${host}`))
      }

      socket.removeAllListeners('data')
      tlsSocket = tlsConnect({ socket, servername: host, ca })
      tlsSocket.once('secureConnect', () => resolveOnce(tlsSocket!))
      tlsSocket.once('error', rejectOnce)
    })
  })
}

function abortError(): DOMException {
  return new DOMException('The request was aborted', 'AbortError')
}
