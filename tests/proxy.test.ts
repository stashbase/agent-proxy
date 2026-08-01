import { access, readFile } from 'node:fs/promises'
import { createServer as createHttpsServer, globalAgent } from 'node:https'
import { connect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import forge from 'node-forge'
import {
  createOpenAIProxyFetch,
  startLocalAgentProxy,
  type AgentProxyBinding,
  type LocalAgentProxy,
} from '../src'

const proxies: LocalAgentProxy[] = []
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.stop()))
})

async function start(
  bindings: Record<string, AgentProxyBinding> = {
    OPENAI_API_KEY: {
      secret: 'real-secret-value',
      hosts: ['api.openai.com'],
    },
  }
) {
  const proxy = await startLocalAgentProxy({
    egressHosts: ['api.openai.com'],
    bindings,
  })
  proxies.push(proxy)
  return proxy
}

async function throughTls(
  proxy: LocalAgentProxy,
  request: string,
  destinationPort = 443,
  onData?: (chunk: string) => void
): Promise<string> {
  const { port } = new URL(proxy.url)
  const ca = await readFile(proxy.caPath)
  return new Promise((resolve, reject) => {
    const raw = connect(Number(port), '127.0.0.1')
    raw.once('error', reject)
    raw.once('connect', () =>
      raw.write(
        `CONNECT api.openai.com:${destinationPort} HTTP/1.1\r\nHost: api.openai.com:${destinationPort}\r\n\r\n`
      )
    )
    let connectResponse = ''
    raw.on('data', (chunk) => {
      connectResponse += chunk.toString('latin1')
      if (!connectResponse.includes('\r\n\r\n')) return
      if (!connectResponse.startsWith('HTTP/1.1 200')) return reject(new Error(connectResponse))
      raw.removeAllListeners('data')
      const secure = tlsConnect({ socket: raw, servername: 'api.openai.com', ca })
      secure.once('error', reject)
      secure.once('secureConnect', () => secure.write(request))
      let output = ''
      secure.on('data', (chunk) => {
        const value = chunk.toString()
        output += value
        onData?.(value)
      })
      secure.on('end', () => resolve(output))
    })
  })
}

function createTestCertificate(): { cert: string; key: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const certificate = forge.pki.createCertificate()
  certificate.publicKey = keys.publicKey
  certificate.serialNumber = '01'
  certificate.validity.notBefore = new Date(Date.now() - 60_000)
  certificate.validity.notAfter = new Date(Date.now() + 60_000)
  const subject = [{ name: 'commonName', value: 'api.openai.com' }]
  certificate.setSubject(subject)
  certificate.setIssuer(subject)
  certificate.setExtensions([
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'api.openai.com' }] },
  ])
  certificate.sign(keys.privateKey, forge.md.sha256.create())
  return {
    cert: forge.pki.certificateToPem(certificate),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  }
}

