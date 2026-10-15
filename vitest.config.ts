import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The protocol layer is pure arithmetic and buffers — no device needed.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
