import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { optimize } from 'svgo';
import { ICONS_DIR } from './repo';

export type IconSource = { id: string; svg: string };

export async function readIcons(dir = ICONS_DIR): Promise<IconSource[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.svg')).sort();
  return Promise.all(
    files.map(async (f) => ({
      id: f.replace(/\.svg$/, ''),
      svg: await readFile(join(dir, f), 'utf8'),
    })),
  );
}

/**
 * The style spec (icons/STYLE.md) as far as a machine can check it: 24 × 24 viewBox, the shared
 * stroke settings on the root, `currentColor` only, no ids, inline styles, gradients or text.
 */
export function lintIcon({ id, svg }: IconSource): string[] {
  const problems: string[] = [];
  const say = (m: string) => problems.push(`icons/src/${id}.svg: ${m}`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) say('file name must be lowercase-with-dashes');
  const root = /^<svg\b[^>]*>/.exec(svg.trim())?.[0] ?? '';
  if (!root.includes('viewBox="0 0 24 24"')) say('root must have viewBox="0 0 24 24"');
  for (const attr of [
    'fill="none"',
    'stroke="currentColor"',
    'stroke-width="1.75"',
    'stroke-linecap="round"',
    'stroke-linejoin="round"',
  ]) {
    if (!root.includes(attr)) say(`root must set ${attr}`);
  }
  if (/\sid=/.test(svg)) say('must not use ids');
  if (/\sstyle=|<style/.test(svg)) say('must not use inline styles');
  if (/Gradient|<text|<image|<use/.test(svg)) say('no gradients, text, images or <use>');
  for (const m of svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)) {
    if (m[1] !== 'none' && m[1] !== 'currentColor') say(`colour ${m[1]}: use currentColor only`);
  }
  return problems;
}

/**
 * Strict svgo pass for shipping: keeps the root's stroke settings, drops anything that could
 * make two icons collide in one sprite (ids) or escape `currentColor` (styles).
 */
export function optimizeIcon(svg: string): string {
  return optimize(svg, {
    multipass: true,
    plugins: [
      'preset-default',
      { name: 'removeAttrs', params: { attrs: ['id', 'style', 'class', 'data-.*'] } },
      'removeDimensions',
    ],
  }).data;
}
