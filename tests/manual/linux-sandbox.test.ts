import { afterEach, expect, it } from 'vitest'
import {
  createSandboxedToolExecutor,
  startLocalAgentProxy,
  type LocalAgentProxy,
} from '@stashbase/agent-proxy'

const proxies: LocalAgentProxy[] = []

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.stop()))
})

const runLinuxSandboxTest =
  process.platform === 'linux' && process.env.RUN_AGENT_PROXY_LINUX_SANDBOX_TEST === '1'

it.skipIf(!runLinuxSandboxTest)(
  'runs a placeholder-only tool through the systemd Linux sandbox',
  async () => {
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
      module: new URL('../fixtures/tool-worker.mjs', import.meta.url),
      exportName: 'inspectEnvironment',
      sandbox: true,
    })

    await expect(worker.execute({ environment: 'linux-systemd' })).resolves.toMatchObject({
      githubToken: proxy.placeholders.GITHUB_TOKEN,
      httpsProxy: proxy.url,
    })
  }
)
