import type { ClientOptions } from 'openai'

export type AgentProxyErrorCode =
  | 'proxy.host_denied'
  | 'proxy.unknown_placeholder'
  | 'proxy.credential_host_denied'
  | 'proxy.request_invalid'
  | 'proxy.session_expired'

export type AgentProxyError = { error: { code: AgentProxyErrorCode; message: string } }

export type AgentProxyBinding = {
  /** Private value injected by the proxy; it is never returned to the caller. */
  secret: string

  hosts: string[]

  /** Defaults to `authorization`. */
  header?: string

  /** Defaults to `Bearer {secret}` for Authorization, otherwise `{secret}`. */
  valueTemplate?: string

  env?: string
}

/** Metadata-only lifecycle events. Hook contexts never contain bodies, header values, or secrets. */
export type AgentProxyBeforeRequestHookContext = {
  host: string
  port: number
  method: string
  binding?: string
}

export type AgentProxyAfterResponseHookContext = AgentProxyBeforeRequestHookContext & {
  status: number
  durationMs: number
}

export type AgentProxyErrorHookContext = AgentProxyBeforeRequestHookContext & {
  error: unknown
  durationMs: number
}

export type AgentProxyDeniedHookContext = {
  host?: string
  port?: number
  code: AgentProxyErrorCode
}

/** Read-only observability hooks. Hook failures never alter proxy policy or traffic. */
export type AgentProxyHooks = {
  beforeRequest?: (context: AgentProxyBeforeRequestHookContext) => void | Promise<void>
  afterResponse?: (context: AgentProxyAfterResponseHookContext) => void | Promise<void>
  onError?: (context: AgentProxyErrorHookContext) => void | Promise<void>
  onDenied?: (context: AgentProxyDeniedHookContext) => void | Promise<void>
}

export type StartLocalAgentProxyOptions = {
  egressHosts: string[]

  denyHosts?: string[]

  bindings: Record<string, AgentProxyBinding>

  hooks?: AgentProxyHooks
}

/** A secret reference resolved by the Stashbase remote Agent Proxy, never locally. */
export type RemoteAgentProxyBinding = Omit<AgentProxyBinding, 'secret'> & {
  /** Remote Stashbase secret name. Defaults to the binding name. */
  from?: string
  /** Placeholder exposed to the agent. Defaults to `${STASHBASE_<binding name>}`. */
  placeholder?: string
}

/** Metadata-only session rotation health event. It never includes session tokens or secrets. */
export type RemoteAgentProxyRotationHealthEvent =
  | { state: 'succeeded'; expiresAt: string }
  | {
      state: 'failed'
      expiresAt: string
      retryInMs: number
      error: { code: string; message: string; status: number | null }
    }

/** Metadata-only failure while the localhost relay connects to the remote proxy. */
export type RemoteAgentProxyRelayErrorEvent = {
  kind: 'request' | 'connect'
  host?: string
  error: { code: string; message: string }
}

/** Read-only observability hooks for a Remote Agent Proxy session. */
export type RemoteAgentProxyHooks = {
  onRotationHealth?: (event: RemoteAgentProxyRotationHealthEvent) => void | Promise<void>
  onRelayError?: (event: RemoteAgentProxyRelayErrorEvent) => void | Promise<void>
}

/**
 * Configuration for a short-lived Stashbase-managed Agent Proxy session.
 *
 * Unlike {@link StartLocalAgentProxyOptions}, the Stashbase control plane
 * resolves secrets and hosts the remote proxy. The API remains authoritative
 * for access checks on both session creation and replacement.
 */
export type RemoteAgentProxyOptions = {
  /** Stashbase API key used only by the trusted application to create/revoke the session. */
  apiKey: string
  /** Project ID or name. */
  project: string
  /** Environment ID or name within the project. */
  environment: string
  egressHosts: string[]
  denyHosts?: string[]
  bindings: Record<string, RemoteAgentProxyBinding>
  hooks?: RemoteAgentProxyHooks
  /** Defaults to https://api.stashbase.dev. */
  apiUrl?: string
}

/** A structured failure returned while starting a Remote Agent Proxy session. */
export type RemoteAgentProxyStartError = {
  code: string
  message: string
  details?: unknown
}

