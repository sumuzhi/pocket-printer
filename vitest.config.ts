import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // NestJS relies on decorator metadata; esbuild (vitest's transform) needs
    // to be told to emit it, exactly as tsc does for the build.
    esbuild: {
      target: 'es2023',
    },
  },
  esbuild: {
    target: 'es2023',
  },
})
