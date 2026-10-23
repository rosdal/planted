/** Wire protocol version sent in the `hello` frame; see docs/design.md, "Wire protocol". */
export const PROTOCOL_VERSION = 1 as const;

export * from './api/errors';
export * from './api/rooms';
export * from './ids';
