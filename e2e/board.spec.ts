import { type Browser, expect, type Page, test } from '@playwright/test';
import { API_URL } from './env';

async function newRoom(): Promise<string> {
  const res = await fetch(`${API_URL}/rooms`, { method: 'POST' });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { roomId: string }).roomId;
}

/** A browser context with a saved guest identity, so the name dialog stays closed. */
async function openBoard(browser: Browser, roomId: string, name: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(
    (identity) => {
      localStorage.setItem('planted.guest', JSON.stringify(identity));
    },
    { name, colour: name === 'Alice' ? '#57ab5a' : '#b083f0' },
  );
  const page = await context.newPage();
  await page.goto(`/r/${roomId}`);
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  await page.waitForFunction(() => window.__board !== undefined);
  return page;
}

/** Pointer down, 20 moves, up: one stroke. */
async function drawStroke(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(x + i * 10, y + Math.sin(i / 3) * 30);
  await page.mouse.up();
}

const objectCount = (page: Page) => page.evaluate(() => window.__board?.objectCount() ?? -1);
const authors = (page: Page) => page.evaluate(() => window.__board?.authors() ?? []);
const docHash = (page: Page) => page.evaluate(() => window.__board?.docHash() ?? '');

test('strokes sync both ways and undo only removes your own', async ({ browser }) => {
  const roomId = await newRoom();
  const a = await openBoard(browser, roomId, 'Alice');
  const b = await openBoard(browser, roomId, 'Bob');

  await drawStroke(a, 400, 300);
  await expect.poll(() => objectCount(b), { timeout: 1000 }).toBe(1);

  await drawStroke(b, 400, 500);
  await expect.poll(() => objectCount(a), { timeout: 1000 }).toBe(2);

  await a.keyboard.press('Control+z');
  for (const page of [a, b]) {
    await expect.poll(() => authors(page), { timeout: 1000 }).toEqual(['Bob']);
  }

  // A has nothing more to undo: Bob's stroke was never on Alice's stack.
  await a.keyboard.press('Control+z');
  await a.waitForTimeout(300);
  expect(await authors(b)).toEqual(['Bob']);

  await expect.poll(async () => (await docHash(a)) === (await docHash(b))).toBe(true);
});

test('Escape while drawing commits nothing', async ({ browser }) => {
  const roomId = await newRoom();
  const a = await openBoard(browser, roomId, 'Alice');
  await a.mouse.move(300, 300);
  await a.mouse.down();
  for (let i = 1; i <= 10; i++) await a.mouse.move(300 + i * 10, 300);
  await a.keyboard.press('Escape');
  await a.mouse.up();
  await a.waitForTimeout(200);
  expect(await objectCount(a)).toBe(0);
});

test('first visit asks for a name and shows it to others', async ({ browser }) => {
  const roomId = await newRoom();
  const b = await openBoard(browser, roomId, 'Bob');
  const page = await (await browser.newContext()).newPage();
  await page.goto(`/r/${roomId}`);

  const dialog = page.getByRole('dialog', { name: 'Join the board' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Name' }).fill('C');
  await dialog.getByRole('button', { name: 'Start drawing' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(/2 to 20 characters/);

  await dialog.getByRole('textbox', { name: 'Name' }).fill('Carol');
  await dialog.getByRole('button', { name: 'Start drawing' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: /You are Carol/ })).toBeVisible();
  await expect(b.getByText('2 here')).toBeVisible();
});
