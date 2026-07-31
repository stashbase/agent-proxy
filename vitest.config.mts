import { defineConfig } from 'vitest/config'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDirectory = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: packageDirectory,
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
  },
})
