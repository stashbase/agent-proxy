import { createOpenAIProxyFetch } from './openai-fetch'
import type { CreateAnthropicProxyClientOptions, FetchConfigurableClient } from './types'

/**
 * Wraps an existing official Anthropic client so its HTTPS transport uses the
 * local Agent Proxy. The client remains application-owned: its API key,
 * base URL, retries, and other configuration are preserved.
 */
export function createAnthropicProxyClient<Client extends FetchConfigurableClient<Client>>(
  anthropic: Client,
  options: CreateAnthropicProxyClientOptions
): Client {
  return anthropic.withOptions({ fetch: createOpenAIProxyFetch(options.proxy) })
}
