import { createServer as createHttpsServer, globalAgent } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { afterEach, expect, it } from 'vitest'
import forge from 'node-forge'
import OpenAI from 'openai'
// Deliberately import the built workspace package, as an application does after publishing.
import {
  createOpenAIProxyClient,
  createSandboxedToolExecutor,
  startLocalAgentProxy,
  type LocalAgentProxy,
} from '@stashbase/agent-proxy'

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

it('works through the published package entry with normal OpenAI SDK application code', async () => {
  const proxy = await startLocalAgentProxy({
    egressHosts: ['api.openai.com'],
    bindings: { OPENAI_API_KEY: { secret: 'real-secret-value', hosts: ['api.openai.com'] } },
  })
  proxies.push(proxy)
  let requestBody = ''
  let authorization = ''
  const server = createHttpsServer(certificate(), (request, response) => {
    authorization = request.headers.authorization ?? ''
    request.on('data', (chunk) => {
      requestBody += chunk.toString()
    })
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: 'resp_local',
          object: 'response',
          created_at: 0,
          status: 'completed',
          model: 'gpt-5',
          output: [],
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
    const configuredOpenAI = new OpenAI({
      apiKey: 'direct-application-api-key',
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
    })
    const openai = createOpenAIProxyClient(configuredOpenAI, { proxy })
    const response = await openai.responses.create({ model: 'gpt-5', input: 'Hello' })
    expect(response.id).toBe('resp_local')
  } finally {
    globalAgent.createConnection = originalCreateConnection
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  expect(requestBody).toContain('"model":"gpt-5"')
  expect(requestBody).toContain('"input":"Hello"')
  expect(authorization).toBe('Bearer direct-application-api-key')
})

it('runs a normal agent-tool callback in an isolated placeholder-only worker', async () => {
  const proxy = await startLocalAgentProxy({
    egressHosts: [],
    bindings: {
      GITHUB_TOKEN: {
        secret: 'real-github-secret',
        hosts: ['api.github.com'],
        header: 'authorization',
        env: 'GITHUB_TOKEN',
      },
    },
  })
  proxies.push(proxy)
  const worker = createSandboxedToolExecutor({
    proxy,
    module: new URL('./fixtures/tool-worker.mjs', import.meta.url),
    exportName: 'inspectEnvironment',
  })

  // This is the same `execute` callback shape used by @openai/agents tool().
  const previousCredential = process.env.UNRELATED_PARENT_CREDENTIAL
  process.env.UNRELATED_PARENT_CREDENTIAL = 'must-not-reach-worker'
  let result: {
    input: { issue: string }
    githubToken?: string
    stashbaseApiKey: string | null
    unrelatedCredential: string | null
    httpsProxy?: string
  }
  try {
    result = await worker.execute({ issue: 'SDK-agent' })
  } finally {
    if (previousCredential === undefined) delete process.env.UNRELATED_PARENT_CREDENTIAL
    else process.env.UNRELATED_PARENT_CREDENTIAL = previousCredential
  }

  expect(result.input).toEqual({ issue: 'SDK-agent' })
  expect(result.githubToken).toBe(proxy.placeholders.GITHUB_TOKEN)
  expect(result.stashbaseApiKey).toBeNull()
  expect(result.unrelatedCredential).toBeNull()
  expect(result.httpsProxy).toBe(proxy.url)
  expect(JSON.stringify(result)).not.toContain('real-github-secret')
})

it('does not allow tool-specific environment values to replace proxy settings or placeholders', async () => {
  const proxy = await startLocalAgentProxy({
    egressHosts: [],
    bindings: {
      GITHUB_TOKEN: {
        secret: 'real-github-secret',
        hosts: ['api.github.com'],
        header: 'authorization',
        env: 'GITHUB_TOKEN',
      },
    },
  })
  proxies.push(proxy)
  const worker = createSandboxedToolExecutor({
    proxy,
    module: new URL('./fixtures/tool-worker.mjs', import.meta.url),
    exportName: 'inspectEnvironment',
    env: {
      GITHUB_TOKEN: 'attempted-secret-override',
      HTTPS_PROXY: 'http://bypass.invalid',
    },
  })

  await expect(worker.execute({ issue: 'environment-precedence' })).resolves.toMatchObject({
    githubToken: proxy.placeholders.GITHUB_TOKEN,
    httpsProxy: proxy.url,
  })
})
