import { defineConfig } from 'tsup'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const packageDirectory = dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(resolve(packageDirectory, 'package.json'), 'utf8')) as {
  version: string
}
export default defineConfig({
  entry: [resolve(packageDirectory, 'src/index.ts')],
  format: ['cjs', 'esm'],
  dts: true,
  target: 'node20',
  platform: 'node',
  define: {
    __AGENT_PROXY_VERSION__: JSON.stringify(version),
  },
  clean: true,
  outDir: 'dist',
})
