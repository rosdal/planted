/**
 * Deterministic JSON: object keys sorted, so the same data always gives the same bytes and the
 * same hash. `pretty` indents objects but keeps arrays of plain values (points) on one line, which
 * keeps committed `map.json` files readable in a diff.
 */
export function stableStringify(value: unknown, pretty = false): string {
  return `${write(value, pretty, '')}${pretty ? '\n' : ''}`;
}

function write(value: unknown, pretty: boolean, indent: string): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`cannot write ${value} as JSON`);
    }
    // -0 and 0 must not differ in output.
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const flat = value.every((v) => v === null || typeof v !== 'object');
    const items = value.map((v) => write(v, pretty, inner));
    if (!pretty) return `[${items.join(',')}]`;
    if (flat) return `[${items.join(', ')}]`;
    return `[\n${items.map((i) => inner + i).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return '{}';
  const items = entries.map(
    ([k, v]) => `${JSON.stringify(k)}:${pretty ? ' ' : ''}${write(v, pretty, inner)}`,
  );
  if (!pretty) return `{${items.join(',')}}`;
  return `{\n${items.map((i) => inner + i).join(',\n')}\n${indent}}`;
}
