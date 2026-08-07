# @stashbase/agent-proxy

## Local Agent Proxy

Node.js 20+ local Agent Proxy. It exposes placeholders to an agent harness and injects credentials only where a configured policy permits it, over a temporary locally trusted TLS interception connection. The trusted application resolves each secret (for example, with the main Stashbase SDK) before creating its binding.

**A focused harness-level security primitive for agent tools:** let an agent use
GitHub, Stripe, or an internal API without handing its real credential to the
agent, tool worker, logs, or model context. A tool receives a placeholder and
can reach only the destinations its policy permits; the local proxy injects the
real value only into the authorized outbound API request.

It is designed to fit an existing Node application and secret store. You do not
need a separate agent runtime, remote sandbox service, or a replacement for your
current framework.

Use `new AgentProxy(policy)` followed by `await proxy.start()` for explicit lifecycle management, or `startLocalAgentProxy(policy)` as a convenience. `createOpenAIProxyClient(OpenAIOrConfiguredClient, { proxy })` and `createAnthropicProxyClient(configuredAnthropicClient, { proxy })` route official SDK clients through the proxy. `proxy.childEnv` includes configured binding environment placeholders plus `HTTPS_PROXY`/`HTTP_PROXY`, `NODE_EXTRA_CA_CERTS`, `NODE_USE_ENV_PROXY=1`, and empty `NO_PROXY`/`no_proxy`.

This reduces accidental secret disclosure; it is not a malicious-process sandbox. OpenAI and Anthropic clients have dedicated SDK adapters; bindings can also be used by isolated tool workers that make proxy-aware HTTPS requests.

### Use with the Stashbase Node SDK

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

const openAI = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
})

const proxy = new AgentProxy({
  // Allow this model endpoint without granting ordinary egress to GitHub.
  egressHosts: [new URL(openAI.baseURL).hostname],
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

const openAIClient = proxy.createOpenAIClient(openAI)

try {
  // Run agent code with `openAIClient`. GitHub tools receive only
  // `${STASHBASE_GITHUB_TOKEN}`, never secretResponse.data.value.
} finally {
  await proxy.stop()
}
```

The dependency direction is intentional: the application owns Stashbase SDK
authentication and secret resolution; Agent Proxy owns the short-lived local
credential boundary. This package never imports or requires the Node SDK.

### Use with the Anthropic SDK

Pass an existing, application-configured Anthropic client to the proxy. This
preserves the client's API key, base URL, retries, and all other SDK options;
only its HTTPS transport changes. Agent Proxy does not assume an
`ANTHROPIC_API_KEY` binding.

```ts
import Anthropic from '@anthropic-ai/sdk'
import { AgentProxy } from '@stashbase/agent-proxy'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
})

const proxy = new AgentProxy({
  egressHosts: [new URL(anthropic.baseURL).hostname],
  bindings: {},
})

await proxy.start()

const anthropicClient = proxy.createAnthropicClient(anthropic)

try {
  const message = await anthropicClient.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'Hello' }],
  })
} finally {
  await proxy.stop()
}
```

Use a credential binding instead when Anthropic credentials must be available
to an agent tool. The trusted application still chooses the binding name,
header, and permitted hosts.

### Use with Vercel AI SDK

Pass the proxy fetch implementation while creating an AI SDK provider. This
works in ordinary Node applications and on any host; Vercel deployment is not
required. AI SDK providers capture `fetch` at creation time, so create the
provider with the proxy fetch rather than attempting to wrap it afterwards.

```ts
import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { AgentProxy } from '@stashbase/agent-proxy'

const proxy = new AgentProxy({
  egressHosts: ['api.openai.com'],
  bindings: {},
})

await proxy.start()

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  fetch: proxy.createVercelAIFetch(),
})

try {
  const result = await generateText({
    model: openai('gpt-5'),
    prompt: 'Hello',
  })
} finally {
  await proxy.stop()
}
```

The same `fetch` value can be passed to other AI SDK provider factories that
support a custom `fetch`, including the Anthropic provider.

## Remote Agent Proxy

`RemoteAgentProxy` creates a short-lived, control-plane-backed session. The
trusted application supplies its Stashbase API key; the agent receives only
placeholders and a localhost proxy URL. The session token and resolved secret
values stay in the parent process and are revoked when `stop()` completes.
The remote public CA is written to a random temporary directory as `ca.pem`;
its path is exposed through `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
`CURL_CA_BUNDLE`, and `GIT_SSL_CAINFO`, then removed when the proxy stops. To
use a stable caller-owned path instead, pass `caFilePath`; its parent
directories are created automatically and the file is kept on shutdown. Relative
paths resolve from the application's current working directory, so server
applications should use an absolute path.

