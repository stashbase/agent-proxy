import OpenAI from 'openai'
import { afterEach, expect, it } from 'vitest'
import {
  AgentProxy,
  createSandboxedToolExecutor,
  type LocalAgentProxy,
} from '@stashbase/agent-proxy'

const proxies: LocalAgentProxy[] = []
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.stop()))
})

const runLiveTest =
  process.env.RUN_AGENT_PROXY_GITHUB_TOOL_TEST === '1' &&
  Boolean(process.env.OPENAI_API_KEY) &&
  Boolean(process.env.GITHUB_TOKEN)

// To run this test, set the following environment variables and run the test command:
// RUN_AGENT_PROXY_GITHUB_TOOL_TEST=1 \
// OPENAI_API_KEY=... \
// GITHUB_TOKEN=... \
// OPENAI_BASE_URL=... \
// OPENAI_MODEL=... \
// bun run test -- tests/manual/github-tool-loop.test.ts

it.skipIf(!runLiveTest)(
  'asks a model to list GitHub repositories through a sandboxed tool',
  async () => {
    const openAIBaseURL = process.env.OPENAI_BASE_URL
    const openAI = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY!,
      ...(openAIBaseURL ? { baseURL: openAIBaseURL } : {}),
      maxRetries: 0,
      timeout: 60_000,
    })
    const openAIHost = new URL(openAIBaseURL ?? 'https://api.openai.com/v1').hostname
    const proxy = new AgentProxy({
      bindings: {
        GITHUB_TOKEN: {
          secret: process.env.GITHUB_TOKEN!,
          hosts: ['api.github.com'],
          env: 'GITHUB_TOKEN',
        },
      },
      egressHosts: [openAIHost],
    })
    await proxy.start()
    proxies.push(proxy)

    const githubTool = createSandboxedToolExecutor({
      proxy,
      module: new URL('../fixtures/github.mjs', import.meta.url),
      exportName: 'listGitHubRepositories',
      sandbox: true,
      timeoutMs: 30_000,
    })
    const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'
    const firstResponse = await openAI.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: 'Use the available tool when the user asks about GitHub repositories.',
        },
        {
          role: 'user',
          content: 'List my GitHub repositories, then briefly summarize them.',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'list_github_repositories',
            description: 'List the repositories available to the configured GitHub account.',
            parameters: {
              type: 'object',
              properties: {},
              required: [],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: {
        type: 'function',
        function: { name: 'list_github_repositories' },
      },
    })
    const assistantMessage = firstResponse.choices[0]?.message
    const toolCall = assistantMessage?.tool_calls?.find(
      (call) => call.type === 'function' && call.function.name === 'list_github_repositories'
    )

    expect(toolCall).toBeDefined()
    expect(assistantMessage).toBeDefined()
    if (!assistantMessage || !toolCall || toolCall.type !== 'function') return

    const repositories = await githubTool.execute({})
    expect(repositories).toMatchObject({ status: 200, error: null })

    const finalResponse = await openAI.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: 'Use the available tool when the user asks about GitHub repositories.',
        },
        {
          role: 'user',
          content: 'List my GitHub repositories, then briefly summarize them.',
        },
        assistantMessage,
        {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(repositories),
        },
      ],
    })

    const messageContent = finalResponse.choices[0]?.message.content
    console.log(messageContent)

    expect(messageContent).not.toBe('')
  },
  90_000
)
