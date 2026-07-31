import OpenAI from 'openai'
import { afterEach, expect, it } from 'vitest'
// Deliberately import the built package, exactly as an application does after publishing.
import {
  createOpenAIProxyClient,
  createSandboxedToolExecutor,
  startLocalAgentProxy,
  type LocalAgentProxy,
} from '@stashbase/agent-proxy'

const proxies: LocalAgentProxy[] = []
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.stop()))
})

const runLiveTest =
  process.env.RUN_STASHBASE_LIVE_AGENT_TEST === '1' &&
  Boolean(process.env.OPENAI_API_KEY) &&
  Boolean(process.env.GITHUB_TOKEN)

it.skipIf(!runLiveTest)(
  'uses the OpenAI SDK to ask the model to list GitHub repositories through a sandboxed tool',
  async () => {
    const proxy = await startLocalAgentProxy({
      egressHosts: [],
      bindings: {
        OPENAI_API_KEY: { secret: process.env.OPENAI_API_KEY!, hosts: ['api.openai.com'] },
        GITHUB_TOKEN: {
          secret: process.env.GITHUB_TOKEN!,
          hosts: ['api.github.com'],
          header: 'authorization',
          env: 'GITHUB_TOKEN',
        },
      },
    })
    proxies.push(proxy)

    // This OpenAI client receives a placeholder API key; its custom fetch routes
    // model requests through the same local proxy that owns the real key.
    const sdk = createOpenAIProxyClient(OpenAI, { proxy })
    const executor = createSandboxedToolExecutor({
      proxy,
      module: new URL('../fixtures/tool-worker.mjs', import.meta.url),
      exportName: 'listGitHubRepos',
      sandbox: true,
    })
    const model = process.env.STASHBASE_AGENT_TEST_MODEL ?? ''
    const tool = {
      type: 'function' as const,
      name: 'list_github_repositories',
      description: 'List repositories available to the configured GitHub account.',
      strict: true,
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    }

    const firstResponse = await sdk.responses.create({
      model,
      input:
        'Call list_github_repositories, then briefly summarize the repositories returned by the tool.',
      tools: [tool],
      tool_choice: { type: 'function', name: tool.name },
    })
    const calls = firstResponse.output.filter(
      (item): item is Extract<(typeof firstResponse.output)[number], { type: 'function_call' }> =>
        item.type === 'function_call' && item.name === tool.name
    )
    expect(calls).toHaveLength(1)

    const toolOutputs = []
    for (const call of calls) {
      const repositories = await executor.execute({})
      console.log('GitHub tool result:', repositories)
      toolOutputs.push({
        type: 'function_call_output' as const,
        call_id: call.call_id,
        output: JSON.stringify(repositories),
      })
    }

    const finalResponse = await sdk.responses.create({
      model,
      previous_response_id: firstResponse.id,
      input: toolOutputs,
    })
    console.log('OpenAI final response:', finalResponse.output_text)
    expect(finalResponse.output_text).not.toBe('')
  }
)
