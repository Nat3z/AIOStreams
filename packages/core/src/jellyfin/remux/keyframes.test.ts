import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { matroskaKeyframes } from './keyframes.js';
import { segmentBounds } from './session.js';

/** An element: its id's bytes, an 8-byte size and the payload. */
function el(id: number[], ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(body.length) | (1n << 56n));
  return Buffer.concat([Buffer.from(id), size, body]);
}

const uint = (id: number[], value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return el(id, bytes);
};

const cuePoint = (ms: number, track: number) =>
  el([0xbb], uint([0xb3], ms), el([0xb7], uint([0xf7], track)));

/**
 * A file whose Tracks and Cues come after its clusters, as mkvmerge writes
 * them, found through the SeekHead at its start.
 */
function matroska(): Buffer {
  const info = el(
    [0x15, 0x49, 0xa9, 0x66],
    uint([0x2a, 0xd7, 0xb1], 1_000_000),
    el([0x44, 0x89], Buffer.from(new Float64Array([60_000]).buffer).reverse())
  );
  const tracks = el(
    [0x16, 0x54, 0xae, 0x6b],
    el([0xae], uint([0xd7], 1), uint([0x83], 2)),
    el([0xae], uint([0xd7], 2), uint([0x83], 1))
  );
  // Audio cues on track 1 must not count as keyframes.
  const cues = el(
    [0x1c, 0x53, 0xbb, 0x6b],
    cuePoint(0, 2),
    cuePoint(500, 1),
    cuePoint(6_125, 2),
    cuePoint(12_000, 2)
  );
  const clusters = Buffer.alloc(200_000);
  const seek = (id: number[], at: number) =>
    el([0x4d, 0xbb], el([0x53, 0xab], Buffer.from(id)), uint([0x53, 0xac], at));
  const seekHeadSize = (n: number) =>
    el([0x11, 0x4d, 0x9b, 0x74], ...Array(n).fill(seek([0, 0, 0, 0], 0)))
      .length;
  const head = seekHeadSize(3);
  const tracksAt = head + info.length + clusters.length;
  const cuesAt = tracksAt + tracks.length;
  const seekHead = el(
    [0x11, 0x4d, 0x9b, 0x74],
    seek([0x15, 0x49, 0xa9, 0x66], head),
    seek([0x16, 0x54, 0xae, 0x6b], tracksAt),
    seek([0x1c, 0x53, 0xbb, 0x6b], cuesAt)
  );
  return Buffer.concat([
    el([0x1a, 0x45, 0xdf, 0xa3]),
    el([0x18, 0x53, 0x80, 0x67], seekHead, info, clusters, tracks, cues),
  ]);
}

const reader = (file: Buffer) => ({
  size: file.length,
  open: async (start: number, end: number) =>
    Readable.from([file.subarray(start, end)]),
});

describe('matroskaKeyframes', () => {
  it("reads the video's cues through the SeekHead", async () => {
    const index = await matroskaKeyframes(
      reader(matroska()),
      new AbortController().signal
    );
    assert.deepEqual(index.keyframes, [0, 6.125, 12]);
    assert.equal(index.durationSeconds, 60);
  });

  it('refuses a file that is not Matroska', async () => {
    await assert.rejects(
      matroskaKeyframes(
        reader(Buffer.alloc(1024)),
        new AbortController().signal
      )
    );
  });
});

describe('segmentBounds', () => {
  it('cuts short segments first, then a target length apart, to the end', () => {
    assert.deepEqual(
      segmentBounds([0, 1, 2.5, 4, 5, 8, 9, 15.5, 22], 25),
      [0, 2.5, 5, 9, 15.5, 22, 25]
    );
  });

  it('cuts short segments again from where playback starts', () => {
    const keyframes = Array.from({ length: 60 }, (_, i) => i);
    const bounds = segmentBounds(keyframes, 60, 30.4);
    assert.deepEqual(
      bounds.filter((b) => b >= 24 && b <= 44),
      [26, 30, 32, 34, 38, 44]
    );
  });
});
