/** Shared by the e2e specs: rooms, boards with a saved guest identity, and drawing. */
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { API_URL } from './env';

export type Room = { roomId: string; editKey: string; viewKey: string };

/** The map rooms are created on unless a test picks another. */
export const DEFAULT_MAP = 'practice-annex';

/**
 * Every context a test opens. The browser outlives the test, so an unclosed board keeps
 * rendering and holding its socket, and a few of those starve the next test of CPU.
 */
const contexts: BrowserContext[] = [];

export async function newContext(browser: Browser, options?: Parameters<Browser['newContext']>[0]) {
  const context = await browser.newContext(options);
  contexts.push(context);
  return context;
}

test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});

export async function newRoom(mapId = DEFAULT_MAP): Promise<Room> {
  const res = await fetch(`${API_URL}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mapId }),
  });
  if (!res.ok) throw new Error(`POST /rooms answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as Room;
}

/**
 * A browser context with a saved guest identity, so the name dialog stays closed, opened on the
 * room's edit link unless another key is given.
 */
export async function openBoard(
  browser: Browser,
  room: Room,
  name: string,
  key = room.editKey,
): Promise<Page> {
  const context = await newContext(browser, { viewport: { width: 1280, height: 800 } });
  await context.addInitScript(
    (identity) => {
      localStorage.setItem('planted.guest', JSON.stringify(identity));
    },
    { name, colour: name === 'Alice' ? '#57ab5a' : '#b083f0' },
  );
  const page = await context.newPage();
  await page.goto(`/r/${room.roomId}#k=${key}`);
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  await page.waitForFunction(() => window.__board !== undefined);
  return page;
}

/**
 * Pointer down, 8 moves, up: one stroke. Each move waits for a renderer that is busy drawing
 * two WebGL boards, which on a 2-core CI runner costs ~0.4 s, so the stroke is kept short.
 */
export async function drawStroke(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + i * 25, y + Math.sin(i / 1.2) * 30);
  await page.mouse.up();
}

export const objectCount = (page: Page) => page.evaluate(() => window.__board?.objectCount() ?? -1);
export const authors = (page: Page) => page.evaluate(() => window.__board?.authors() ?? []);
export const docHash = (page: Page) => page.evaluate(() => window.__board?.docHash() ?? '');