async function withLocalOpenAI(
  handler: Parameters<typeof createHttpsServer>[1],
  run: (port: number) => Promise<void>
): Promise<void> {
  const server = createHttpsServer(createTestCertificate(), handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test upstream address')
  const originalCreateConnection = globalAgent.createConnection
  globalAgent.createConnection = ((options: { servername?: string }) =>
    tlsConnect({
      host: '127.0.0.1',
      port: address.port,
      servername: options.servername ?? 'api.openai.com',
      rejectUnauthorized: false,
    })) as typeof globalAgent.createConnection
  try {
    await run(address.port)
  } finally {
    globalAgent.createConnection = originalCreateConnection
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('local agent proxy policy', () => {
  it('honors an aborted custom fetch request', async () => {
    const proxy = await start()
    const controller = new AbortController()
    controller.abort()

    await expect(
      createOpenAIProxyFetch(proxy)('https://api.openai.com/v1/models', {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('never returns real secrets to the harness', async () => {
    const proxy = await start()
    expect(JSON.stringify(proxy)).not.toContain('real-secret-value')
    expect(JSON.stringify(proxy.childEnv)).not.toContain('real-secret-value')
    expect(proxy.placeholders.OPENAI_API_KEY).toBe('${STASHBASE_OPENAI_API_KEY}')
    expect(proxy.childEnv.OPENAI_API_KEY).toBeUndefined()
    expect(proxy.childEnv.ALL_PROXY).toBe('')
    expect(proxy.childEnv.npm_config_https_proxy).toBe('')
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:/)
  })

  it('rewrites the placeholder and forwards request and SSE response streams', async () => {
    const proxy = await start()
    let authorization = ''
    let body = ''
    await withLocalOpenAI(
      (request, response) => {
        authorization = request.headers.authorization ?? ''
        request.on('data', (chunk) => {
          body += chunk.toString()
        })
        request.on('end', () => {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.write('data: first\n\n')
          response.end('data: second\n\n')
        })
      },
      async () => {
        const payload = 'streamed request body'
        const result = await throughTls(
          proxy,
          `POST /v1/responses?stream=true HTTP/1.1\r\nHost: api.openai.com\r\nAuthorization: Bearer ${proxy.placeholders.OPENAI_API_KEY}\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`
        )
        expect(result).toContain('data: first')
        expect(result).toContain('data: second')
      }
    )
    expect(authorization).toBe('Bearer real-secret-value')
    expect(body).toBe('streamed request body')
  })

  it('relays the first SSE event before the upstream releases the next event', async () => {
    const proxy = await start()
    let releaseSecond!: () => void
    const secondEvent = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    let receivedFirst!: () => void
    const firstEvent = new Promise<void>((resolve) => {
      receivedFirst = resolve
    })
    await withLocalOpenAI(
      (request, response) => {
        request.resume()
        request.on('end', () => {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.write('data: first\n\n')
          void secondEvent.then(() => response.end('data: second\n\n'))
        })
      },
      async () => {
        const result = throughTls(
          proxy,
          `GET /v1/responses HTTP/1.1\r\nHost: api.openai.com\r\nAuthorization: Bearer ${proxy.placeholders.OPENAI_API_KEY}\r\nConnection: close\r\n\r\n`,
          443,
          (chunk) => {
            if (chunk.includes('data: first')) receivedFirst()
          }
        )
        await Promise.race([
          firstEvent,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('first SSE event was buffered')), 1_000)
          ),
        ])
        releaseSecond()
        await expect(result).resolves.toContain('data: second')
      }
    )
  })

  it('forwards configured HTTPS destinations on a non-default port', async () => {
    const proxy = await start()
    let forwardedHost = ''
    await withLocalOpenAI(
      (request, response) => {
        forwardedHost = request.headers.host ?? ''
        response.end('custom-port-ok')
      },
      async (upstreamPort) => {
        const result = await throughTls(
          proxy,
          `GET / HTTP/1.1\r\nHost: api.openai.com:${upstreamPort}\r\nAuthorization: Bearer ${proxy.placeholders.OPENAI_API_KEY}\r\nConnection: close\r\n\r\n`,
          upstreamPort
        )
        expect(result).toContain('custom-port-ok')
      }
    )
    expect(forwardedHost).toMatch(/^api\.openai\.com:\d+$/)
  })

  it('injects configurable credential headers and keeps binding hosts from granting ordinary egress', async () => {
    const proxy = await startLocalAgentProxy({
      egressHosts: [],
      bindings: {
        CUSTOM_KEY: {
          secret: 'custom-secret',
          hosts: ['api.openai.com'],
          header: 'x-api-key',
          env: 'CUSTOM_KEY',
        },
      },
    })
    proxies.push(proxy)
    let header = ''
    await withLocalOpenAI(
      (request, response) => {
        header = String(request.headers['x-api-key'] ?? '')
        response.end('ok')
      },
      async () => {
        const injected = await throughTls(
          proxy,
          'GET / HTTP/1.1\r\nHost: api.openai.com\r\nX-Api-Key: ${STASHBASE_CUSTOM_KEY}\r\nConnection: close\r\n\r\n'
        )
        expect(injected).toContain('200')
        const ordinary = await throughTls(
          proxy,
          'GET / HTTP/1.1\r\nHost: api.openai.com\r\nConnection: close\r\n\r\n'
        )
        expect(ordinary).toContain('proxy.host_denied')
      }
    )
    expect(header).toBe('custom-secret')
    expect(proxy.childEnv.CUSTOM_KEY).toBe('${STASHBASE_CUSTOM_KEY}')
  })

  it('applies deny hosts over egress and credential bindings', async () => {
    const proxy = await startLocalAgentProxy({
      egressHosts: ['api.openai.com'],
      denyHosts: ['api.openai.com'],
      bindings: {
        OPENAI_API_KEY: {
          secret: 'real-secret-value',
          hosts: ['api.openai.com'],
          header: 'authorization',
          valueTemplate: 'Bearer {secret}',
        },
      },
    })
    proxies.push(proxy)
    const { port } = new URL(proxy.url)
    const result = await new Promise<string>((resolve) => {
      const socket = connect(Number(port), '127.0.0.1', () =>
        socket.write('CONNECT api.openai.com:443 HTTP/1.1\r\n\r\n')
      )
      socket.on('data', (data) => resolve(data.toString()))
    })
    expect(result).toContain('proxy.host_denied')
  })

  it('denies a non-OpenAI CONNECT host with a stable error', async () => {
    const proxy = await start()
    const { port } = new URL(proxy.url)
    const result = await new Promise<string>((resolve) => {
      const socket = connect(Number(port), '127.0.0.1', () =>
        socket.write('CONNECT example.com:443 HTTP/1.1\r\n\r\n')
      )
      socket.on('data', (data) => resolve(data.toString()))
    })
    expect(result).toContain('403 Forbidden')
    expect(result).toContain('proxy.host_denied')
  })

  it('rejects malformed CONNECT authorities before opening a TLS session', async () => {
    const proxy = await start()
    const { port } = new URL(proxy.url)
    const result = await new Promise<string>((resolve) => {
      const socket = connect(Number(port), '127.0.0.1', () =>
        socket.write('CONNECT api.openai.com:443/not-authority-form HTTP/1.1\r\n\r\n')
      )
      socket.on('data', (data) => resolve(data.toString()))
    })
    expect(result).toContain('403 Forbidden')
    expect(result).toContain('proxy.host_denied')
  })

  it('denies unknown placeholders', async () => {
    const proxy = await start()
    const result = await throughTls(
      proxy,
      'GET /v1/models HTTP/1.1\r\nHost: api.openai.com\r\nAuthorization: Bearer ${STASHBASE_UNKNOWN}\r\nConnection: close\r\n\r\n'
    )
    expect(result).toContain('proxy.unknown_placeholder')
  })

  it('does not inject a placeholder without an authorized binding', async () => {
    const proxy = await start({
      OPENAI_API_KEY: {
        secret: 'real-secret-value',
        hosts: [],
        header: 'authorization',
        valueTemplate: 'Bearer {secret}',
      },
    })
    const result = await throughTls(
      proxy,
      'GET /v1/models HTTP/1.1\r\nHost: api.openai.com\r\nAuthorization: Bearer ${STASHBASE_OPENAI_API_KEY}\r\nConnection: close\r\n\r\n'
    )
    expect(result).toContain('proxy.credential_host_denied')
    expect(result).not.toContain('real-secret-value')
  })

  it('cleans up CA material and closes idempotently', async () => {
    const proxy = await start()
    await access(proxy.caPath)
    await proxy.stop()
    await proxy.stop()
    await expect(access(proxy.caPath)).rejects.toThrow()
    const { port } = new URL(proxy.url)
    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = connect(Number(port), '127.0.0.1')
        socket.once('connect', () => resolve())
        socket.once('error', () => reject(new Error('closed')))
      })
    ).rejects.toThrow('closed')
  })
})
