import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDirectory = dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(resolve(packageDirectory, 'package.json'), 'utf8')) as {
  version: string
}

export default defineConfig({
  root: packageDirectory,
  define: {
    __AGENT_PROXY_VERSION__: JSON.stringify(version),
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
  },
})
