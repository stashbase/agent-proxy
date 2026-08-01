import { expect, it } from 'vitest'
import { createSandboxedToolModule, sandboxCommand } from '../src/tool-runner'

const proxy = {
  url: 'http://127.0.0.1:43123',
  caPath: '/tmp/agent-proxy-ca.pem',
  placeholders: {},
  childEnv: {},
  stop: async () => {},
}

it('uses the appropriate sandbox launcher for supported platforms', () => {
  expect(sandboxCommand(proxy, true, 'darwin').command).toBe('/usr/bin/sandbox-exec')
  expect(sandboxCommand(proxy, true, 'linux')).toMatchObject({ command: 'systemd-run' })
})

it('rejects sandboxing on unsupported platforms', () => {
  expect(() => sandboxCommand(proxy, true, 'win32')).toThrow('currently supported')
})

it('does not wrap workers when sandboxing is disabled', () => {
  expect(sandboxCommand(proxy, false, 'win32')).toEqual({ command: process.execPath, args: [] })
})

it('creates explicit per-export executors from one module configuration', async () => {
  const tools = createSandboxedToolModule({
    proxy,
    module: new URL('./fixtures/tool-worker.mjs', import.meta.url),
  })

  await expect(tools.export('inspectEnvironment').execute({ issue: 'module-api' })).resolves.toMatchObject({
    input: { issue: 'module-api' },
  })
  expect(() => tools.export('')).toThrow('must not be empty')
})
