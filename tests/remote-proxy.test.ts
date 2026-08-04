import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { startRemoteAgentProxy, type LocalAgentProxy } from '../src'

const proxies: LocalAgentProxy[] = []
const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.stop()))
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

it('creates a managed session and relays normal placeholder-only proxy usage locally', async () => {
  const sessionToken = 'opaque-session-token'
  const proxyCa = '-----BEGIN CERTIFICATE-----\npublic-test-ca\n-----END CERTIFICATE-----\n'
  const sessionRequests: Array<Record<string, unknown>> = []
  let authorization = ''
  let targetRequest = ''
  let deletedToken = ''

  const controlPlane = createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/v1/agent-proxy/sessions') {
      const body = await readBody(request)
      sessionRequests.push(JSON.parse(body))
      const address = controlPlane.address()
      if (!address || typeof address === 'string') throw new Error('missing test control-plane address')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        session_id: 'session-1',
        session_token: sessionToken,
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        proxy_url: `http://127.0.0.1:${address.port}`,
        protocol: 'http/1.1-forward-proxy-tls-intercept',
        proxy_ca: { key_id: 'test', sha256: sha256(proxyCa), pem: proxyCa },
      }))
      return
    }
    if (request.method === 'DELETE' && request.url === '/v1/agent-proxy/sessions/current') {
      deletedToken = request.headers['x-stashbase-session'] ?? ''
      response.writeHead(204).end()
      return
    }
    response.writeHead(404).end()
  })
  controlPlane.on('connect', (request, socket) => {
    authorization = request.headers['proxy-authorization'] ?? ''
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.once('data', (chunk) => {
      targetRequest = chunk.toString()
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
    })
  })
  servers.push(controlPlane)
  await listen(controlPlane)
  const address = controlPlane.address()
  if (!address || typeof address === 'string') throw new Error('missing test control-plane address')

  const proxy = await startRemoteAgentProxy({
    apiKey: 'trusted-app-key',
    project: 'platform',
    environment: 'development',
    egressHosts: ['api.example.com'],
    apiUrl: `http://127.0.0.1:${address.port}`,
    bindings: { API_KEY: { from: 'PROVIDER_API_KEY', env: 'API_KEY', hosts: ['api.example.com'] } },
  })
  proxies.push(proxy)

  expect(proxy.childEnv.API_KEY).toBe('${STASHBASE_API_KEY}')
  expect(JSON.stringify(proxy.childEnv)).not.toContain(sessionToken)
  expect(sessionRequests).toEqual([{
    project_id: 'platform',
    environment_id: 'development',
    egress_hosts: ['api.example.com'],
    deny_hosts: [],
    bindings: [{
      name: 'API_KEY', from: 'PROVIDER_API_KEY', hosts: ['api.example.com'],
      header: 'authorization', placeholder: '${STASHBASE_API_KEY}', value_template: 'Bearer {secret}',
    }],
  }])

  const response = await throughProxy(proxy, 'api.example.com:443', 'GET /health HTTP/1.1\r\nHost: api.example.com\r\nConnection: close\r\n\r\n')
  expect(response).toContain('200 OK')
  expect(authorization).toBe(`Bearer ${sessionToken}`)
  expect(targetRequest).toContain('GET /health HTTP/1.1')

  await proxy.stop()
  expect(deletedToken).toBe(sessionToken)
})

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.once('end', () => resolve(body))
    request.once('error', reject)
  })
}

function throughProxy(proxy: LocalAgentProxy, destination: string, request: string): Promise<string> {
  const { port } = new URL(proxy.url)
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), '127.0.0.1')
    let output = ''
    let sentRequest = false
    socket.once('error', reject)
    socket.once('connect', () => socket.write(`CONNECT ${destination} HTTP/1.1\r\nHost: ${destination}\r\n\r\n`))
    socket.on('data', (chunk) => {
      output += chunk.toString()
      if (!sentRequest && output.startsWith('HTTP/1.1 200 Connection Established\r\n\r\n')) {
        sentRequest = true
        socket.write(request)
      }
    })
    socket.once('end', () => resolve(output))
  })
}
