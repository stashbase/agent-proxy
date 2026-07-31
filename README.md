# @stashbase/agent-proxy

Experimental Node.js 20+ local Agent Proxy. It exposes placeholders to an agent harness and injects credentials only where a configured policy permits it, over a temporary locally trusted TLS interception connection. The trusted application resolves each secret (for example, with the main Stashbase SDK) before creating its binding.

Use `new AgentProxy(policy)` followed by `await proxy.start()` for explicit lifecycle management, or `startLocalAgentProxy(policy)` as a convenience. Use `createOpenAIProxyClient(OpenAIOrConfiguredClient, { proxy })` with the official OpenAI SDK. The `egressHosts`, `denyHosts`, and `bindings` policy matches CLI agent profile semantics. `proxy.childEnv` includes configured binding environment placeholders plus `HTTPS_PROXY`/`HTTP_PROXY`, `NODE_EXTRA_CA_CERTS`, `NODE_USE_ENV_PROXY=1`, and empty `NO_PROXY`/`no_proxy`.

This reduces accidental secret disclosure; it is not a malicious-process sandbox. The OpenAI client is the first dedicated SDK adapter; bindings can also be used by isolated tool workers that make proxy-aware HTTPS requests.

## Use with the Stashbase Node SDK

`@stashbase/agent-proxy` is standalone: it does not require the Stashbase Node
SDK at runtime. They work well together, however, because the trusted
application can use the SDK to resolve a secret and pass it directly to the
local proxy. The agent and its tools receive only the generated placeholder.

```ts
import OpenAI from 'openai'
import { createEnvironmentClient } from '@stashbase/node-sdk'
import { AgentProxy } from '@stashbase/agent-proxy'

const stashbase = createEnvironmentClient(process.env.STASHBASE_API_KEY!)
const secretResponse = await stashbase.secrets.get('GITHUB_TOKEN')

if (!secretResponse.ok) {
  throw new Error(`Could not load GITHUB_TOKEN: ${secretResponse.error.message}`)
}

const proxy = new AgentProxy({
  // Allow model requests without granting this egress permission to GitHub.
  egressHosts: ['api.openai.com'],
  bindings: {
    GITHUB_TOKEN: {
      secret: secretResponse.data.value,
      hosts: ['api.github.com'],
      header: 'authorization',
      env: 'GITHUB_TOKEN',
    },
  },
})

await proxy.start()

const openai = proxy.createOpenAIClient(
  new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })
)

try {
  // Run agent code with `openai`. GitHub tools receive only
  // `${STASHBASE_GITHUB_TOKEN}`, never secretResponse.data.value.
} finally {
  await proxy.stop()
}
```

The dependency direction is intentional: the application owns Stashbase SDK
authentication and secret resolution; Agent Proxy owns the short-lived local
credential boundary. This package never imports or requires the Node SDK.

## Why use it

Agent frameworks, tool workers, logs, and model-provider requests often cross
trust boundaries. Passing a raw token through each of those layers makes an
accidental leak easy: a debugging statement, a serialized tool result, or an
agent prompt can expose a credential that was only meant for an API request.

Agent Proxy keeps that credential in the trusted application and supplies it
only at the final outbound request. This provides several practical benefits:

- **Keeps credentials out of agent context.** Agents and tool workers receive
  predictable placeholders, not real token values. The credential therefore
  cannot accidentally appear in prompts, tool arguments, normal worker logs,
  or a tool result merely because the worker inspected its environment.

- **Applies least privilege at the network boundary.** A binding names the
  destination hosts and header into which its placeholder may be injected. An
  OpenAI key cannot be used for GitHub, and a GitHub token cannot be forwarded
  to an arbitrary host. `egressHosts` and `denyHosts` provide a separate
  destination allowlist for requests that do not need a credential.

- **Works with familiar application code.** The OpenAI adapter lets a trusted
  Node application use the official SDK while routing transport through the
  local policy. Worker-backed tools can use standard proxy-aware HTTPS clients
  or Node `fetch` without receiving the resolved secret.

- **Reduces environment leakage.** Each tool invocation starts with a fresh,
  minimal environment. It receives only configured placeholders and proxy/CA
  settings, rather than inheriting every credential from the parent process.

- **Leaves less persistent material behind.** The proxy uses a disposable CA
  and cleans its temporary certificate material when `stop()` is called. The
  secret is not written to the worker environment or to the proxy's public
  handle.

The API provider that authenticates a request necessarily receives its real
credential in the request header. Agent Proxy prevents the credential from
being handed to agent code and model context; it does not prevent a tool from
returning sensitive data that it fetched with an authorized credential.

## Platform support

The proxy and placeholder-only worker run on Node.js 20+ platforms. The optional
`sandbox: true` network restriction has narrower operating-system support:

- **macOS:** supported with the system `sandbox-exec` utility.

- **Linux systemd hosts:** supported when the calling user has a running,
  accessible systemd user manager. Agent Proxy checks this before starting a
  sandboxed worker and reports a configuration error if it is unavailable.
  This is appropriate for a configured VM or bare-metal server.

- **Docker, ECS/Fargate, and minimal Linux images:** the proxy and ordinary
  worker mode work, but `sandbox: true` is unsupported because these
  environments do not normally expose a systemd user manager. Use deployment-
  level isolation for untrusted tools instead.

- **Windows:** `sandbox: true` is currently unsupported.

To verify a configured Linux host, run the opt-in end-to-end sandbox check:

```sh
RUN_AGENT_PROXY_LINUX_SANDBOX_TEST=1 bun run test -- tests/manual/linux-sandbox.test.ts
```

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
