import { defineProject } from 'vitest/config';

// Kept apart from vite.config.ts: unit tests need neither the router generator nor Tailwind.
export default defineProject({
  test: {
    name: 'web',
    environment: 'node',
  },
});
