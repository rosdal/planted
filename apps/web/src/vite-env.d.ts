/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  /** Content CDN root (holds latest.json); `pnpm content:serve` locally. */
  readonly VITE_CONTENT_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
