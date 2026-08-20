import { Buffer } from 'buffer';

export const BINARY_FRAME_MAGIC = 0x5357524d; // ASCII 'SWRM'
export const HEADER_SIZE = 8; // 4 bytes magic + 4 bytes json_len

export const MAX_JSON_HEADER_SIZE = 10 * 1024 * 1024; // 10MB maximum JSON metadata
export const MAX_PAYLOAD_SIZE = 512 * 1024 * 1024; // 512MB maximum raw binary payload
export const MAX_TOTAL_FRAME_SIZE = HEADER_SIZE + MAX_JSON_HEADER_SIZE + MAX_PAYLOAD_SIZE;

export interface DecodedBinaryFrame {
  metadata: any;
  payload: Buffer;
  totalLength: number;
}

/**
 * Encodes a JSON metadata object and raw binary buffer into a high-performance binary frame:
 * [ 4-byte magic (SWRM) | 4-byte JSON length (BE) | JSON UTF-8 bytes | Raw Payload Bytes ]
 */
export function encodeBinaryFrame(metadata: any, payload: Buffer): Buffer {
  if (metadata && typeof metadata === 'object') {
    if (metadata.result && typeof metadata.result === 'object') {
      metadata.result.totalPayloadBytes = payload.length;
    } else {
      metadata.totalPayloadBytes = payload.length;
    }
  }

  const jsonBuf = Buffer.from(JSON.stringify(metadata), 'utf-8');
  if (jsonBuf.length > MAX_JSON_HEADER_SIZE) {
    throw new Error(`JSON metadata size ${jsonBuf.length} exceeds maximum allowed limit ${MAX_JSON_HEADER_SIZE}`);
  }
  if (payload.length > MAX_PAYLOAD_SIZE) {
    throw new Error(`Payload size ${payload.length} exceeds maximum allowed limit ${MAX_PAYLOAD_SIZE}`);
  }

  const frame = Buffer.allocUnsafe(HEADER_SIZE + jsonBuf.length + payload.length);
  frame.writeUInt32BE(BINARY_FRAME_MAGIC, 0);
  frame.writeUInt32BE(jsonBuf.length, 4);
  jsonBuf.copy(frame, HEADER_SIZE);
  payload.copy(frame, HEADER_SIZE + jsonBuf.length);

  return frame;
}

/**
 * Attempts to decode a binary frame from a streaming buffer accumulator with strict bounds validation.
 * Returns null if buffer does not yet contain a complete frame.
 * Throws an Error if the frame header is corrupted, oversized, or violates safety bounds.
 */
export function decodeBinaryFrame(buffer: Buffer): DecodedBinaryFrame | null {
  if (buffer.length < HEADER_SIZE) {
    return null;
  }

  const magic = buffer.readUInt32BE(0);
  if (magic !== BINARY_FRAME_MAGIC) {
    return null;
  }

  const jsonLen = buffer.readUInt32BE(4);
  if (jsonLen === 0 || jsonLen > MAX_JSON_HEADER_SIZE) {
    throw new Error(`Invalid or oversized JSON header length (${jsonLen} bytes, max ${MAX_JSON_HEADER_SIZE})`);
  }

  if (buffer.length < HEADER_SIZE + jsonLen) {
    return null; // Header not fully received yet
  }

  const jsonStr = buffer.toString('utf-8', HEADER_SIZE, HEADER_SIZE + jsonLen);
  let metadata: any;
  try {
    metadata = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Malformed binary frame metadata: ${err}`);
  }

  const declaredPayload =
    metadata?.totalPayloadBytes ??
    metadata?.result?.totalPayloadBytes ??
    metadata?.params?.workload?.data?.totalPayloadBytes ??
    metadata?.params?.workload?.totalPayloadBytes ??
    metadata?.params?.totalPayloadBytes ??
    metadata?.workload?.data?.totalPayloadBytes ??
    metadata?.data?.totalPayloadBytes;

  if (declaredPayload !== undefined && (declaredPayload < 0 || declaredPayload > MAX_PAYLOAD_SIZE)) {
    throw new Error(`Oversized or negative payload declared in binary frame: ${declaredPayload} bytes`);
  }

  const totalPayloadBytes = declaredPayload !== undefined
    ? declaredPayload
    : buffer.length - (HEADER_SIZE + jsonLen);

  const totalFrameSize = HEADER_SIZE + jsonLen + totalPayloadBytes;
  if (totalFrameSize > MAX_TOTAL_FRAME_SIZE) {
    throw new Error(`Total binary frame size ${totalFrameSize} exceeds maximum allowable frame size ${MAX_TOTAL_FRAME_SIZE}`);
  }

  if (buffer.length < totalFrameSize) {
    return null; // Full payload not yet received
  }

  const payload = buffer.subarray(HEADER_SIZE + jsonLen, totalFrameSize);
  if (declaredPayload !== undefined && payload.length !== declaredPayload) {
    throw new Error(`Binary payload length mismatch: expected ${declaredPayload} bytes, got ${payload.length} bytes`);
  }

  return {
    metadata,
    payload,
    totalLength: totalFrameSize
  };
}
