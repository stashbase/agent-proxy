import { defineConfig } from 'tsup'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const packageDirectory = dirname(fileURLToPath(import.meta.url))
export default defineConfig({
  entry: [resolve(packageDirectory, 'src/index.ts')],
  format: ['cjs', 'esm'],
  dts: true,
  target: 'node20',
  platform: 'node',
  clean: true,
  outDir: 'dist',
})
