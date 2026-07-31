# @stashbase/agent-proxy

Experimental Node.js 20+ local Agent Proxy. It exposes placeholders to an agent harness and injects credentials only where a configured policy permits it, over a temporary locally trusted TLS interception connection. The trusted application resolves each secret (for example, with the main Stashbase SDK) before creating its binding.

Use `startLocalAgentProxy()` for lifecycle management and `createOpenAIProxyClient(OpenAIOrConfiguredClient, { proxy })` with the official OpenAI SDK. The `egressHosts`, `denyHosts`, and `bindings` policy matches CLI agent profile semantics. `proxy.childEnv` includes configured binding environment placeholders plus `HTTPS_PROXY`/`HTTP_PROXY`, `NODE_EXTRA_CA_CERTS`, `NODE_USE_ENV_PROXY=1`, and empty `NO_PROXY`/`no_proxy`.

This reduces accidental secret disclosure; it is not a malicious-process sandbox. The OpenAI client is the first dedicated SDK adapter; bindings can also be used by isolated tool workers that make proxy-aware HTTPS requests.

## Security boundary

This package is designed to keep resolved secrets out of agent and tool inputs,
environment variables, and normal logs. It is not a defense against code running
with the same operating-system user as the trusted application: that code can
inspect the application's process or files. Keep the trusted application and
proxy on a dedicated account or host when that is in scope for your threat model.

Treat `egressHosts`, `denyHosts`, and binding `hosts` as a strict allowlist. The
proxy rejects malformed CONNECT destinations, only accepts configured credential
placeholders, and prevents per-tool environment overrides from replacing proxy
transport settings or placeholders. OS network sandboxing is opt-in: macOS uses
`sandbox-exec`, Linux requires a systemd user session, and Windows is currently
unsupported. Applications must still validate tool inputs and authorize the
operations their tools perform.

## Sandboxed OpenAI Agents SDK tools

For tool code the agent should not run in the trusted application process, create a worker-backed executor and use it as the normal `execute` callback of an OpenAI Agents SDK function tool:

```ts
import { tool } from '@openai/agents'
import { z } from 'zod'
import { createSandboxedToolExecutor, startLocalAgentProxy } from '@stashbase/agent-proxy'

const proxy = await startLocalAgentProxy({
  egressHosts: [],
  bindings: {
    GITHUB_TOKEN: {
      // Resolve this in the trusted application using the Stashbase SDK.
      secret: resolvedSecrets.GITHUB_TOKEN,
      hosts: ['api.github.com'],
      header: 'authorization',
      env: 'GITHUB_TOKEN',
    },
  },
})

const githubWorker = createSandboxedToolExecutor({
  proxy,
  module: new URL('./tools/github.mjs', import.meta.url),
  exportName: 'createIssue',
  sandbox: true,
})

const createGitHubIssue = tool({
  name: 'create_github_issue',
  description: 'Create a GitHub issue',
  parameters: z.object({ title: z.string(), body: z.string() }),
  execute: (input) => githubWorker.execute(input),
})
```

`tools/github.mjs` receives `GITHUB_TOKEN=${STASHBASE_GITHUB_TOKEN}`, never the real token. It can use Node 20+ `fetch` (or a client that honors proxy configuration) to call `api.github.com`; the proxy replaces that exact placeholder only for the configured header and host.

Each invocation starts a fresh Node worker with a minimal runtime environment, configured placeholders, and proxy/CA settings. `sandbox: true` additionally restricts network access to the local proxy, using the same approach as the CLI: `sandbox-exec` on macOS or a systemd user scope on Linux. It is opt-in and unavailable on Windows. Without it, a tool that bypasses proxy configuration can still make direct connections.
