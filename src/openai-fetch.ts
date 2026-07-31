import OpenAI from 'openai'
import { readFileSync } from 'node:fs'
import { Agent, request as httpsRequest } from 'node:https'
import { connect } from 'node:net'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { connect as tlsConnect } from 'node:tls'
import type {
  CreateOpenAIProxyClientOptions,
  LocalAgentProxy,
  OpenAIClientConstructor,
} from './types'

/** Explicit HTTPS-proxy fetch for clients that do not honor environment proxy variables. */
export function createOpenAIProxyFetch(proxy: LocalAgentProxy): typeof fetch {
  const ca = readFileSync(proxy.caPath)
  const proxyUrl = new URL(proxy.url)

  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.protocol !== 'https:') {
      throw new TypeError('Agent Proxy fetch only supports HTTPS URLs')
    }

    const socket = await openTunnel(proxyUrl, url.hostname, Number(url.port || 443), ca)

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
  ca: Buffer
): Promise<ReturnType<typeof tlsConnect>> {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(proxyUrl.port), proxyUrl.hostname)

    socket.once('error', reject)
    socket.once('connect', () =>
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
    )
    let response = ''

    socket.on('data', (chunk) => {
      response += chunk.toString('latin1')

      if (!response.includes('\r\n\r\n')) return

      if (!response.startsWith('HTTP/1.1 200')) {
        return reject(new Error('Agent Proxy denied CONNECT'))
      }

      socket.removeAllListeners('data')
      const tlsSocket = tlsConnect({ socket, servername: host, ca })
      tlsSocket.once('secureConnect', () => resolve(tlsSocket))
      tlsSocket.once('error', reject)
    })
  })
}
