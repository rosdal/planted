import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // The router plugin must run before react() so generated routes get transformed.
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  envDir: '../..',
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
});
