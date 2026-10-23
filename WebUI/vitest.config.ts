import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      // Only the `electron/` prefix — a bare `electron` must stay the npm package.
      { find: /^electron\//, replacement: `${path.resolve(__dirname, './electron')}/` },
    ],
  },
})
