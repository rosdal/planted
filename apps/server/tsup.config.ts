import { defineConfig } from 'tsup';

// Internal packages export raw TypeScript, which Node won't strip inside node_modules,
// so they are bundled in; everything from npm stays external.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  noExternal: [/^@planted\//],
  sourcemap: true,
  clean: true,
});
