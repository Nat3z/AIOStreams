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

/** A track's id and timescale, which its fragments' times count in. */
export interface VideoTrackInfo {
  trackId: number;
  timescale: number;
}

/** The video track of a whole `moov` box. */
export function videoTrackOf(moov: Buffer): VideoTrackInfo | undefined {
  return trackOf(moov, 'vide');
}

/** The audio track of a whole `moov` box. */
export function audioTrackOf(moov: Buffer): VideoTrackInfo | undefined {
  return trackOf(moov, 'soun');
}

function trackOf(
  moov: Buffer,
  handler: 'vide' | 'soun'
): VideoTrackInfo | undefined {
  const [root] = boxesIn(moov, 0, moov.length);
  if (root?.type !== 'moov') return undefined;
  for (const trak of boxesIn(moov, root.start, root.end)) {
    if (trak.type !== 'trak') continue;
    const tkhd = child(moov, trak, 'tkhd');
    const mdia = child(moov, trak, 'mdia');
    const hdlr = mdia && child(moov, mdia, 'hdlr');
    const mdhd = mdia && child(moov, mdia, 'mdhd');
    if (!tkhd || !hdlr || !mdhd) continue;
    if (moov.toString('latin1', hdlr.start + 8, hdlr.start + 12) !== handler)
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

interface TrackRun {
  trackId: number;
  /** The `tfdt` decode time, in the track's timescale. */
  decodeTime: number;
  durations: number[];
  sizes: number[];
  /** Each sample's bytes, cut out of the `mdat`. */
  samples: Buffer[];
}

/** The audio track's samples in a `moof` and the `mdat` after it. */
function trackRun(
  moof: Buffer,
  mdat: Buffer,
  trackId: number,
  defaults: { duration: number; size: number }
): TrackRun | undefined {
  const [root] = boxesIn(moof, 0, moof.length);
  if (root?.type !== 'moof') return undefined;
  for (const traf of boxesIn(moof, root.start, root.end)) {
    if (traf.type !== 'traf') continue;
    const tfhd = child(moof, traf, 'tfhd');
    if (!tfhd || moof.readUInt32BE(tfhd.start + 4) !== trackId) continue;
    const tfdt = child(moof, traf, 'tfdt');
    const trun = child(moof, traf, 'trun');
    if (!tfdt || !trun) return undefined;
    // tfhd's own defaults, after its flags and track id.
    const hflags = moof.readUIntBE(tfhd.start + 1, 3);
    let at = tfhd.start + 8;
    if (hflags & 0x1) at += 8;
    if (hflags & 0x2) at += 4;
    let duration = defaults.duration;
    let size = defaults.size;
    if (hflags & 0x8) duration = moof.readUInt32BE((at += 4) - 4);
    if (hflags & 0x10) size = moof.readUInt32BE((at += 4) - 4);
    const flags = moof.readUIntBE(trun.start + 1, 3);
    const count = moof.readUInt32BE(trun.start + 4);
    let p = trun.start + 8;
    // With default-base-is-moof, the offset counts from the moof's first byte.
    const dataOffset = flags & 0x1 ? moof.readInt32BE((p += 4) - 4) : 0;
    if (flags & 0x4) p += 4;
    const durations: number[] = [];
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      durations.push(
        flags & 0x100 ? moof.readUInt32BE((p += 4) - 4) : duration
      );
      sizes.push(flags & 0x200 ? moof.readUInt32BE((p += 4) - 4) : size);
      if (flags & 0x400) p += 4;
      if (flags & 0x800) p += 4;
    }
    // The mdat's payload starts 8 bytes in, right after the moof.
    let offset = dataOffset - moof.length - 8;
    const samples = sizes.map((n) => {
      const sample = mdat.subarray(8 + offset, 8 + offset + n);
      offset += n;
      return sample;
    });
    const decodeTime =
      moof[tfdt.start] === 1
        ? Number(moof.readBigUInt64BE(tfdt.start + 4))
        : moof.readUInt32BE(tfdt.start + 4);
    return { trackId, decodeTime, durations, sizes, samples };
  }
  return undefined;
}

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

function fullBox(
  type: string,
  version: number,
  flags: number,
  ...parts: Buffer[]
) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff));
  return box(type, head, ...parts);
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

/** A fragment of one track's samples, laid out as ffmpeg lays its own out. */
function audioFragment(run: TrackRun, sequence: number): Buffer {
  const tfdt = Buffer.alloc(8);
  tfdt.writeBigUInt64BE(BigInt(run.decodeTime));
  const entries = run.durations.flatMap((d, i) => [u32(d), u32(run.sizes[i])]);
  // Sample durations and sizes, and a data offset counted from the moof.
  const build = (dataOffset: number) =>
    box(
      'moof',
      fullBox('mfhd', 0, 0, u32(sequence)),
      box(
        'traf',
        fullBox('tfhd', 0, 0x020000, u32(run.trackId)),
        fullBox('tfdt', 1, 0, tfdt),
        fullBox(
          'trun',
          0,
          0x000301,
          u32(run.durations.length),
          u32(dataOffset),
          ...entries
        )
      )
    );
  const moof = build(0);
  return Buffer.concat([build(moof.length + 8), box('mdat', ...run.samples)]);
}

