/**
 * Just enough ISO BMFF to cut a fragmented MP4 stream into HLS segments: its
 * top-level boxes as they stream past, the times inside `moov` and `moof`,
 * and the video samples a damaged file leaves malformed.
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
  /** How an H.264 or HEVC track's samples are split into NAL units. */
  nal: NalFormat | undefined;
}

interface NalFormat {
  /** Bytes giving each unit's length. */
  length: number;
  hevc: boolean;
}

/** The NAL length size an `avc1` or `hvc1` sample entry declares. */
function nalFormatOf(moov: Buffer, mdia: Box): NalFormat | undefined {
  const stbl = ['minf', 'stbl'].reduce<Box | undefined>(
    (box, type) => box && child(moov, box, type),
    mdia
  );
  const stsd = stbl && child(moov, stbl, 'stsd');
  // A full box with an entry count, then the visual sample entry's 78 bytes.
  const [entry] = stsd ? boxesIn(moov, stsd.start + 8, stsd.end) : [];
  if (!entry) return undefined;
  for (const config of boxesIn(moov, entry.start + 78, entry.end)) {
    if (config.type === 'avcC')
      return { length: (moov[config.start + 4] & 3) + 1, hevc: false };
    if (config.type === 'hvcC')
      return { length: (moov[config.start + 21] & 3) + 1, hevc: true };
  }
  return undefined;
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
    return { trackId, timescale, nal: nalFormatOf(moov, mdia) };
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

/** NAL unit type 12, which a decoder skips. */
const H264_FILLER = 0x0c;
const HEVC_FILLER = 38 << 1;

/**
 * Mends, in place, video samples whose NAL units run past the sample, as a
 * damaged block in the source leaves them: from the first bad length on, the
 * sample is one filler unit, which a decoder skips. Safari otherwise fails
 * the segment and closes the MediaSource. Returns how many were mended.
 */
export function repairVideoSamples(
  moof: Buffer,
  mdat: Buffer,
  video: VideoTrackInfo
): number {
  const [root] = boxesIn(moof, 0, moof.length);
  if (!video.nal || root?.type !== 'moof') return 0;
  let mended = 0;
  for (const traf of boxesIn(moof, root.start, root.end)) {
    if (traf.type !== 'traf') continue;
    const tfhd = child(moof, traf, 'tfhd');
    if (!tfhd || moof.readUInt32BE(tfhd.start + 4) !== video.trackId) continue;
    const tfhdFlags = moof.readUIntBE(tfhd.start + 1, 3);
    // Offsets count from the moof, as `default_base_moof` writes them.
    if (tfhdFlags & 0x1) return mended;
    let at = tfhd.start + 8;
    for (const field of [0x2, 0x8]) if (tfhdFlags & field) at += 4;
    const defaultSize = tfhdFlags & 0x10 ? moof.readUInt32BE(at) : 0;
    for (const trun of boxesIn(moof, traf.start, traf.end)) {
      if (trun.type !== 'trun') continue;
      const flags = moof.readUIntBE(trun.start + 1, 3);
      const count = moof.readUInt32BE(trun.start + 4);
      let field = trun.start + 8;
      if (!(flags & 0x1)) return mended;
      // Where the samples sit in the mdat, which follows the moof.
      let sample = moof.readInt32BE(field) - moof.length;
      field += flags & 0x4 ? 8 : 4;
      for (let i = 0; i < count; i++) {
        if (flags & 0x100) field += 4;
        const size = flags & 0x200 ? moof.readUInt32BE(field) : defaultSize;
        if (flags & 0x200) field += 4;
        if (flags & 0x400) field += 4;
        if (flags & 0x800) field += 4;
        if (sample < 0 || sample + size > mdat.length) return mended;
        if (mendSample(mdat, sample, sample + size, video.nal)) mended++;
        sample += size;
      }
    }
  }
  return mended;
}

function mendSample(
  mdat: Buffer,
  start: number,
  end: number,
  { length: width, hevc }: NalFormat
): boolean {
  let at = start;
  while (at + width <= end) {
    const length = mdat.readUIntBE(at, width);
    if (length > 0 && at + width + length <= end) {
      at += width + length;
      continue;
    }
    // A filler unit needs its header and the closing stop bit.
    const rest = end - at - width;
    if (rest < (hevc ? 3 : 2)) return false;
    mdat.writeUIntBE(rest, at, width);
    mdat.fill(0xff, at + width, end - 1);
    mdat[end - 1] = 0x80;
    if (hevc) {
      mdat[at + width] = HEVC_FILLER;
      mdat[at + width + 1] = 1;
    } else mdat[at + width] = H264_FILLER;
    return true;
  }
  return false;
}
