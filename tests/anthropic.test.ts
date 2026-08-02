import { createServer as createHttpsServer, globalAgent } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { afterEach, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import forge from 'node-forge'
import { AgentProxy, createAnthropicProxyClient, type LocalAgentProxy } from '../src'

const proxies: LocalAgentProxy[] = []

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.stop()))
})

function certificate(): { cert: string; key: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date(Date.now() + 60_000)
  const name = [{ name: 'commonName', value: 'api.anthropic.com' }]
  cert.setSubject(name)
  cert.setIssuer(name)
  cert.setExtensions([
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'api.anthropic.com' }] },
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) }
}

it('routes an existing official Anthropic client through the proxy', async () => {
  const proxy = new AgentProxy({
    egressHosts: ['api.anthropic.com'],
    bindings: {},
  })
  await proxy.start()
  proxies.push(proxy)

  let apiKey = ''
  let requestBody = ''
  const server = createHttpsServer(certificate(), (request, response) => {
    const header = request.headers['x-api-key']
    apiKey = Array.isArray(header) ? header[0] : (header ?? '')
    request.on('data', (chunk) => {
      requestBody += chunk.toString()
    })
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: 'msg_local',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'Hello' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test upstream address')

  const originalCreateConnection = globalAgent.createConnection
  globalAgent.createConnection = ((options: { servername?: string }) =>
    tlsConnect({
      host: '127.0.0.1',
      port: address.port,
      servername: options.servername ?? 'api.anthropic.com',
      rejectUnauthorized: false,
    })) as typeof globalAgent.createConnection

  try {
    const configuredAnthropic = new Anthropic({
      apiKey: 'direct-application-api-key',
      baseURL: 'https://api.anthropic.com',
      maxRetries: 0,
    })
    expect(createAnthropicProxyClient(configuredAnthropic, { proxy })).toBeInstanceOf(Anthropic)
    const anthropic = proxy.createAnthropicClient(configuredAnthropic)
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Hello' }],
    })

    expect(message.id).toBe('msg_local')
  } finally {
    globalAgent.createConnection = originalCreateConnection
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  expect(requestBody).toContain('"model":"claude-sonnet-4-5"')
  expect(apiKey).toBe('direct-application-api-key')
})
