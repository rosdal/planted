import pathParser from 'svg-path-parser';

// CommonJS: the named exports only exist on the default export under Node ESM.
const { makeAbsolute, parseSVG } = pathParser;

export type Pt = [number, number];

/** SVG affine matrix `[a b c d e f]`: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` applied after `n`: the matrix of a child (`n`) inside a parent (`m`). */
export function multiply(m: Matrix, n: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const [a2, b2, c2, d2, e2, f2] = n;
  return [
    a * a2 + c * b2,
    b * a2 + d * b2,
    a * c2 + c * d2,
    b * c2 + d * d2,
    a * e2 + c * f2 + e,
    b * e2 + d * f2 + f,
  ];
}

export function apply(m: Matrix, [x, y]: Pt): Pt {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Parses an SVG `transform` attribute. Throws on anything it can't read. */
export function parseTransform(value: string | undefined): Matrix {
  if (!value?.trim()) return IDENTITY;
  let result = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  for (const match of value.matchAll(re)) {
    const name = match[1];
    const args = (match[2] ?? '')
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (args.some((n) => !Number.isFinite(n))) throw new Error(`bad transform "${value}"`);
    let m: Matrix;
    switch (name) {
      case 'matrix':
        if (args.length !== 6) throw new Error(`matrix() needs 6 numbers in "${value}"`);
        m = args as Matrix;
        break;
      case 'translate':
        m = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
        break;
      case 'scale':
        m = [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0];
        break;
      case 'rotate': {
        const rad = ((args[0] ?? 0) * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const [cx = 0, cy = 0] = args.slice(1);
        m = multiply(multiply([1, 0, 0, 1, cx, cy], [cos, sin, -sin, cos, 0, 0]), [
          1,
          0,
          0,
          1,
          -cx,
          -cy,
        ]);
        break;
      }
      case 'skewX':
        m = [1, 0, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      default:
        m = [1, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    }
    result = multiply(result, m);
  }
  // Anything left over is a transform we don't know; refuse rather than guess.
  if (value.replace(re, '').replace(/[\s,]/g, '')) throw new Error(`unknown transform "${value}"`);
  return result;
}

/** One flattened subpath of a `d` attribute. */
export type Subpath = { points: Pt[]; closed: boolean };

/** Segments for a curve whose control polygon is `length` long, sampled at about 1 unit. */
function steps(length: number): number {
  return Math.max(1, Math.ceil(length));
}

const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, out: Pt[]): void {
  const n = steps(dist(p0, p1) + dist(p1, p2) + dist(p2, p3));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
}

function quadratic(p0: Pt, p1: Pt, p2: Pt, out: Pt[]): void {
  const n = steps(dist(p0, p1) + dist(p1, p2));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    ]);
  }
}

/** Elliptical arc, by the endpoint-to-centre conversion in SVG 1.1 appendix F.6. */
function arc(
  p0: Pt,
  p1: Pt,
  rxIn: number,
  ryIn: number,
  rotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
  out: Pt[],
): void {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0 || (p0[0] === p1[0] && p0[1] === p1[1])) {
    out.push(p1);
    return;
  }
  const phi = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2;
  const dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const coef = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (coef * rx * y1) / ry;
  const cy1 = (-coef * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p1[0]) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0[1] + p1[1]) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const n = steps(Math.abs(delta) * Math.max(rx, ry));
  for (let i = 1; i <= n; i++) {
    const t = theta + (delta * i) / n;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    out.push(i === n ? p1 : [cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
}

/** Flattens a path's `d` into polylines; curves and arcs are sampled at about 1 unit. */
export function flattenPath(d: string): Subpath[] {
  const subpaths: Subpath[] = [];
  let current: Subpath | null = null;
  let start: Pt = [0, 0];
  // The last command's second control point, which S and T reflect for their first one.
  let lastCubic: Pt | null = null;
  let lastQuad: Pt | null = null;
  const reflect = (control: Pt | null, about: Pt): Pt =>
    control ? [2 * about[0] - control[0], 2 * about[1] - control[1]] : about;
  for (const cmd of makeAbsolute(parseSVG(d))) {
    const end: Pt = [cmd.x, cmd.y];
    const from: Pt = [cmd.x0, cmd.y0];
    const prevCubic = lastCubic;
    const prevQuad = lastQuad;
    lastCubic = null;
    lastQuad = null;
    switch (cmd.code) {
      case 'M':
        current = { points: [end], closed: false };
        subpaths.push(current);
        start = end;
        break;
      case 'Z':
        if (current) current.closed = true;
        // A command after Z without an M starts a new subpath at the same point.
        current = { points: [start], closed: false };
        subpaths.push(current);
        break;
      default: {
        if (!current) {
          current = { points: [from], closed: false };
          subpaths.push(current);
        }
        const out = current.points;
        switch (cmd.code) {
          case 'L':
          case 'H':
          case 'V':
            out.push(end);
            break;
          case 'C':
          case 'S': {
            const c1: Pt = cmd.code === 'C' ? [cmd.x1, cmd.y1] : reflect(prevCubic, from);
            cubic(from, c1, [cmd.x2, cmd.y2], end, out);
            lastCubic = [cmd.x2, cmd.y2];
            break;
          }
          case 'Q':
          case 'T': {
            const c: Pt = cmd.code === 'Q' ? [cmd.x1, cmd.y1] : reflect(prevQuad, from);
            quadratic(from, c, end, out);
            lastQuad = c;
            break;
          }
          case 'A':
            arc(from, end, cmd.rx, cmd.ry, cmd.xAxisRotation, cmd.largeArc, cmd.sweep, out);
            break;
        }
      }
    }
  }
  // Drop the empty subpaths a trailing Z leaves behind.
  return subpaths.filter((s) => s.points.length > 1 || s.closed);
}

/**
 * Removes points closer than `epsilon` to the line through their neighbours, so a straight run
 * sampled at 1 unit doesn't ship as hundreds of points. Ramer–Douglas–Peucker.
 */
export function simplify(points: Pt[], epsilon: number): Pt[] {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    const a = points[first] as Pt;
    const b = points[last] as Pt;
    let max = -1;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistance(points[i] as Pt, a, b);
      if (d > max) {
        max = d;
        index = i;
      }
    }
    if (max > epsilon && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0
      ? 0
      : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function orientation(a: Pt, b: Pt, c: Pt): number {
  const v = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
  return Math.abs(v) < 1e-12 ? 0 : v > 0 ? 1 : 2;
}

function onSegment(a: Pt, b: Pt, c: Pt): boolean {
  return (
    b[0] <= Math.max(a[0], c[0]) &&
    b[0] >= Math.min(a[0], c[0]) &&
    b[1] <= Math.max(a[1], c[1]) &&
    b[1] >= Math.min(a[1], c[1])
  );
}

/** Whether segments p1–q1 and p2–q2 touch or cross. */
export function segmentsIntersect(p1: Pt, q1: Pt, p2: Pt, q2: Pt): boolean {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

/**
 * The first pair of non-adjacent edges of the closed polygon that touch or cross, or null.
 * O(n²), which is fine for room outlines.
 */
export function selfIntersection(polygon: Pt[]): [number, number] | null {
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const a1 = polygon[i] as Pt;
    const a2 = polygon[(i + 1) % n] as Pt;
    for (let j = i + 1; j < n; j++) {
      // Neighbouring edges share a vertex; that isn't a crossing.
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsIntersect(a1, a2, polygon[j] as Pt, polygon[(j + 1) % n] as Pt)) return [i, j];
    }
  }
  return null;
}
