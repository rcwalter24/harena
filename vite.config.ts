import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { open: false },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
