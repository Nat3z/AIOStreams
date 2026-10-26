import {
  EBML_HEADER_ID,
  readElementId,
  readElementSize,
  SEGMENT_ID,
} from '../../usenet/ebml/varint.js';
import type { FileReader } from '../../media-info/loopback.js';

const SEEK_HEAD_ID = 0x114d9b74;
const SEEK_ID = 0x4dbb;
const SEEK_ID_ID = 0x53ab;
const SEEK_POSITION_ID = 0x53ac;
const INFO_ID = 0x1549a966;
const TIMESTAMP_SCALE_ID = 0x2ad7b1;
const DURATION_ID = 0x4489;
const TRACKS_ID = 0x1654ae6b;
const TRACK_ENTRY_ID = 0xae;
const TRACK_NUMBER_ID = 0xd7;
const TRACK_TYPE_ID = 0x83;
const CUES_ID = 0x1c53bb6b;
const CUE_POINT_ID = 0xbb;
const CUE_TIME_ID = 0xb3;
const CUE_TRACK_POSITIONS_ID = 0xb7;
const CUE_TRACK_ID = 0xf7;
const ATTACHMENTS_ID = 0x1941a469;
const ATTACHED_FILE_ID = 0x61a7;
const FILE_NAME_ID = 0x466e;
const FILE_MIME_TYPE_ID = 0x4660;
const FILE_DATA_ID = 0x465c;

const HEAD_BYTES = 64 * 1024;
/**
 * Cues for hours of video are tens of kilobytes, but an anime release can
 * carry tens of megabytes of fonts; anything past this is not one.
 */
const MAX_ELEMENT_BYTES = 128 * 1024 * 1024;

interface Element {
  id: number;
  /** Absolute offsets in the file. */
  start: number;
  dataStart: number;
  size: number;
}

export interface Attachment {
  name: string;
  mimeType: string;
  data: Buffer;
}

export interface KeyframeIndex {
  /** Presentation times of the video's keyframes, ascending. */
  keyframes: number[];
  durationSeconds?: number;
}

