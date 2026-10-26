/** Elements and attributes an icon may use; anything else in the sprite is dropped. */
const ELEMENTS = new Set([
  'symbol',
  'path',
  'circle',
  'ellipse',
  'rect',
  'line',
  'polyline',
  'polygon',
  'g',
]);
const ATTRIBUTES = new Set([
  'id',
  'viewBox',
  'd',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x',
  'y',
  'width',
  'height',
  'x1',
  'y1',
  'x2',
  'y2',
  'points',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'fill-rule',
  'clip-rule',
  'opacity',
  'transform',
]);
const SVG_NS = 'http://www.w3.org/2000/svg';

function copy(source: Element, into: Element): void {
  for (const child of source.children) {
    if (!ELEMENTS.has(child.localName)) continue;
    const clone = document.createElementNS(SVG_NS, child.localName);
    for (const { name, value } of child.attributes) {
      if (ATTRIBUTES.has(name) && !/url\(|javascript:/i.test(value))
        clone.setAttribute(name, value);
    }
    copy(child, clone);
    into.appendChild(clone);
  }
}

/**
 * Builds a hidden `<svg>` holding the sprite's `<symbol>`s, rebuilt from an allowlist of shape
 * elements and attributes. The sprite comes from our own CDN, but it is still a file from
 * outside the page, and this keeps a tampered one from injecting scripts or handlers.
 */
export function spriteElement(text: string): { element: SVGSVGElement; ids: string[] } {
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
  const element = document.createElementNS(SVG_NS, 'svg');
  element.setAttribute('aria-hidden', 'true');
  element.style.display = 'none';
  copy(parsed.documentElement, element);
  const ids = [...element.children]
    .filter((c) => c.localName === 'symbol')
    .map((c) => c.id.replace(/^icon-/, ''));
  return { element, ids };
}
