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

export type SandboxedToolExportInput<Exports extends object, Name extends keyof Exports> =
  Exports[Name] extends (input: infer Input, ...args: any[]) => unknown ? Input : never

export type SandboxedToolExportOutput<Exports extends object, Name extends keyof Exports> =
  Exports[Name] extends (...args: any[]) => infer Output ? Awaited<Output> : never

/**
 * Creates per-export executors without repeating shared module and sandbox policy.
 * Selecting an export remains explicit application-owned configuration.
 */
export type SandboxedToolModule<Exports extends object = Record<string, (...args: any[]) => unknown>> = {
  export<Name extends SandboxedToolExportName<Exports>>(
    exportName: Name
  ): TypedSandboxedToolExecutor<
    SandboxedToolExportInput<Exports, Name>,
    SandboxedToolExportOutput<Exports, Name>
  >
}
import type OpenAI from 'openai'
