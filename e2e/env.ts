/** Ports shared by playwright.config.ts and the specs; off 3000/5173 so `pnpm dev` can keep running. */
export const API_PORT = Number(process.env.E2E_API_PORT ?? 5198);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5199);
export const API_URL = `http://localhost:${API_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;
