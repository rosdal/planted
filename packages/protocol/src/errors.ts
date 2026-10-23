export type ProtocolErrorCode =
  | 'short_frame'
  | 'unknown_channel'
  | 'unknown_type'
  | 'frame_too_large';

/** Thrown by `decodeFrame`. The server logs `code` and closes the socket with 4400. */
export class ProtocolError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}