/** Node SDK-style outcome returned by {@link RemoteAgentProxy.start}. */
export type RemoteAgentProxyStartResult<Proxy> =
  | { ok: true; data: Proxy; error: null; status: number | null }
  | { ok: false; data: null; error: RemoteAgentProxyStartError; status: number | null }

/** Node SDK-style outcome returned by {@link RemoteAgentProxy.stop}. */
export type RemoteAgentProxyStopResult =
  | { ok: true; data: null; error: null; status: number | null }
  | { ok: false; data: null; error: RemoteAgentProxyStartError; status: number | null }

export type SecretPlaceholder<Name extends string> = `\${STASHBASE_${Name}}`

/** Shared connection details used by proxy-aware SDK adapters and tool workers. */
export type AgentProxyTransport<Names extends string = never> = {
  url: string

  caPath: string

  /** Binding names are inferred by startLocalAgentProxy for autocomplete and typo checking. */
  placeholders: Record<string, string> & { [Name in Names]: SecretPlaceholder<Name> }

  childEnv: Record<string, string>
}

/** A local proxy with lifecycle ownership of disposable local CA material. */
export type LocalAgentProxy<Names extends string = never> = AgentProxyTransport<Names> & {
  stop(): Promise<void>
}

export type OpenAIClientConstructor = new (options: ClientOptions) => import('openai').default

export type CreateOpenAIProxyClientOptions = {
  proxy: AgentProxyTransport

  /** Defaults to OPENAI_API_KEY. Select another configured binding explicitly when needed. */
  apiKeyBinding?: string
}

/** The portion of an official Anthropic client used by Agent Proxy. */
export type FetchConfigurableClient<Client> = {
  withOptions(options: { fetch: typeof fetch }): Client
}

/** Options for wrapping an existing official Anthropic client. */
export type CreateAnthropicProxyClientOptions = {
  proxy: AgentProxyTransport
}

/** Configuration for an isolated Node worker that implements an agent tool. */
export type SandboxedToolOptions = {
  proxy: AgentProxyTransport

  /** File URL or absolute path of an ESM/CommonJS module exporting the tool function. */
  module: URL | string

  /** Named export to invoke. Defaults to `default`. */
  exportName?: string

  /** Extra non-secret environment values for this tool. */
  env?: Record<string, string>

  /** Abort an invocation after this duration. The worker receives SIGTERM, then SIGKILL after a short grace period. Defaults to 30 seconds. */
  timeoutMs?: number

  /**
   * Restrict child network access to the local proxy. Mirrors the CLI sandbox:
   * macOS uses sandbox-exec and Linux requires systemd-run. Defaults to false.
   */
  sandbox?: boolean
}

export type SandboxedToolExecutor = {
  execute<Input, Output = unknown>(input: Input): Promise<Output>
}

/** A sandboxed executor whose input and output were derived from a typed module export. */
export type TypedSandboxedToolExecutor<Input, Output> = {
  execute(input: Input): Promise<Output>
}

/** Shared worker configuration for several explicitly allowed exports of one module. */
export type SandboxedToolModuleOptions = Omit<SandboxedToolOptions, 'exportName'>

export type SandboxedToolExportName<Exports extends object> = Extract<
  {
    [Name in keyof Exports]: Exports[Name] extends (...args: any[]) => unknown ? Name : never
  }[keyof Exports],
  string
>

export type SandboxedToolExportInput<
  Exports extends object,
  Name extends keyof Exports,
> = Exports[Name] extends (input: infer Input, ...args: any[]) => unknown ? Input : never

export type SandboxedToolExportOutput<
  Exports extends object,
  Name extends keyof Exports,
> = Exports[Name] extends (...args: any[]) => infer Output ? Awaited<Output> : never

/**
 * Creates per-export executors without repeating shared module and sandbox policy.
 * Selecting an export remains explicit application-owned configuration.
 */
export type SandboxedToolModule<
  Exports extends object = Record<string, (...args: any[]) => unknown>,
> = {
  export<Name extends SandboxedToolExportName<Exports>>(
    exportName: Name
  ): TypedSandboxedToolExecutor<
    SandboxedToolExportInput<Exports, Name>,
    SandboxedToolExportOutput<Exports, Name>
  >
}
import type OpenAI from 'openai'
