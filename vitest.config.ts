import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // The engine is headless by contract — no DOM, no browser globals.
    environment: 'node',
  },
});
