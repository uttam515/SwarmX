import { expect } from 'chai';
import {
  BINARY_FRAME_MAGIC,
  HEADER_SIZE,
  MAX_JSON_HEADER_SIZE,
  MAX_PAYLOAD_SIZE,
  encodeBinaryFrame,
  decodeBinaryFrame
} from '../src/binary_framing';

describe('Binary Data Path & Zero-Copy Framing Security (Sprint 2.4A)', () => {
  it('1. Correctly encodes and decodes binary frame with zero corruption', () => {
    const metadata = {
      workloadId: 'wkl-bin-01',
      computation: { kernelId: 'image_filter_box_blur_v1' },
      data: { totalPayloadBytes: 1024, itemCount: 1 }
    };
    const rawPayload = Buffer.alloc(1024, 180);

    const frame = encodeBinaryFrame(metadata, rawPayload);
    expect(frame.readUInt32BE(0)).to.equal(BINARY_FRAME_MAGIC);
    expect(frame.length).to.be.greaterThan(1024 + HEADER_SIZE);

    const decoded = decodeBinaryFrame(frame);
    expect(decoded).to.not.be.null;
    expect(decoded!.metadata.workloadId).to.equal('wkl-bin-01');
    expect(decoded!.payload.length).to.equal(1024);
    expect(decoded!.payload[0]).to.equal(180);
    expect(decoded!.payload[1023]).to.equal(180);
  });

  it('2. Handles fragmented buffer accumulation gracefully', () => {
    const metadata = { test: true, data: { totalPayloadBytes: 500 } };
    const rawPayload = Buffer.alloc(500, 42);
    const frame = encodeBinaryFrame(metadata, rawPayload);

    // Split into 3 chunks
    const chunk1 = frame.subarray(0, 5);
    const chunk2 = frame.subarray(5, 200);
    const chunk3 = frame.subarray(200);

    let acc = Buffer.alloc(0);
    acc = Buffer.concat([acc, chunk1]);
    expect(decodeBinaryFrame(acc)).to.be.null; // Not enough for header

    acc = Buffer.concat([acc, chunk2]);
    expect(decodeBinaryFrame(acc)).to.be.null; // Header read, but payload incomplete

    acc = Buffer.concat([acc, chunk3]);
    const decoded = decodeBinaryFrame(acc);
    expect(decoded).to.not.be.null;
    expect(decoded!.payload.length).to.equal(500);
    expect(decoded!.payload[0]).to.equal(42);
  });

  it('3. Rejects invalid magic header gracefully', () => {
    const corrupted = Buffer.alloc(32, 0);
    corrupted.writeUInt32BE(0x12345678, 0);
    expect(decodeBinaryFrame(corrupted)).to.be.null;
  });

  it('4. Rejects oversized declared JSON metadata header', () => {
    const buf = Buffer.alloc(HEADER_SIZE + 100);
    buf.writeUInt32BE(BINARY_FRAME_MAGIC, 0);
    buf.writeUInt32BE(MAX_JSON_HEADER_SIZE + 1024, 4); // Exceeds 10MB limit
    expect(() => decodeBinaryFrame(buf)).to.throw(/Invalid or oversized JSON header/);
  });

  it('5. Rejects oversized declared binary payload', () => {
    const jsonStr = JSON.stringify({ data: { totalPayloadBytes: MAX_PAYLOAD_SIZE + 1024 * 1024 } });
    const jsonBuf = Buffer.from(jsonStr, 'utf-8');
    const buf = Buffer.alloc(HEADER_SIZE + jsonBuf.length);
    buf.writeUInt32BE(BINARY_FRAME_MAGIC, 0);
    buf.writeUInt32BE(jsonBuf.length, 4);
    jsonBuf.copy(buf, HEADER_SIZE);

    expect(() => decodeBinaryFrame(buf)).to.throw(/Oversized or negative payload/);
  });

  it('6. Rejects malformed JSON metadata in binary frame', () => {
    const corruptedJson = Buffer.from('{ "broken": [invalid json');
    const buf = Buffer.alloc(HEADER_SIZE + corruptedJson.length);
    buf.writeUInt32BE(BINARY_FRAME_MAGIC, 0);
    buf.writeUInt32BE(corruptedJson.length, 4);
    corruptedJson.copy(buf, HEADER_SIZE);

    expect(() => decodeBinaryFrame(buf)).to.throw(/Malformed binary frame metadata/);
  });

  it('7. Handles valid frame near large payload limit safely', () => {
    const metadata = { data: { totalPayloadBytes: 2048 } };
    const payload = Buffer.alloc(2048, 77);
    const frame = encodeBinaryFrame(metadata, payload);
    const decoded = decodeBinaryFrame(frame);
    expect(decoded).to.not.be.null;
    expect(decoded!.payload.length).to.equal(2048);
  });
});