async function readRange(
  file: FileReader,
  start: number,
  end: number,
  signal: AbortSignal
): Promise<Buffer> {
  const stream = await file.open(start, Math.min(end, file.size), signal);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** The elements in `buf[from, to)`, where `base` is `buf[0]`'s file offset. */
function elementsIn(
  buf: Buffer,
  from: number,
  to: number,
  base: number
): Element[] {
  const out: Element[] = [];
  let pos = from;
  while (pos < to) {
    const id = readElementId(buf, pos);
    const size = id && readElementSize(buf, pos + id.len);
    if (!id || !size) break;
    const dataStart = pos + id.len + size.len;
    const length = size.unknown ? to - dataStart : size.size;
    out.push({
      id: id.id,
      start: base + pos,
      dataStart: base + dataStart,
      size: length,
    });
    pos = dataStart + length;
  }
  return out;
}

function uint(buf: Buffer, at: number, size: number): number {
  let n = 0;
  for (let i = 0; i < size; i++) n = n * 256 + buf[at + i];
  return n;
}

function float(buf: Buffer, at: number, size: number): number | undefined {
  if (size === 4) return buf.readFloatBE(at);
  if (size === 8) return buf.readDoubleBE(at);
  return undefined;
}

/** An element's payload, from `head` when it holds all of it. */
async function payloadOf(
  file: FileReader,
  el: Element,
  head: Buffer,
  signal: AbortSignal
): Promise<Buffer> {
  if (el.size > MAX_ELEMENT_BYTES) throw new Error('header element too large');
  const end = el.dataStart + el.size;
  if (end <= head.length) return head.subarray(el.dataStart, end);
  return readRange(file, el.dataStart, end, signal);
}

/** The element whose header starts at `at`. */
async function elementAt(
  file: FileReader,
  at: number,
  signal: AbortSignal
): Promise<Element | undefined> {
  const header = await readRange(file, at, at + 16, signal);
  return elementsIn(header, 0, header.length, at)[0];
}

/** The top-level elements of a Matroska file, found through its SeekHead. */
async function matroskaElements(file: FileReader, signal: AbortSignal) {
  const head = await readRange(file, 0, HEAD_BYTES, signal);
  const [ebml, segment] = elementsIn(head, 0, head.length, 0);
  if (ebml?.id !== EBML_HEADER_ID || segment?.id !== SEGMENT_ID) {
    throw new Error('not a Matroska file');
  }
  const segmentStart = segment.dataStart;
  const found = new Map<number, Element>();
  for (const el of elementsIn(head, segmentStart, head.length, 0)) {
    if (!found.has(el.id)) found.set(el.id, el);
  }

  // The SeekHead points at the rest, often at the end of the file.
  const positions = new Map<number, number>();
  const readSeekHead = async (el: Element) => {
    const body = await payloadOf(file, el, head, signal);
    for (const seek of elementsIn(body, 0, body.length, el.dataStart)) {
      if (seek.id !== SEEK_ID) continue;
      const at = seek.dataStart - el.dataStart;
      let id: number | undefined;
      let position: number | undefined;
      for (const f of elementsIn(body, at, at + seek.size, el.dataStart)) {
        const off = f.dataStart - el.dataStart;
        if (f.id === SEEK_ID_ID) id = uint(body, off, f.size);
        if (f.id === SEEK_POSITION_ID) position = uint(body, off, f.size);
      }
      if (id !== undefined && position !== undefined && !positions.has(id))
        positions.set(id, segmentStart + position);
    }
  };
  const seekHead = found.get(SEEK_HEAD_ID);
  if (seekHead) await readSeekHead(seekHead);
  // mkvmerge can point at a second SeekHead near the end.
  const second = positions.get(SEEK_HEAD_ID);
  if (second !== undefined && second !== seekHead?.start) {
    const el = await elementAt(file, second, signal);
    if (el?.id === SEEK_HEAD_ID) await readSeekHead(el);
  }

  const locate = async (id: number) => {
    const known = found.get(id);
    if (known) return known;
    const at = positions.get(id);
    if (at === undefined) return undefined;
    const el = await elementAt(file, at, signal);
    return el?.id === id ? el : undefined;
  };
  const payload = (el: Element) => payloadOf(file, el, head, signal);
  return { locate, payload };
}

/**
 * The keyframes of a Matroska file's video, from its Cues index, without
 * reading its clusters. Throws when the file has no such index.
 */
export async function matroskaKeyframes(
  file: FileReader,
  signal: AbortSignal
): Promise<KeyframeIndex> {
  const { locate, payload } = await matroskaElements(file, signal);
  const [info, tracks, cues] = await Promise.all([
    locate(INFO_ID),
    locate(TRACKS_ID),
    locate(CUES_ID),
  ]);
  if (!tracks || !cues) throw new Error('no keyframe index');

  let scale = 1_000_000;
  let duration: number | undefined;
  if (info) {
    const body = await payload(info);
    for (const f of elementsIn(body, 0, body.length, info.dataStart)) {
      const off = f.dataStart - info.dataStart;
      if (f.id === TIMESTAMP_SCALE_ID) scale = uint(body, off, f.size);
      if (f.id === DURATION_ID) duration = float(body, off, f.size);
    }
  }

  const trackBody = await payload(tracks);
  let videoTrack: number | undefined;
  for (const entry of elementsIn(trackBody, 0, trackBody.length, 0)) {
    if (entry.id !== TRACK_ENTRY_ID) continue;
    let number: number | undefined;
    let type: number | undefined;
    for (const f of elementsIn(
      trackBody,
      entry.dataStart,
      entry.dataStart + entry.size,
      0
    )) {
      if (f.id === TRACK_NUMBER_ID)
        number = uint(trackBody, f.dataStart, f.size);
      if (f.id === TRACK_TYPE_ID) type = uint(trackBody, f.dataStart, f.size);
    }
    if (type === 1 && number !== undefined) {
      videoTrack = number;
      break;
    }
  }
  if (videoTrack === undefined) throw new Error('no video track');

  const cueBody = await payload(cues);
  const times: number[] = [];
  for (const point of elementsIn(cueBody, 0, cueBody.length, 0)) {
    if (point.id !== CUE_POINT_ID) continue;
    let time: number | undefined;
    let video = false;
    const end = point.dataStart + point.size;
    for (const f of elementsIn(cueBody, point.dataStart, end, 0)) {
      if (f.id === CUE_TIME_ID) time = uint(cueBody, f.dataStart, f.size);
      if (f.id !== CUE_TRACK_POSITIONS_ID) continue;
      for (const p of elementsIn(
        cueBody,
        f.dataStart,
        f.dataStart + f.size,
        0
      )) {
        if (
          p.id === CUE_TRACK_ID &&
          uint(cueBody, p.dataStart, p.size) === videoTrack
        )
          video = true;
      }
    }
    if (video && time !== undefined) times.push((time * scale) / 1e9);
  }
  if (!times.length) throw new Error('no video keyframes indexed');
  times.sort((a, b) => a - b);
  return {
    keyframes: times.filter((t, i) => i === 0 || t !== times[i - 1]),
    durationSeconds:
      duration !== undefined ? (duration * scale) / 1e9 : undefined,
  };
}

/**
 * The files a Matroska file carries, such as the fonts its styled subtitles
 * use. Most keep them at the start, so this reads a little of the file.
 */
export async function matroskaAttachments(
  file: FileReader,
  signal: AbortSignal
): Promise<Attachment[]> {
  const { locate, payload } = await matroskaElements(file, signal);
  const attachments = await locate(ATTACHMENTS_ID);
  if (!attachments) return [];
  const body = await payload(attachments);
  const out: Attachment[] = [];
  for (const entry of elementsIn(body, 0, body.length, 0)) {
    if (entry.id !== ATTACHED_FILE_ID) continue;
    let name = '';
    let mimeType = '';
    let data: Buffer | undefined;
    const end = entry.dataStart + entry.size;
    for (const f of elementsIn(body, entry.dataStart, end, 0)) {
      const bytes = body.subarray(f.dataStart, f.dataStart + f.size);
      if (f.id === FILE_NAME_ID) name = bytes.toString('utf8');
      if (f.id === FILE_MIME_TYPE_ID) mimeType = bytes.toString('utf8');
      if (f.id === FILE_DATA_ID) data = Buffer.from(bytes);
    }
    if (data) out.push({ name, mimeType, data });
  }
  return out;
}