```ts
import { RemoteAgentProxy } from '@stashbase/agent-proxy'

const proxy = new RemoteAgentProxy({
  apiKey: process.env.STASHBASE_API_KEY!,
  project: 'platform',
  environment: 'development',
  // Optional: write the CA to this stable path instead of a temporary ca.pem.
  // caFilePath: '/var/run/my-app/stashbase-proxy-ca.pem',
  egressHosts: ['api.openai.com'],
  bindings: {
    OPENAI_API_KEY: { from: 'OPENAI_API_KEY', env: 'OPENAI_API_KEY', hosts: ['api.openai.com'] },
  },
})

const started = await proxy.start()
if (!started.ok) throw new Error(started.error.message)

try {
  // Give proxy.childEnv to the agent or tool process. It contains only
  // OPENAI_API_KEY=${STASHBASE_OPENAI_API_KEY}, never the real secret.
} finally {
  const stopped = await proxy.stop()
  if (!stopped.ok) console.error(stopped.error)
}
```

Use remote hooks for metadata-only operational visibility. They never receive
credentials, session tokens, request paths, or bodies:

```ts
const proxy = new RemoteAgentProxy({
  // …session configuration
  hooks: {
    onSessionRefresh: (event) => {
      if (event.state === 'failed') console.warn(event.error, event.retryInMs)
    },
    onRelayError: (event) => console.warn(event.kind, event.host, event.error),
  },
})
```

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

- **Works with familiar application code.** The OpenAI and Anthropic adapters
  let a trusted Node application use the official SDK while routing transport
  through the local policy. Worker-backed tools can use standard proxy-aware
  HTTPS clients or Node `fetch` without receiving the resolved secret.

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

## Observability hooks

Pass metadata-only lifecycle hooks in the proxy policy to record tracing,
metrics, or audit events. Hook contexts contain destination host, port, method,
binding name, status, and duration as applicable—never bodies, header values,
placeholders, or secret values. Hooks are observational: failures are ignored
so they cannot alter proxy policy or interrupt tool traffic.

```ts
const proxy = new AgentProxy({
  egressHosts: ['api.openai.com'],
  bindings: {
    // ...
  },
  hooks: {
    beforeRequest: (event) => metrics.increment('agent_proxy.request', { host: event.host }),
    afterResponse: (event) => metrics.timing('agent_proxy.duration', event.durationMs),
    onDenied: (event) => audit.warn('agent_proxy.denied', event),
    onError: (event) => audit.error('agent_proxy.error', event),
  },
})
```

## Platform support

The proxy and placeholder-only worker run on Node.js 20+ platforms. Bun can
launch the trusted application, but sandboxed workers run under Node.js so proxy
and CA environment settings are enforced. Install Node.js or set
`STASHBASE_AGENT_PROXY_NODE` to its executable path. The optional `sandbox: true`
network restriction has narrower operating-system support:

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
import { createSandboxedToolModule, startLocalAgentProxy } from '@stashbase/agent-proxy'

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

const github = createSandboxedToolModule({
  proxy,
  module: new URL('./tools/github.mjs', import.meta.url),
  sandbox: true,
})

const githubWorker = github.export('createIssue')

const createGitHubIssue = tool({
  name: 'create_github_issue',
  description: 'Create a GitHub issue',
  parameters: z.object({ title: z.string(), body: z.string() }),
  execute: (input) => githubWorker.execute(input),
})
```

`tools/github.mjs` receives `GITHUB_TOKEN=${STASHBASE_GITHUB_TOKEN}`, never the real token. It can use Node 20+ `fetch` (or a client that honors proxy configuration) to call `api.github.com`; the proxy replaces that exact placeholder only for the configured header and host.

Each invocation starts a fresh Node worker with a minimal runtime environment, configured placeholders, and proxy/CA settings. `sandbox: true` additionally restricts network access to the local proxy using `sandbox-exec` on macOS or a systemd user scope on Linux. It is opt-in and unavailable on Windows. Without it, a tool that bypasses proxy configuration can still make direct connections.

For a module with several tools, configure its proxy and sandbox policy once, then expose only the exports that your application intends to register:

```ts
const github = createSandboxedToolModule({
  proxy,
  module: new URL('./tools/github.mjs', import.meta.url),
  sandbox: true,
})

const listRepositories = github.export('listRepositories')
const createIssue = github.export('createIssue')
```

Creating these executors does not create workers. Each `execute()` call still gets a fresh sandboxed process.

For optional compile-time checks of export names and input/output values, pass
the module type as a generic. Use `typeof import(...)` (or `import type`) so the
trusted application does not execute the tool module merely to obtain its types.
The string remains necessary at runtime because the worker imports the module in
a separate process, but TypeScript prevents selecting an undeclared export:

```ts
type GitHubTools = typeof import('./tools/github.mjs')

const github = createSandboxedToolModule<GitHubTools>({
  proxy,
  module: new URL('./tools/github.mjs', import.meta.url),
  sandbox: true,
})

const listRepositories = github.export('listRepositories')
await listRepositories.execute({ organization: 'stashbase' })

// TypeScript error: this export was not declared in GitHubTools.
github.export('deleteRepository')
```

For a JavaScript tool module without type declarations, use JSDoc or a matching
`.d.mts` declaration file. You can also declare the minimal shape explicitly:

```ts
type GitHubTools = {
  listRepositories: (input: { organization: string }) => Promise<string[]>
  createIssue: (input: { title: string; body: string }) => Promise<{ url: string }>
}
```
