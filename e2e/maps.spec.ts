import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { CONTENT_URL } from './env';
import { drawStroke, newContext, newRoom, openBoard } from './helpers';

type Manifest = { version: string; maps: { id: string; name: string }[] };

async function manifest(): Promise<Manifest> {
  const { version } = (await (await fetch(`${CONTENT_URL}/latest.json`)).json()) as {
    version: string;
  };
  return (await (await fetch(`${CONTENT_URL}/${version}/manifest.json`)).json()) as Manifest;
}

const floor = (page: Page) => page.evaluate(() => window.__board?.floor() ?? '');
const floors = (page: Page) => page.evaluate(() => [...(window.__board?.floors() ?? [])]);
const visibleStrokes = (page: Page) => page.evaluate(() => window.__board?.visibleStrokes() ?? -1);

/** Waits until the floor's art is drawn: its Graphics exists and the frame after has rendered. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

test('the picker lists every map with a thumbnail, and picking one opens the board on it', async ({
  browser,
}) => {
  const { maps } = await manifest();
  const context = await newContext(browser, { viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() =>
    localStorage.setItem('planted.guest', JSON.stringify({ name: 'Alice', colour: '#57ab5a' })),
  );
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'New room' }).click();

  const grid = page.getByRole('list', { name: 'Maps' });
  await expect(grid.getByRole('button')).toHaveCount(maps.length);
  for (const img of await grid.locator('img').all()) {
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1024);
  }
  await expect(
    page.getByRole('list', { name: 'Coming soon' }).getByRole('listitem'),
  ).not.toHaveCount(0);

  // Keyboard only: search, arrow into the grid, Enter.
  const target = maps.at(-1) as Manifest['maps'][number];
  await page.getByLabel('Search maps').fill(target.name.split(' ')[0] as string);
  await expect(grid.getByRole('button')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  await page.waitForURL(/\/r\//);
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  await expect(page.getByText(`${target.name} · content`)).toBeVisible();
  await page.waitForFunction(() => window.__board !== undefined);
});

test('every map: every floor switches, and strokes show only on their own floor', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { maps } = await manifest();
  // `PLANTED_BASELINES=e2e/baselines pnpm e2e e2e/maps.spec.ts` also saves a screenshot of
  // every floor of every map: the baseline 0.7's visual regression compares against.
  const baselines = process.env.PLANTED_BASELINES;
  for (const map of maps) {
    const room = await newRoom(map.id);
    const page = await openBoard(browser, room, 'Alice');
    const ids = await floors(page);
    expect(ids.length).toBeGreaterThan(0);

    // Keys 1–5 reach every floor, bottom to top.
    for (const [i, id] of ids.entries()) {
      await page.keyboard.press(String(i + 1));
      await expect.poll(() => floor(page)).toBe(id);
      if (baselines) {
        await settle(page);
        await mkdir(baselines, { recursive: true });
        await page.screenshot({ path: join(baselines, `${map.id}-${id}.png`) });
      }
    }

    if (ids.length < 2) {
      await page.context().close();
      continue;
    }
    // Draw on the second floor, look at the first (hidden), and back (visible).
    const [first, second] = ids as [string, string];
    await page.keyboard.press('2');
    await expect.poll(() => floor(page)).toBe(second);
    await drawStroke(page, 500, 400);
    await expect.poll(() => visibleStrokes(page)).toBe(1);
    await page.getByRole('button', { name: new RegExp(`^${labelOf(first)}$`, 'i') }).click();
    await expect.poll(() => floor(page)).toBe(first);
    expect(await visibleStrokes(page)).toBe(0);
    await page.keyboard.press('2');
    await expect.poll(() => visibleStrokes(page)).toBe(1);
    await page.context().close();
  }
});

/** Floor button labels in the practice maps are the floor ids, upper-cased (1f → 1F). */
function labelOf(floorId: string): string {
  return floorId === 'roof' ? 'Roof' : floorId.toUpperCase();
}

test('the overlay shows callouts, toggles with L, and hovering a room shows its callout anyway', async ({
  browser,
}) => {
  const room = await newRoom('practice-annex');
  const page = await openBoard(browser, room, 'Alice');
  await expect
    .poll(() => page.evaluate(() => window.__board?.visibleCallouts() ?? []))
    .toEqual(expect.arrayContaining(['Lobby', 'Main Hall', 'Kitchen']));
  await page.keyboard.press('l');
  await expect.poll(() => page.evaluate(() => window.__board?.overlay())).toBe(false);
  expect(await page.evaluate(() => window.__board?.visibleCallouts())).toEqual([]);

  // The Annex lobby is the top-left room of the ground floor; aim at its middle.
  const box = await page.getByTestId('board').boundingBox();
  if (!box) throw new Error('no board');
  const centre = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="board"] canvas') as HTMLCanvasElement;
    return { w: canvas.clientWidth, h: canvas.clientHeight };
  });
  // Fit (apps/web/src/board/camera.ts) centres the map at 92% of the short side, never below
  // scale 0.2; the lobby's centre is (0.3125, 0.375) in map space.
  const side = 4096 * Math.max(0.2, (Math.min(centre.w, centre.h) / 4096) * 0.92);
  const x = box.x + (centre.w - side) / 2 + side * 0.3125;
  const y = box.y + (centre.h - side) / 2 + side * 0.375;
  await page.mouse.move(x, y);
  await expect.poll(() => page.evaluate(() => window.__board?.hoverCallout())).toBe('Lobby');
});
