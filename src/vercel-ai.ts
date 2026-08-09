import { createOpenAIProxyFetch } from './openai-fetch'
import type { AgentProxyTransport } from './types'

/**
 * Creates a fetch implementation for a Vercel AI SDK provider. Pass it as the
 * provider's `fetch` option when creating that provider.
 */
export function createVercelAIProxyFetch(proxy: AgentProxyTransport): typeof fetch {
  return createOpenAIProxyFetch(proxy)
}
