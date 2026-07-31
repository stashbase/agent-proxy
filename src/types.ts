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

export type StartLocalAgentProxyOptions = {
  egressHosts: string[]

  denyHosts?: string[]

  bindings: Record<string, AgentProxyBinding>
}

export type SecretPlaceholder<Name extends string> = `\${STASHBASE_${Name}}`

export type LocalAgentProxy<Names extends string = never> = {
  url: string

  caPath: string

  /** Binding names are inferred by startLocalAgentProxy for autocomplete and typo checking. */
  placeholders: Record<string, string> & { [Name in Names]: SecretPlaceholder<Name> }

  childEnv: Record<string, string>

  stop(): Promise<void>
}

export type OpenAIClientConstructor = new (options: ClientOptions) => import('openai').default

export type CreateOpenAIProxyClientOptions = {
  proxy: LocalAgentProxy

  /** Defaults to OPENAI_API_KEY. Select another configured binding explicitly when needed. */
  apiKeyBinding?: string
}

/** Configuration for an isolated Node worker that implements an agent tool. */
export type SandboxedToolOptions = {
  proxy: LocalAgentProxy

  /** File URL or absolute path of an ESM/CommonJS module exporting the tool function. */
  module: URL | string

  /** Named export to invoke. Defaults to `default`. */
  exportName?: string

  /** Extra non-secret environment values for this tool. */
  env?: Record<string, string>

  /** Abort an invocation after this duration. Defaults to 30 seconds. */
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
import type OpenAI from 'openai'
