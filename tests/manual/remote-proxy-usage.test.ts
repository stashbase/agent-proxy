import OpenAI from 'openai'
import { expect, it } from 'vitest'
// Deliberately import the built package, exactly as an application does after publishing.
import { createOpenAIProxyFetch, RemoteAgentProxy } from '@stashbase/agent-proxy'

const runLiveTest =
  process.env.RUN_STASHBASE_REMOTE_AGENT_PROXY_TEST === '1' &&
  Boolean(process.env.STASHBASE_API_KEY) &&
  Boolean(process.env.STASHBASE_PROJECT) &&
  Boolean(process.env.STASHBASE_ENVIRONMENT)

// Run this consumer smoke test against a project/environment that contains an
// OPENAI_API_KEY and GH_TOKEN secrets:
//
// RUN_STASHBASE_REMOTE_AGENT_PROXY_TEST=1 \
// STASHBASE_API_KEY=... \
// STASHBASE_PROJECT=... \
// STASHBASE_ENVIRONMENT=... \
// STASHBASE_API_URL=http://127.0.0.1:5000 \
// bun run test -- tests/manual/remote-proxy-usage.test.ts
it.skipIf(!runLiveTest)(
  'uses RemoteAgentProxy as an application consumer',
  async () => {
    const openAIBaseURL = process.env.OPENAI_BASE_URL
    const openAIHost = new URL(openAIBaseURL ?? 'https://api.openai.com/v1').hostname
    console.log(
      `Starting remote proxy session via ${process.env.STASHBASE_API_URL ?? 'http://127.0.0.1:5000'}`
    )
    const proxy = new RemoteAgentProxy({
      apiKey: process.env.STASHBASE_API_KEY!,
      project: process.env.STASHBASE_PROJECT!,
      environment: process.env.STASHBASE_ENVIRONMENT!,
      apiUrl: process.env.STASHBASE_API_URL ?? 'http://127.0.0.1:5000',
      egressHosts: [],
      bindings: {
        OPENAI_API_KEY: {
          hosts: [openAIHost],
          env: 'OPENAI_API_KEY',
        },
        GH_TOKEN: {
          hosts: ['api.github.com'],
          env: 'GITHUB_TOKEN',
        },
      },
    })

    console.log('Waiting for remote proxy session creation…')
    const started = await proxy.start()
    if (!started.ok) {
      console.error('Remote proxy session could not start:', started.error)
      throw new Error(started.error.message)
    }
    try {
      console.log(`Remote proxy started at ${proxy.url}; OpenAI host: ${openAIHost}`)
      expect(proxy.childEnv.OPENAI_API_KEY).toBe('${STASHBASE_OPENAI_API_KEY}')
      expect(proxy.childEnv.GITHUB_TOKEN).toBe('${STASHBASE_GH_TOKEN}')

      const openai = openAIBaseURL
        ? new OpenAI({
            apiKey: proxy.placeholders.OPENAI_API_KEY,
            baseURL: openAIBaseURL,
            fetch: createOpenAIProxyFetch(proxy),
          })
        : proxy.createOpenAIClient(OpenAI)
      const githubFetch = createOpenAIProxyFetch(proxy)
      const tool = {
        type: 'function' as const,
        name: 'get_current_github_user',
        description: 'Get the authenticated GitHub user.',
        strict: true,
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      }
      console.log('Requesting an OpenAI tool call…')
      const firstResponse = await openai.responses.create({
        model: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
        input: 'Get my current GitHub user using the available tool, then briefly state the login.',
        tools: [tool],
        tool_choice: { type: 'function', name: tool.name },
      })
      console.log(`OpenAI tool-call response received: ${firstResponse.id}`)
      const call = firstResponse.output.find(
        (item): item is Extract<(typeof firstResponse.output)[number], { type: 'function_call' }> =>
          item.type === 'function_call' && item.name === tool.name
      )
      expect(call).toBeDefined()

      // The tool has only the placeholder. The remote proxy resolves GH_TOKEN
      // for api.github.com after the localhost relay authenticates its session.
      console.log('Calling GitHub GET /user through the remote proxy…')
      const githubResponse = await githubFetch('https://api.github.com/user', {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${proxy.placeholders.GH_TOKEN}`,
          'user-agent': 'stashbase-agent-proxy-manual-test',
        },
      })
      console.log(`GitHub response received: ${githubResponse.status} ${githubResponse.statusText}`)
      expect(githubResponse.ok).toBe(true)
      const githubUser = await githubResponse.json()
      expect(githubUser.login).toEqual(expect.any(String))
      console.log('GitHub user:', githubUser.login)

      console.log('Returning the GitHub result to OpenAI…')
      const finalResponse = await openai.responses.create({
        model: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
        previous_response_id: firstResponse.id,
        input: [
          {
            type: 'function_call_output',
            call_id: call!.call_id,
            output: JSON.stringify(githubUser),
          },
        ],
      })
      console.log('OpenAI response:', finalResponse.output_text)
      expect(finalResponse.output_text).not.toBe('')
    } finally {
      console.log('Stopping remote proxy session…')
      await proxy.stop()
      console.log('Remote proxy session stopped')
    }
  },
  60_000
)
