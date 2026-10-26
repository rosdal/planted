import { expect, test } from '@playwright/test';
import { API_URL } from './env';
import {
  authors,
  docHash,
  drawStroke,
  newContext,
  newRoom,
  objectCount,
  openBoard,
} from './helpers';

test('strokes sync both ways and undo only removes your own', async ({ browser }) => {
  const room = await newRoom();
  const a = await openBoard(browser, room, 'Alice');
  const b = await openBoard(browser, room, 'Bob');

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
  const room = await newRoom();
  const a = await openBoard(browser, room, 'Alice');
  await a.mouse.move(300, 300);
  await a.mouse.down();
  for (let i = 1; i <= 10; i++) await a.mouse.move(300 + i * 10, 300);
  await a.keyboard.press('Escape');
  await a.mouse.up();
  await a.waitForTimeout(200);
  expect(await objectCount(a)).toBe(0);
});

test('first visit asks for a name and shows it to others', async ({ browser }) => {
  const room = await newRoom();
  const b = await openBoard(browser, room, 'Bob');
  const page = await (await newContext(browser)).newPage();
  await page.goto(`/r/${room.roomId}#k=${room.editKey}`);

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

test('a share link key moves out of the address bar', async ({ browser }) => {
  const room = await newRoom();
  const page = await openBoard(browser, room, 'Alice');
  expect(new URL(page.url()).hash).toBe('');
  const stored = await page.evaluate((id) => localStorage.getItem(`room:${id}:key`), room.roomId);
  expect(stored).toBe(room.editKey);
});

test('with no key, the room shows the need-a-link page and calls nothing', async ({ browser }) => {
  const room = await newRoom();
  const page = await (await newContext(browser)).newPage();
  const apiCalls: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith(API_URL)) apiCalls.push(request.url());
  });
  await page.goto(`/r/${room.roomId}`);
  await expect(
    page.getByRole('heading', { name: 'You need a link to open this board' }),
  ).toBeVisible();
  expect(apiCalls).toEqual([]);
});

test('the view link sees live strokes and cursors but cannot draw', async ({ browser }) => {
  const room = await newRoom();
  const editor = await openBoard(browser, room, 'Alice');
  const viewer = await openBoard(browser, room, 'Bob', room.viewKey);
  await expect(viewer.getByText('View only', { exact: true })).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Share' })).toHaveCount(0);

  await drawStroke(editor, 400, 300);
  await expect.poll(() => objectCount(viewer), { timeout: 2000 }).toBe(1);

  await drawStroke(viewer, 400, 500);
  await viewer.keyboard.press('Control+z');
  await viewer.waitForTimeout(300);
  expect(await objectCount(editor)).toBe(1);
  expect(await objectCount(viewer)).toBe(1);
  // The viewer's cursor still reaches the editor.
  await expect(editor.getByText('2 here')).toBeVisible();
});

test('rotating links drops the viewer with "link revoked" and the new view link works', async ({
  browser,
}) => {
  const room = await newRoom();
  const owner = await openBoard(browser, room, 'Alice');
  const viewer = await openBoard(browser, room, 'Bob', room.viewKey);

  await owner.getByRole('button', { name: 'Share' }).click();
  const dialog = owner.getByRole('dialog', { name: 'Share this board' });
  await dialog.getByRole('button', { name: 'Rotate links' }).click();
  await dialog.getByRole('button', { name: 'Rotate links' }).click();
  await expect(dialog.getByRole('status')).toHaveText(/New links made/);

  await expect(
    viewer.getByRole('alert').filter({ hasText: 'This link was revoked' }),
  ).toBeVisible();
  // The owner stays in, on the new key.
  await expect(owner.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();

  const newViewUrl = await dialog.getByRole('textbox', { name: /View link/ }).inputValue();
  const newViewKey = new URL(newViewUrl).hash.replace('#k=', '');
  expect(newViewKey).not.toBe(room.viewKey);
  const fresh = await openBoard(browser, room, 'Carol', newViewKey);
  await expect(fresh.getByText('View only', { exact: true })).toBeVisible();
});

test('clearing the board resets every tab and old strokes never come back', async ({ browser }) => {
  const room = await newRoom();
  const a = await openBoard(browser, room, 'Alice');
  const b = await openBoard(browser, room, 'Bob');
  await drawStroke(a, 400, 300);
  await expect.poll(() => objectCount(b), { timeout: 2000 }).toBe(1);

  await a.getByRole('button', { name: 'Share' }).click();
  const dialog = a.getByRole('dialog', { name: 'Share this board' });
  await dialog.getByRole('button', { name: 'Clear board' }).click();
  await dialog.getByRole('button', { name: 'Clear board' }).click();

  for (const page of [a, b]) {
    await expect(page.getByRole('status').filter({ hasText: 'Board was reset' })).toBeVisible();
    await page.waitForFunction(() => window.__board !== undefined);
    await expect.poll(() => objectCount(page), { timeout: 5000 }).toBe(0);
  }
  await b.waitForTimeout(500);
  expect(await objectCount(a)).toBe(0);
  expect(await objectCount(b)).toBe(0);
});
