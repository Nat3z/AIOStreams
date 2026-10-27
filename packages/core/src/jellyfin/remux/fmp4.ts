/**
 * Just enough ISO BMFF to cut a fragmented MP4 stream into HLS segments: its
 * top-level boxes as they stream past, the times inside `moov` and `moof`,
 * and the video frames a damaged file leaves malformed.
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
  /** Temporal sub-layers, as one may decode from a lower one's unused picture; 0 when unknown. */
  layers: number;
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
      return {
        length: (moov[config.start + 4] & 3) + 1,
        hevc: false,
        layers: 1,
      };
    if (config.type === 'hvcC') {
      const at = moov[config.start + 21];
      return { length: (at & 3) + 1, hevc: true, layers: (at >> 3) & 7 };
    }
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

/** Bytes each `trun` field takes per sample, by its flag. */
const SAMPLE_FIELDS = [0x100, 0x200, 0x400, 0x800];

export interface TrimmedFragment {
  moof: Buffer;
  mdat: Buffer;
  /** Video samples dropped. */
  dropped: number;
}

/**
 * Drops the video frames whose NAL units run past their sample, as a damaged
 * block in the source leaves them. Safari fails a segment holding one and
 * closes the MediaSource, where it plays over missing frames. A frame nothing
 * decodes from goes alone; any other takes the rest of the fragment, which
 * runs to the next keyframe as each fragment starts at one, and a damaged
 * keyframe takes the fragment's video. Undefined when nothing is damaged.
 */
export function dropDamagedVideo(
  moof: Buffer,
  mdat: Buffer,
  video: VideoTrackInfo
): TrimmedFragment | undefined {
  const [root] = boxesIn(moof, 0, moof.length);
  if (!video.nal || root?.type !== 'moof' || mdat.readUInt32BE(0) === 1)
    return undefined;
  const trafs = boxesIn(moof, root.start, root.end).filter(
    (b) => b.type === 'traf'
  );
  const traf = trafs.find((t) => {
    const tfhd = child(moof, t, 'tfhd');
    return tfhd && moof.readUInt32BE(tfhd.start + 4) === video.trackId;
  });
  const tfhd = traf && child(moof, traf, 'tfhd');
  const truns = traf
    ? boxesIn(moof, traf.start, traf.end).filter((b) => b.type === 'trun')
    : [];
  // Offsets count from the moof, as `default_base_moof` writes them, and the
  // samples sit in one run.
  if (!tfhd || truns.length !== 1 || moof.readUIntBE(tfhd.start + 1, 3) & 0x1)
    return undefined;
  const [trun] = truns;
  const flags = moof.readUIntBE(trun.start + 1, 3);
  if (!(flags & 0x1) || !(flags & 0x200)) return undefined;
  const count = moof.readUInt32BE(trun.start + 4);
  const entries = trun.start + 12 + (flags & 0x4 ? 4 : 0);
  const entry = SAMPLE_FIELDS.filter((f) => flags & f).length * 4;
  const sizeAt = entries + (flags & 0x100 ? 4 : 0);
  // Where each sample sits in the mdat, which follows the moof.
  const starts: number[] = [];
  const sizes: number[] = [];
  let sample = moof.readInt32BE(trun.start + 8) - moof.length;
  for (let i = 0; i < count; i++) {
    const size = moof.readUInt32BE(sizeAt + i * entry);
    if (sample < 8 || sample + size > mdat.length) return undefined;
    starts.push(sample);
    sizes.push(size);
    sample += size;
  }
  const drop = new Set<number>();
  for (let i = 0; i < count; i++) {
    const end = starts[i] + sizes[i];
    if (wellFormed(mdat, starts[i], end, video.nal.length)) continue;
    // Alone only when the frame before can take its time, so those after keep theirs.
    if (
      i > 0 &&
      flags & 0x100 &&
      !referenced(mdat, starts[i], end, video.nal)
    ) {
      drop.add(i);
      continue;
    }
    for (let j = i; j < count; j++) drop.add(j);
    break;
  }
  if (!drop.size) return undefined;

  // Fields are written where they sit, then the cut bytes spliced out.
  const out = Buffer.from(moof);
  const cuts: [number, number][] = [];
  if (drop.size === count) {
    cuts.push([traf.start - 8, traf.end]);
  } else {
    let kept = 0;
    for (let i = 1; i < count; i++) {
      if (!drop.has(i)) {
        kept = i;
        continue;
      }
      cuts.push([entries + i * entry, entries + (i + 1) * entry]);
      if (flags & 0x100) {
        const at = entries + kept * entry;
        out.writeUInt32BE(
          out.readUInt32BE(at) + moof.readUInt32BE(entries + i * entry),
          at
        );
      }
    }
    out.writeUInt32BE(count - drop.size, trun.start + 4);
  }
  const cut = cuts.reduce((sum, [from, to]) => sum + to - from, 0);
  const boxes = drop.size === count ? [root] : [root, traf, trun];
  for (const box of boxes)
    out.writeUInt32BE(moof.readUInt32BE(box.start - 8) - cut, box.start - 8);
  // Every run's data moves up with the moof, and by the dropped bytes before it.
  for (const t of trafs) {
    if (t === traf && drop.size === count) continue;
    for (const run of boxesIn(moof, t.start, t.end)) {
      if (run.type !== 'trun' || !(moof.readUIntBE(run.start + 1, 3) & 0x1))
        continue;
      const offset = moof.readInt32BE(run.start + 8);
      let removed = 0;
      for (const i of drop)
        if (starts[i] < offset - moof.length) removed += sizes[i];
      out.writeInt32BE(offset - cut - removed, run.start + 8);
    }
  }
  const data = splice(
    mdat,
    [...drop].map((i) => [starts[i], starts[i] + sizes[i]])
  );
  data.writeUInt32BE(data.length, 0);
  return { moof: splice(out, cuts), mdat: data, dropped: drop.size };
}

/** A buffer without the given ascending byte ranges. */
function splice(buf: Buffer, cuts: [number, number][]): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  for (const [from, to] of cuts) {
    parts.push(buf.subarray(at, from));
    at = to;
  }
  parts.push(buf.subarray(at));
  return Buffer.concat(parts);
}

/** Whether a sample's NAL units each fit inside it. */
function wellFormed(
  mdat: Buffer,
  start: number,
  end: number,
  width: number
): boolean {
  let at = start;
  while (at + width <= end) {
    const length = mdat.readUIntBE(at, width);
    if (length === 0 || at + width + length > end) return false;
    at += width + length;
  }
  return at === end;
}

/**
 * Whether other frames may decode from a sample's picture, by its first
 * slice, which must be whole to be trusted.
 */
function referenced(
  mdat: Buffer,
  start: number,
  end: number,
  nal: NalFormat
): boolean {
  let at = start;
  while (at + nal.length + 1 < end) {
    const length = mdat.readUIntBE(at, nal.length);
    const head = at + nal.length;
    if (length === 0 || head + length > end) return true;
    if (nal.hevc) {
      // Sub-layer non-reference pictures take the even slice types to 14, and
      // only the top sub-layer's are left unused.
      const type = (mdat[head] >> 1) & 0x3f;
      const layer = (mdat[head + 1] & 7) - 1;
      if (type < 32)
        return type > 14 || type % 2 === 1 || layer !== nal.layers - 1;
    } else {
      const type = mdat[head] & 0x1f;
      if (type >= 1 && type <= 5) return ((mdat[head] >> 5) & 3) !== 0;
    }
    at = head + length;
  }
  return true;
}