/**
 * Splits off the audio of a fragment that starts a segment which plays
 * before the fragment's first video frame shows, as a fragment of its own
 * to close the segment before. ffmpeg cuts fragments at video keyframes, so
 * without this the two sides of a cut leave a gap in the audio, and Safari
 * stalls on it. `before` is null when nothing needs to move.
 */
export function splitLeadingAudio(
  moof: Buffer,
  mdat: Buffer,
  audioTrackId: number,
  audioTimescale: number,
  /** When the fragment's first video frame shows, in seconds. */
  videoStart: number,
  sequence: number
): { before: Buffer; after: Buffer } | null {
  const run = trackRun(moof, mdat, audioTrackId, { duration: 1024, size: 0 });
  if (!run || !run.samples.length) return null;
  const startAt = Math.round(videoStart * audioTimescale);
  let cut = 0;
  let time = run.decodeTime;
  // Samples that end by the video's start belong before it.
  while (cut < run.durations.length && time + run.durations[cut] <= startAt) {
    time += run.durations[cut];
    cut++;
  }
  if (cut === 0) return null;
  const before = audioFragment(
    {
      ...run,
      durations: run.durations.slice(0, cut),
      sizes: run.sizes.slice(0, cut),
      samples: run.samples.slice(0, cut),
    },
    sequence
  );
  const rest = {
    ...run,
    decodeTime: time,
    durations: run.durations.slice(cut),
    sizes: run.sizes.slice(cut),
    samples: run.samples.slice(cut),
  };
  // The fragment keeps its video; its audio is now only what follows.
  const after = withoutTrack(moof, mdat, audioTrackId, rest);
  return after ? { before, after } : null;
}

/**
 * The fragment with one track's samples replaced by `rest`: its other
 * tracks kept as they are, followed by this track's remaining samples.
 */
function withoutTrack(
  moof: Buffer,
  mdat: Buffer,
  trackId: number,
  rest: TrackRun
): Buffer | null {
  const [root] = boxesIn(moof, 0, moof.length);
  if (root?.type !== 'moof') return null;
  const kept: { traf: Buffer; samples: Buffer }[] = [];
  let mfhd: Buffer | undefined;
  for (const b of boxesIn(moof, root.start, root.end)) {
    const whole = moof.subarray(b.start - 8, b.end);
    if (b.type === 'mfhd') mfhd = whole;
    if (b.type !== 'traf') continue;
    const tfhd = child(moof, b, 'tfhd');
    const id = tfhd ? moof.readUInt32BE(tfhd.start + 4) : -1;
    if (id === trackId) continue;
    const run = trackRun(moof, mdat, id, { duration: 0, size: 0 });
    if (!run) return null;
    kept.push({
      traf: Buffer.from(whole),
      samples: Buffer.concat(run.samples),
    });
  }
  if (!mfhd) return null;
  const restTfdt = Buffer.alloc(8);
  restTfdt.writeBigUInt64BE(BigInt(rest.decodeTime));
  const restEntries = rest.durations.flatMap((d, i) => [
    u32(d),
    u32(rest.sizes[i]),
  ]);
  const restTraf = (dataOffset: number) =>
    box(
      'traf',
      fullBox('tfhd', 0, 0x020000, u32(trackId)),
      fullBox('tfdt', 1, 0, restTfdt),
      fullBox(
        'trun',
        0,
        0x000301,
        u32(rest.durations.length),
        u32(dataOffset),
        ...restEntries
      )
    );
  // Each kept traf's trun points into the new mdat, in order.
  const layout = (offsets: number[], audioOffset: number) =>
    box(
      'moof',
      mfhd!,
      ...kept.map((k, i) => retarget(k.traf, offsets[i])),
      ...(rest.samples.length ? [restTraf(audioOffset)] : [])
    );
  const draft = layout(
    kept.map(() => 0),
    0
  );
  let offset = draft.length + 8;
  const offsets = kept.map((k) => {
    const at = offset;
    offset += k.samples.length;
    return at;
  });
  const out = layout(offsets, offset);
  return Buffer.concat([
    out,
    box('mdat', ...kept.map((k) => k.samples), ...rest.samples),
  ]);
}

/** A `traf` with its `trun` data offset set to `offset`. */
function retarget(traf: Buffer, offset: number): Buffer {
  const copy = Buffer.from(traf);
  const [root] = boxesIn(copy, 0, copy.length);
  const trun = root && child(copy, root, 'trun');
  if (!trun) return copy;
  const flags = copy.readUIntBE(trun.start + 1, 3);
  if (flags & 0x1) copy.writeInt32BE(offset, trun.start + 8);
  return copy;
}
