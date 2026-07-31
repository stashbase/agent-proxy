import { RunContext, tool } from '@openai/agents'
import { createServer as createHttpsServer, globalAgent } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { afterEach, expect, it } from 'vitest'
import forge from 'node-forge'
// Deliberately import the built package as an application does after publishing.
import {
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
  const name = [{ name: 'commonName', value: 'api.github.com' }]
  cert.setSubject(name)
  cert.setIssuer(name)
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: 'api.github.com' }] }])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) }
}

it('runs an OpenAI Agents SDK function tool in a placeholder-only worker', async () => {
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
  const executor = createSandboxedToolExecutor({
    proxy,
    module: new URL('./fixtures/tool-worker.mjs', import.meta.url),
    exportName: 'inspectEnvironment',
  })
  const agentTool = tool({
    name: 'inspect_github_environment',
    description: 'Inspect the isolated GitHub tool environment',
    parameters: {
      type: 'object',
      properties: { issue: { type: 'string' } },
      required: ['issue'],
      additionalProperties: false,
    },
    async execute(input) {
      return executor.execute(input)
    },
  })

  const output = await agentTool.invoke(new RunContext(), JSON.stringify({ issue: 'SDK-agent' }))

  expect(output).toMatchObject({
    input: { issue: 'SDK-agent' },
    githubToken: proxy.placeholders.GITHUB_TOKEN,
    stashbaseApiKey: null,
    unrelatedCredential: null,
    httpsProxy: proxy.url,
  })
  expect(JSON.stringify(output)).not.toContain('real-github-secret')
})

it('lists GitHub-style repositories through the proxy without exposing the token', async () => {
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
  let authorization = ''
  const upstream = createHttpsServer(certificate(), (request, response) => {
    authorization = request.headers.authorization ?? ''
    expect(request.url).toBe('/user/repos')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify([{ full_name: 'stashbase/example-agent-tool' }]))
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('No local GitHub test upstream')
  const originalCreateConnection = globalAgent.createConnection
  globalAgent.createConnection = ((options: { servername?: string }) =>
    tlsConnect({
      host: '127.0.0.1',
      port: address.port,
      servername: options.servername ?? 'api.github.com',
      rejectUnauthorized: false,
    })) as typeof globalAgent.createConnection
  try {
    const executor = createSandboxedToolExecutor({
      proxy,
      module: new URL('./fixtures/tool-worker.mjs', import.meta.url),
      exportName: 'listGitHubRepos',
      // The sandbox launcher is integration-tested on macOS; Linux and Windows
      // still exercise the same placeholder-only worker path in portable CI.
      sandbox: process.platform === 'darwin',
    })
    const listRepos = tool({
      name: 'list_github_repositories',
      description: 'List repositories available to the configured GitHub account',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      async execute() {
        return executor.execute({})
      },
    })

    await expect(listRepos.invoke(new RunContext(), '{}')).resolves.toEqual([
      { full_name: 'stashbase/example-agent-tool' },
    ])
  } finally {
    globalAgent.createConnection = originalCreateConnection
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
  expect(authorization).toBe('Bearer real-github-secret')
})
