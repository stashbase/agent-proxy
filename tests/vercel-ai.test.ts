import { createServer as createHttpsServer, globalAgent } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { afterEach, expect, it } from 'vitest'
import forge from 'node-forge'
import { AgentProxy, createVercelAIProxyFetch, type LocalAgentProxy } from '../src'

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
  const name = [{ name: 'commonName', value: 'api.openai.com' }]
  cert.setSubject(name)
  cert.setIssuer(name)
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: 'api.openai.com' }] }])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) }
}

it('routes a Vercel AI SDK provider through the proxy', async () => {
  const proxy = new AgentProxy({
    egressHosts: ['api.openai.com'],
    bindings: {},
  })
  await proxy.start()
  proxies.push(proxy)

  let authorization = ''
  let requestBody = ''
  const server = createHttpsServer(certificate(), (request, response) => {
    const header = request.headers.authorization
    authorization = Array.isArray(header) ? header[0] : (header ?? '')
    request.on('data', (chunk) => {
      requestBody += chunk.toString()
    })
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: 'chatcmpl_local',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-5',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Hello from Vercel AI SDK' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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
      servername: options.servername ?? 'api.openai.com',
      rejectUnauthorized: false,
    })) as typeof globalAgent.createConnection

  try {
    const openai = createOpenAI({
      apiKey: 'direct-application-api-key',
      fetch: createVercelAIProxyFetch(proxy),
    })
    const result = await generateText({
      model: openai.chat('gpt-5'),
      prompt: 'Hello',
    })

    expect(result.text).toBe('Hello from Vercel AI SDK')
  } finally {
    globalAgent.createConnection = originalCreateConnection
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  expect(requestBody).toContain('"model":"gpt-5"')
  expect(authorization).toBe('Bearer direct-application-api-key')
})
