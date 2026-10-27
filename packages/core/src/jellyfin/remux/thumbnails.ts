import { spawn } from 'node:child_process';
import { appConfig, createLogger } from '../../utils/index.js';
import { openLoopback } from '../../media-info/loopback.js';
import type { OpenedFile } from '../../media-info/probe.js';
import { matroskaKeyframes } from './keyframes.js';
import { keyframeSeek } from './session.js';

const logger = createLogger('thumbnails');

/** As wide as the apps' own, which the seek bar shows at up to 12rem. */
const WIDTH = 480;
/** Pictures kept across every file, a few tens of kilobytes each. */
const KEPT = 512;
/** Decodes at once across every file; each is a short ffmpeg run. */
const MAX_DECODES = 2;
const DECODE_TIMEOUT_MS = 20_000;
const IDLE_MS = 2 * 60_000;
/** A file that could not be opened isn't tried again for this long. */
const FAILED_MS = 5 * 60_000;
/** Without a keyframe index, pictures sit on a grid this many seconds apart. */
const GRID_S = 10;

export type ThumbnailResult =
  | { kind: 'picture'; positionMs: number; jpeg: Buffer }
  /** The picture on screen already, or a newer request took its turn. */
  | { kind: 'same' }
  /** The file gives no pictures. */
  | { kind: 'none' };

/** Recently made pictures, oldest first. */
const pictures = new Map<string, Buffer>();

function keep(key: string, jpeg: Buffer): void {
  pictures.delete(key);
  pictures.set(key, jpeg);
  if (pictures.size > KEPT) pictures.delete(pictures.keys().next().value!);
}

let decoding = 0;
const queued: (() => void)[] = [];

async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (decoding >= MAX_DECODES)
    await new Promise<void>((resolve) => queued.push(resolve));
  decoding++;
  try {
    return await run();
  } finally {
    decoding--;
    queued.shift()?.();
  }
}

/** One keyframe, scaled down, as a JPEG. */
function decode(url: string, seek: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      appConfig.jellyfin.remux.ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        // Only keyframes are decoded, so the first frame out is the one sought.
        '-skip_frame',
        'nokey',
        ...(seek > 0 ? ['-ss', seek.toFixed(3), '-noaccurate_seek'] : []),
        '-i',
        url,
        '-map',
        '0:V:0',
        '-frames:v',
        '1',
        '-vf',
        `scale=${WIDTH}:-2`,
        '-q:v',
        '5',
        '-f',
        'image2pipe',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const out: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), DECODE_TIMEOUT_MS);
    proc.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-500);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      clearTimeout(timer);
      const jpeg = Buffer.concat(out);
      if (code === 0 && jpeg.length) resolve(jpeg);
      else
        reject(
          new Error(stderr.trim().split('\n').pop() || `ffmpeg exited ${code}`)
        );
    });
  });
}

/** A file served to ffmpeg, and its keyframes where its index lists them. */
class FilePictures {
  private seq = 0;
  private turn: Promise<unknown> = Promise.resolve();
  lastUsed = Date.now();

  constructor(
    readonly key: string,
    private readonly url: string,
    private readonly keyframes: number[] | null,
    readonly close: () => void
  ) {}

  /** The keyframe at or before `ms`, in seconds. */
  private keyframeAt(ms: number): number {
    const s = Math.max(0, ms / 1000);
    if (!this.keyframes) return Math.floor(s / GRID_S) * GRID_S;
    let at = this.keyframes[0] ?? 0;
    for (const k of this.keyframes) {
      if (k > s) break;
      at = k;
    }
    return at;
  }

  at(ms: number, showingMs?: number): Promise<ThumbnailResult> {
    this.lastUsed = Date.now();
    const seconds = this.keyframeAt(ms);
    const positionMs = Math.round(seconds * 1000);
    if (positionMs === showingMs) return Promise.resolve({ kind: 'same' });
    const cacheKey = `${this.key}:${positionMs}`;
    const kept = pictures.get(cacheKey);
    if (kept)
      return Promise.resolve({ kind: 'picture', positionMs, jpeg: kept });
    // One decode at a time per file, and only for the newest request: the
    // seek bar has moved on from the ones a newer request overtook.
    const seq = ++this.seq;
    const result = this.turn.then(async (): Promise<ThumbnailResult> => {
      if (seq !== this.seq) return { kind: 'same' };
      const seek = this.keyframes
        ? keyframeSeek(this.keyframes, seconds)
        : seconds;
      const jpeg = await slot(() => decode(this.url, seek));
      keep(cacheKey, jpeg);
      return { kind: 'picture', positionMs, jpeg };
    });
    this.turn = result.catch(() => undefined);
    return result;
  }
}

const files = new Map<string, Promise<FilePictures | null>>();
const failed = new Map<string, number>();

async function openPictures(
  key: string,
  open: (signal: AbortSignal) => Promise<OpenedFile>
): Promise<FilePictures | null> {
  const abort = new AbortController();
  try {
    const file = await open(abort.signal);
    // Without an index, as for an MP4, ffmpeg seeks by the file's own.
    const keyframes = await matroskaKeyframes(file, abort.signal)
      .then((index) => (index.keyframes.length ? index.keyframes : null))
      .catch(() => null);
    const loopback = await openLoopback(file);
    return new FilePictures(key, loopback.url, keyframes, () => {
      abort.abort();
      void loopback.close().catch(() => undefined);
    });
  } catch (err) {
    abort.abort();
    failed.set(key, Date.now());
    logger.debug(
      { key, err: (err as Error).message },
      'file for thumbnails failed to open'
    );
    return null;
  }
}

const sweeper = setInterval(async () => {
  const now = Date.now();
  for (const [key, at] of failed) if (now - at > FAILED_MS) failed.delete(key);
  for (const [key, pending] of files) {
    const file = await pending;
    if (file && now - file.lastUsed <= IDLE_MS) continue;
    files.delete(key);
    file?.close();
  }
}, 30_000);
sweeper.unref();

/**
 * A picture of the keyframe at or before `ms` of a version's file, for the
 * seek bar of a player that makes none itself. `key` names the file; the
 * file stays open while pictures are asked for.
 */
export async function thumbnailAt(
  key: string,
  open: (signal: AbortSignal) => Promise<OpenedFile>,
  ms: number,
  showingMs?: number
): Promise<ThumbnailResult> {
  if (failed.has(key)) return { kind: 'none' };
  let pending = files.get(key);
  if (!pending) {
    pending = openPictures(key, open);
    files.set(key, pending);
  }
  const file = await pending;
  if (!file) {
    files.delete(key);
    return { kind: 'none' };
  }
  return file.at(ms, showingMs);
}
