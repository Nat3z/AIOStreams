/**
 * Just enough ISO BMFF to cut a fragmented MP4 stream into HLS segments: its
 * top-level boxes as they stream past, and the times inside `moov` and `moof`.
 */

/** Gathers a byte stream into whole top-level boxes. */
export class BoxReader {
  private buffered: Buffer[] = [];
  private length = 0;

  constructor(private readonly onBox: (type: string, box: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.buffered.push(chunk);
    this.length += chunk.length;
    while (this.length >= 8) {
      const head = this.peek(16);
      let size = head.readUInt32BE(0);
      if (size === 1) {
        if (head.length < 16) return;
        size = Number(head.readBigUInt64BE(8));
      }
      if (size < 8) throw new Error('bad box size');
      if (this.length < size) return;
      const all = Buffer.concat(this.buffered);
      this.onBox(all.toString('latin1', 4, 8), all.subarray(0, size));
      const rest = all.subarray(size);
      this.buffered = rest.length ? [rest] : [];
      this.length = rest.length;
    }
  }

  private peek(bytes: number): Buffer {
    const first = this.buffered[0];
    if (first.length >= bytes || this.buffered.length === 1) return first;
    return Buffer.concat(this.buffered).subarray(0, bytes);
  }
}

interface Box {
  type: string;
  /** Payload offsets within the parsed buffer. */
  start: number;
  end: number;
}

function boxesIn(buf: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = buf.readUInt32BE(at);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) break;
    out.push({
      type: buf.toString('latin1', at + 4, at + 8),
      start: at + header,
      end: at + size,
    });
    at += size;
  }
  return out;
}

const child = (buf: Buffer, box: Box, type: string) =>
  boxesIn(buf, box.start, box.end).find((b) => b.type === type);

export interface VideoTrackInfo {
  trackId: number;
  timescale: number;
}

/** The video track of a whole `moov` box. */
export function videoTrackOf(moov: Buffer): VideoTrackInfo | undefined {
  const [root] = boxesIn(moov, 0, moov.length);
  if (root?.type !== 'moov') return undefined;
  for (const trak of boxesIn(moov, root.start, root.end)) {
    if (trak.type !== 'trak') continue;
    const tkhd = child(moov, trak, 'tkhd');
    const mdia = child(moov, trak, 'mdia');
    const hdlr = mdia && child(moov, mdia, 'hdlr');
    const mdhd = mdia && child(moov, mdia, 'mdhd');
    if (!tkhd || !hdlr || !mdhd) continue;
    if (moov.toString('latin1', hdlr.start + 8, hdlr.start + 12) !== 'vide')
      continue;
    const trackId = moov.readUInt32BE(
      tkhd.start + (moov[tkhd.start] === 1 ? 20 : 12)
    );
    const timescale = moov.readUInt32BE(
      mdhd.start + (moov[mdhd.start] === 1 ? 20 : 12)
    );
    return { trackId, timescale };
  }
  return undefined;
}

/** When a `moof`'s first video sample shows, in seconds. */
export function fragmentVideoTime(
  moof: Buffer,
  video: VideoTrackInfo
): number | undefined {
  const [root] = boxesIn(moof, 0, moof.length);
  if (root?.type !== 'moof') return undefined;
  for (const traf of boxesIn(moof, root.start, root.end)) {
    if (traf.type !== 'traf') continue;
    const tfhd = child(moof, traf, 'tfhd');
    if (!tfhd || moof.readUInt32BE(tfhd.start + 4) !== video.trackId) continue;
    const tfdt = child(moof, traf, 'tfdt');
    if (!tfdt) return undefined;
    let time =
      moof[tfdt.start] === 1
        ? Number(moof.readBigUInt64BE(tfdt.start + 4))
        : moof.readUInt32BE(tfdt.start + 4);
    // The first sample's composition offset, which B-frames make nonzero.
    const trun = child(moof, traf, 'trun');
    const flags = trun ? moof.readUIntBE(trun.start + 1, 3) : 0;
    if (trun && flags & 0x800 && moof.readUInt32BE(trun.start + 4) > 0) {
      let at = trun.start + 8;
      for (const field of [0x1, 0x4, 0x100, 0x200, 0x400])
        if (flags & field) at += 4;
      time +=
        moof[trun.start] === 1 ? moof.readInt32BE(at) : moof.readUInt32BE(at);
    }
    return time / video.timescale;
  }
  return undefined;
}
