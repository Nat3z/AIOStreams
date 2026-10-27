import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appConfig, createLogger } from '../../utils/index.js';
import { openLoopback, type FileReader } from '../../media-info/loopback.js';
import { recordedClientIp } from '../../stream-sessions/client-ip.js';
import type { OpenedFile } from '../../media-info/probe.js';
import {
  matroskaAttachments,
  matroskaKeyframes,
  type Attachment,
} from './keyframes.js';
import {
  BoxReader,
  fragmentVideoTime,
  dropDamagedVideo,
  videoTrackOf,
} from './fmp4.js';

const logger = createLogger('remux');

/** Segments are cut at the first keyframe at least this far past the last. */
const TARGET_SEGMENT_SECONDS = 6;
/**
 * The first few are shorter, as a player waits for a whole segment before it
 * shows a frame, and a remux of a high-bitrate file is megabytes a second.
 */
const START_SEGMENT_SECONDS = [2, 2, 4];
/**
 * Output timestamps are shifted this far ahead, so a file whose audio starts
 * before its video, or whose B-frames show late, never goes negative.
 */
const TIME_OFFSET = 10;
/** A segment further than this past the run's position starts a new run. */
const MAX_LOOKAHEAD = 4;
/**
 * How far ffmpeg reads ahead of the last segment asked for, in seconds of
 * video. A phone on mobile data fetches a high-bitrate remux slower than it
 * plays, so a read that pauses close behind it leaves the phone waiting on
 * a restart over the store's CDN; ahead this far, it never catches up.
 */
const READ_AHEAD_S = 90;
/** Segments kept behind the last one asked for, for a short seek back. */
const KEEP_BEHIND = 1;
const SEGMENT_WAIT_MS = 60_000;
const IDLE_MS = 2 * 60_000;
/** A run that fails is restarted this often before the segment fails too. */
const MAX_RESTARTS = 2;
/** How far before its target ffmpeg seeks a file with B-frames, 3/23 s. */
const SEEK_EARLY = 3 / 23;
/** Browsers decode AAC up to 5.1 reliably. */
const MAX_CHANNELS = 6;
/** AAC's sample rate here, and the samples in each of its frames. */
const AAC_RATE = 48_000;
const AAC_FRAME = 1024;
/** The text formats ffmpeg here can turn into WebVTT. */
const TEXT_SUBTITLE_CODECS = new Set([
  'subrip',
  'srt',
  'ass',
  'ssa',
  'webvtt',
  'mov_text',
  'text',
]);
const ASS_CODECS = new Set(['ass', 'ssa']);
const PGS_CODECS = new Set(['hdmv_pgs_subtitle', 'pgssub']);

export interface RemuxTrack {
  /** The track's MediaStream index, as clients name it. */
  streamIndex: number;
  /** ffmpeg's `-map` for it, such as `0:2`. */
  map: string;
  channels?: number;
  codec?: string;
  default: boolean;
}

/** A version's file and the tracks of it that can be remuxed. */
export interface RemuxSource {
  /** The file and its play session, which play one audio track at a time. */
  key: string;
  open(signal: AbortSignal): Promise<OpenedFile>;
  video: string;
  audio: RemuxTrack[];
  subtitles: RemuxTrack[];
  durationMs?: number;
  /** The play session it was opened for, which a stop closes. */
  playSessionId: string;
  /** What the dashboard calls it: the file's name, else the version's label. */
  title: string;
  videoCodec?: string;
  viewer?: RemuxViewer;
}

/** Who a remux plays for, as the dashboard shows them. */
export interface RemuxViewer {
  name: string;
  client?: string;
  device?: string;
  ip?: string;
}

/**
 * What a session's ffmpeg is doing: reading, held back as it is far enough
 * ahead of the player, or not running at all.
 */
export type RemuxRunState = 'reading' | 'throttled' | 'stopped';

/** A session as the dashboard shows it. */
export interface RemuxSessionInfo {
  id: string;
  title: string;
  viewer?: RemuxViewer;
  playSessionId: string;
  videoCodec?: string;
  audio: { codec?: string; channels?: number; outputChannels: number };
  subtitles: number;
  durationSeconds: number;
  segments: number;
  /** Start of the last segment the player asked for, in seconds. */
  playhead: number;
  /** How far ffmpeg has cut segments, while it runs. */
  readTo?: number;
  state: RemuxRunState;
  /** Bytes ffmpeg read from the file, and bytes sent to the player. */
  bytesRead: number;
  bytesServed: number;
  /** ffmpeg runs that failed, each restarted or failing its segment. */
  failedRuns: number;
  droppedFrames: number;
  startedAt: number;
  /** Time since the player last asked for anything. */
  idleMs: number;
}

/**
 * How a remux delivers an embedded subtitle: `ass` keeps a styled script as
 * it is, `pgs` copies the pictures, and `vtt` converts the rest to WebVTT.
 */
export type RemuxSubtitleFormat = 'ass' | 'pgs' | 'vtt';

export function remuxSubtitleFormat(
  codec: string | undefined
): RemuxSubtitleFormat | undefined {
  const c = codec?.toLowerCase() ?? '';
  if (ASS_CODECS.has(c)) return 'ass';
  if (PGS_CODECS.has(c)) return 'pgs';
  return TEXT_SUBTITLE_CODECS.has(c) ? 'vtt' : undefined;
}

export const remuxableSubtitle = (codec: string | undefined) =>
  remuxSubtitleFormat(codec) !== undefined;

/**
 * An embedded subtitle as far as the runs have read it: a styled script's
 * header and the events after it, or PGS display sets, each kept once.
 */
export interface RemuxSubtitle {
  format: RemuxSubtitleFormat;
  data: Buffer;
  /** How far into the file it is read, in seconds. */
  readTo: number;
  /** It is read to the end. */
  complete: boolean;
}

/** One subtitle's pieces as runs write them. */
interface SubtitleStore {
  format: RemuxSubtitleFormat;
  /** A script's header, which every run writes the same. */
  header?: string;
  /** Events or display sets by their start, which runs that overlap write twice. */
  pieces: Map<string, { at: number; data: Buffer }>;
}

interface Segment {
  bytes: Buffer;
}

interface Waiter {
  resolve(segment: Segment | null): void;
  timer: NodeJS.Timeout;
}

/** One ffmpeg reading the file from a segment onwards. */
interface Run {
  proc: ChildProcess;
  /** The segment it began at, and the one it writes next. */
  from: number;
  next: number;
  pending: Buffer[];
  /** A fragment's moof, until its mdat arrives. */
  moof?: Buffer;
  ended: boolean;
}

/** One file remuxed with one audio track. */
export class RemuxSession {
  readonly id = randomBytes(12).toString('hex');
  readonly startedAt = Date.now();
  /** Bytes ffmpeg has read from the file, through the loopback. */
  bytesRead = 0;
  private bytesServed = 0;
  private failedRuns = 0;
  private droppedFrames = 0;
  /** Segment start times in seconds, and the end of the last. */
  readonly bounds: number[];
  private readonly segments = new Map<number, Segment>();
  private readonly waiters = new Map<number, Waiter[]>();
  private readonly restarts = new Map<number, number>();
  private readonly subtitles = new Map<number, SubtitleStore>();
  /** Time ranges every subtitle is read over, as runs cover them. */
  private readSpans: [number, number][] = [];
  private fonts: Promise<Attachment[]> | null = null;
  private run: Run | null = null;
  private init: Buffer | null = null;
  private ftyp: Buffer | null = null;
  private video: ReturnType<typeof videoTrackOf>;
  private readonly initWaiters: ((init: Buffer | null) => void)[] = [];
  private wanted = 0;
  private lastUsed = Date.now();
  private closed = false;
  private readonly idle: NodeJS.Timeout;
  private readonly subtitleAbort = new AbortController();

  constructor(
    readonly source: RemuxSource,
    readonly audio: RemuxTrack,
    private readonly url: string,
    private readonly file: OpenedFile,
    private readonly keyframes: number[],
    durationSeconds: number,
    startSeconds: number,
    private readonly onClose: () => void
  ) {
    this.bounds = segmentBounds(keyframes, durationSeconds, startSeconds);
    for (const sub of source.subtitles)
      this.subtitles.set(sub.streamIndex, {
        format: remuxSubtitleFormat(sub.codec) ?? 'vtt',
        pieces: new Map(),
      });
    this.idle = setInterval(() => {
      if (Date.now() - this.lastUsed > IDLE_MS) this.close();
    }, 30_000);
    this.idle.unref();
  }

  get count(): number {
    return this.bounds.length - 1;
  }

  touch(): void {
    this.lastUsed = Date.now();
  }

  /** Notes bytes sent to the player. */
  sent(bytes: number): void {
    this.bytesServed += bytes;
  }

  info(now = Date.now()): RemuxSessionInfo {
    const run = this.run;
    const viewer = this.source.viewer;
    return {
      id: this.id,
      title: this.source.title,
      viewer: viewer && { ...viewer, ip: recordedClientIp(viewer.ip) },
      playSessionId: this.source.playSessionId,
      videoCodec: this.source.videoCodec,
      audio: {
        codec: this.audio.codec,
        channels: this.audio.channels,
        outputChannels: Math.min(this.audio.channels ?? 2, MAX_CHANNELS),
      },
      subtitles: this.source.subtitles.length,
      durationSeconds: this.bounds[this.count],
      segments: this.count,
      playhead: this.bounds[this.wanted],
      readTo: run ? this.bounds[run.next] : undefined,
      state: !run
        ? 'stopped'
        : run.proc.stdout?.isPaused()
          ? 'throttled'
          : 'reading',
      bytesRead: this.bytesRead,
      bytesServed: this.bytesServed,
      failedRuns: this.failedRuns,
      droppedFrames: this.droppedFrames,
      startedAt: this.startedAt,
      idleMs: Math.max(0, now - this.lastUsed),
    };
  }

  /**
   * The `ftyp` and `moov` every segment plays after, which any run writes
   * first; a player resuming at `ms` gets one that goes on from there.
   */
  initSegment(ms = 0): Promise<Buffer | null> {
    this.touch();
    if (this.init) return Promise.resolve(this.init);
    if (!this.run) this.start(this.segmentAt(ms / 1000));
    return new Promise((resolve) => this.initWaiters.push(resolve));
  }

  segment(n: number): Promise<Segment | null> {
    this.touch();
    if (this.closed || n < 0 || n >= this.count) return Promise.resolve(null);
    this.wanted = n;
    const ahead = this.segmentAt(this.bounds[n] + READ_AHEAD_S) + 1;
    for (const at of this.segments.keys())
      if (at < n - KEEP_BEHIND || at > ahead) this.segments.delete(at);
    const have = this.segments.get(n);
    const run = this.run;
    if (!have && (!run || n < run.next || n > run.next + MAX_LOOKAHEAD))
      this.start(n);
    else this.flow();
    if (have) return Promise.resolve(have);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(n, null), SEGMENT_WAIT_MS);
      this.waiters.set(n, [...(this.waiters.get(n) ?? []), { resolve, timer }]);
    });
  }

  /**
   * An embedded subtitle as far as the runs have read the file around `at`
   * seconds. The video run writes it as it reads, so this costs no read of
   * its own; null when it isn't one of this session's.
   */
  subtitle(streamIndex: number, at = 0): RemuxSubtitle | null {
    this.touch();
    const store = this.subtitles.get(streamIndex);
    if (!store) return null;
    const pieces = [...store.pieces.values()].sort((a, b) => a.at - b.at);
    const span = this.readSpans.find(([from, to]) => from <= at && at <= to);
    const readTo = span?.[1] ?? at;
    const end = this.bounds[this.count];
    const data =
      store.format === 'pgs'
        ? Buffer.concat(pieces.map((p) => p.data))
        : Buffer.from(
            (store.header ?? '') +
              pieces.map((p) => p.data.toString('utf8')).join(''),
            'utf8'
          );
    return {
      format: store.format,
      data,
      readTo,
      complete: !!span && span[0] <= 0 && readTo >= end,
    };
  }

  /** The fonts the file carries for its styled subtitles. */
  attachedFonts(): Promise<Attachment[]> {
    this.touch();
    this.fonts ??= matroskaAttachments(this.file, this.subtitleAbort.signal)
      .then((all) => all.filter((a) => isFont(a)))
      .catch(() => []);
    return this.fonts;
  }

  /** Stores what a run's subtitle output carried, piece by piece. */
  private collect(streamIndex: number, chunk: string | Buffer): void {
    const store = this.subtitles.get(streamIndex);
    if (!store) return;
    if (store.format === 'pgs') {
      // Display sets end with an END segment; their PTS is their start.
      const buf = chunk as Buffer;
      let at = 0;
      while (
        at + 13 <= buf.length &&
        buf[at] === 0x50 &&
        buf[at + 1] === 0x47
      ) {
        const size = 13 + buf.readUInt16BE(at + 11);
        if (at + size > buf.length) break;
        const pts = buf.readUInt32BE(at + 2) / 90000;
        const key = `${pts}:${buf.subarray(at + 10, at + size).toString('base64')}`;
        store.pieces.set(key, { at: pts, data: buf.subarray(at, at + size) });
        at += size;
      }
      return;
    }
    const text = chunk as string;
    if (store.format === 'ass') {
      const events = text.indexOf('[Events]');
      if (store.header === undefined && events >= 0) {
        const format = text.indexOf('\n', text.indexOf('Format:', events));
        store.header = text.slice(0, format + 1);
      }
      for (const line of text.split('\n')) {
        if (!line.startsWith('Dialogue:')) continue;
        const start = /^Dialogue:\s*[^,]*,([^,]*)/.exec(line)?.[1] ?? '';
        store.pieces.set(line, {
          at: assSeconds(start),
          data: Buffer.from(line + '\n'),
        });
      }
      return;
    }
    // WebVTT: the header once, then a cue per block.
    for (const block of text.split(/\n{2,}/)) {
      if (!block.includes('-->')) {
        if (store.header === undefined && block.startsWith('WEBVTT'))
          store.header = 'WEBVTT\n\n';
        continue;
      }
      const start = /([\d:.]+)\s*-->/.exec(block)?.[1] ?? '';
      store.pieces.set(block, {
        at: vttSeconds(start),
        data: Buffer.from(block.trim() + '\n\n'),
      });
    }
  }

  /** Notes that every subtitle is read from `from` to `to` seconds. */
  private markRead(from: number, to: number): void {
    const spans = [...this.readSpans, [from, to] as [number, number]].sort(
      (a, b) => a[0] - b[0]
    );
    const merged: [number, number][] = [];
    for (const [a, b] of spans) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1] + 0.5) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    this.readSpans = merged;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.idle);
    this.stop();
    this.subtitleAbort.abort();
    for (const n of [...this.waiters.keys()]) this.settle(n, null);
    for (const resolve of this.initWaiters.splice(0)) resolve(null);
    this.segments.clear();
    this.onClose();
  }

  private settle(n: number, segment: Segment | null): void {
    for (const w of this.waiters.get(n) ?? []) {
      clearTimeout(w.timer);
      w.resolve(segment);
    }
    this.waiters.delete(n);
  }

  private stop(): void {
    if (!this.run) return;
    this.run.ended = true;
    this.run.proc.kill('SIGKILL');
    this.run = null;
  }

  /** ffmpeg blocks on a full pipe, so a paused player stops the reads. */
  private flow(): void {
    const out = this.run?.proc.stdout;
    if (!out || !this.run) return;
    const limit = this.bounds[this.wanted] + READ_AHEAD_S;
    if ((this.bounds[this.run.next] ?? Infinity) > limit) out.pause();
    else out.resume();
  }

  private start(from: number): void {
    if (this.closed) return;
    this.stop();
    // The player has moved on from what it waited for before the seek.
    for (const n of [...this.waiters.keys()])
      if (n < from) this.settle(n, null);
    const subs = this.source.subtitles;
    const proc = spawn(
      appConfig.jellyfin.remux.ffmpegPath,
      ffmpegArgs(this.url, this.seekTime(from), this.source, this.audio),
      { stdio: ['ignore', 'pipe', 'pipe', ...subs.map(() => 'pipe' as const)] }
    );
    const run: Run = {
      proc,
      from: this.bounds[from],
      next: from,
      pending: [],
      ended: false,
    };
    this.run = run;
    subs.forEach((sub, i) => {
      const pipe = proc.stdio[3 + i] as NodeJS.ReadableStream;
      const pgs = this.subtitles.get(sub.streamIndex)?.format === 'pgs';
      // A piece can arrive split, so the tail waits for the rest.
      let held: Buffer = Buffer.alloc(0);
      pipe.on('data', (chunk: Buffer) => {
        if (run.ended) return;
        const all = Buffer.concat([held, chunk]);
        let cut = all.length;
        if (pgs) {
          cut = 0;
          while (cut + 13 <= all.length) {
            const size = 13 + all.readUInt16BE(cut + 11);
            if (cut + size > all.length) break;
            cut += size;
          }
          this.collect(sub.streamIndex, all.subarray(0, cut));
        } else {
          cut = all.lastIndexOf(0x0a) + 1;
          this.collect(sub.streamIndex, all.subarray(0, cut).toString('utf8'));
        }
        held = all.subarray(cut);
      });
    });
    logger.debug({ session: this.id, from }, 'remux run started');

    let stderr = '';
    proc.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-1000);
    });
    const boxes = new BoxReader((type, box) => this.onBox(run, type, box));
    proc.stdout!.on('data', (chunk: Buffer) => {
      if (run.ended) return;
      try {
        boxes.push(chunk);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'remux output unreadable');
        this.stop();
      }
    });
    proc.on('error', (err) => {
      logger.warn({ err: err.message }, 'ffmpeg could not start');
    });
    proc.on('close', (code) => {
      if (this.run !== run || run.ended) return;
      run.ended = true;
      this.run = null;
      if (code === 0) {
        this.finish(run, this.count);
        return;
      }
      logger.warn(
        { session: this.id, code, err: stderr.trim().split('\n').pop() },
        'remux run failed'
      );
      this.failedRuns++;
      // A debrid link that dropped mid-play is read again from where it was.
      const tries = (this.restarts.get(run.next) ?? 0) + 1;
      this.restarts.set(run.next, tries);
      if (this.waiters.size && tries <= MAX_RESTARTS) {
        this.start(Math.min(...this.waiters.keys()));
        return;
      }
      for (const n of [...this.waiters.keys()]) this.settle(n, null);
      if (!this.init) for (const r of this.initWaiters.splice(0)) r(null);
    });
  }

  private segmentAt(seconds: number): number {
    let n = 0;
    while (n + 1 < this.count && this.bounds[n + 1] <= seconds) n++;
    return n;
  }

  /**
   * Where to seek for segment `n` to land on its keyframe: ffmpeg seeks a
   * Matroska file with B-frames this far before the time it is given.
   */
  private seekTime(n: number): number {
    return n === 0 ? 0 : keyframeSeek(this.keyframes, this.bounds[n]);
  }

  private onBox(run: Run, type: string, box: Buffer): void {
    if (type === 'ftyp') {
      this.ftyp ??= Buffer.from(box);
    } else if (type === 'moov') {
      // Every run writes the same tracks, so the first one's stands.
      if (!this.init) {
        this.video = videoTrackOf(box);
        this.init = Buffer.concat([this.ftyp ?? Buffer.alloc(0), box]);
        for (const resolve of this.initWaiters.splice(0)) resolve(this.init);
      }
    } else if (type === 'moof') {
      // Held until its mdat, as the two are mended and cut together.
      run.moof = Buffer.from(box);
    } else if (type === 'mdat' && run.moof) {
      const moof = run.moof;
      run.moof = undefined;
      this.onFragment(run, moof, Buffer.from(box));
    }
  }

  private onFragment(run: Run, moof: Buffer, mdat: Buffer): void {
    const time = this.video && fragmentVideoTime(moof, this.video);
    const trimmed = this.video && dropDamagedVideo(moof, mdat, this.video);
    if (trimmed) {
      ({ moof, mdat } = trimmed);
      this.droppedFrames += trimmed.dropped;
      logger.warn(
        {
          session: this.id,
          at: time && time - TIME_OFFSET,
          dropped: trimmed.dropped,
        },
        'damaged video frames dropped'
      );
    }
    const boundary = this.bounds[run.next + 1];
    // A little early counts, as the index keeps milliseconds.
    if (
      time === undefined ||
      boundary === undefined ||
      time - TIME_OFFSET < boundary - 0.02
    ) {
      run.pending.push(moof, mdat);
      return;
    }
    let upTo = run.next + 1;
    while (time - TIME_OFFSET >= (this.bounds[upTo + 1] ?? Infinity) - 0.02)
      upTo++;
    this.finish(run, upTo);
    run.pending.push(moof, mdat);
  }

  /** Closes the segment being written and any it ran past, which index a keyframe ffmpeg didn't cut at. */
  private finish(run: Run, upTo: number): void {
    if (run.next >= upTo) return;
    // A cue comes out once the video passes it, so what is cut is read.
    this.markRead(run.from, this.bounds[upTo]);
    const segment = { bytes: Buffer.concat(run.pending) };
    run.pending = [];
    for (let n = run.next; n < upTo; n++) {
      // The skipped ones repeat it, which a player plays over without a gap.
      this.segments.set(n, segment);
      this.settle(n, segment);
    }
    if (upTo - run.next > 1)
      logger.debug(
        { session: this.id, from: run.next, upTo },
        'segments merged'
      );
    run.next = upTo;
    this.flow();
  }
}

/** Where to seek a Matroska file for ffmpeg to start at keyframe `at`. */
export function keyframeSeek(keyframes: number[], at: number): number {
  if (at <= 0) return 0;
  const next = keyframes.find((k) => k > at) ?? Infinity;
  return Math.min(at + SEEK_EARLY + 0.001, next - 0.001);
}

const FONT_FILE = /\.(ttf|otf|ttc|woff2?)$/i;

function isFont(a: Attachment): boolean {
  return (
    /font|truetype|opentype|sfnt/i.test(a.mimeType) || FONT_FILE.test(a.name)
  );
}

/** ffmpeg's output for one subtitle, in the form it is delivered in. */
const SUBTITLE_OUTPUT: Record<RemuxSubtitleFormat, string[]> = {
  // Events come out as they are read, not held back for their read order.
  ass: ['-c:s', 'copy', '-f', 'ass', '-ignore_readorder', '1'],
  pgs: ['-c:s', 'copy', '-f', 'sup'],
  vtt: ['-c:s', 'webvtt', '-f', 'webvtt'],
};

function assSeconds(time: string): number {
  const [h, m, sec] = time.trim().split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60 + (sec || 0);
}

function vttSeconds(time: string): number {
  const parts = time.trim().split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + (part || 0), 0);
}

/**
 * Keyframes at least a target length apart, from the file's start to its end,
 * cut short from 0 and from `startSeconds`, where playback begins.
 */
export function segmentBounds(
  keyframes: number[],
  durationSeconds: number,
  startSeconds = 0
): number[] {
  const bounds = [0];
  // How many segments the current short run has had.
  let short = 0;
  let restarted = startSeconds <= 0;
  for (const k of keyframes) {
    if (k >= durationSeconds - 1) break;
    if (!restarted && k > startSeconds) {
      // The keyframe playback starts from begins a segment of its own.
      restarted = true;
      const at = keyframes.filter((f) => f <= startSeconds).pop();
      if (at !== undefined && at > bounds[bounds.length - 1]) bounds.push(at);
      short = 0;
    }
    const target = START_SEGMENT_SECONDS[short] ?? TARGET_SEGMENT_SECONDS;
    if (k >= bounds[bounds.length - 1] + target) {
      bounds.push(k);
      short++;
    }
  }
  bounds.push(durationSeconds);
  return bounds;
}

function ffmpegArgs(
  url: string,
  from: number,
  source: RemuxSource,
  audio: RemuxTrack
): string[] {
  const channels = Math.min(audio.channels ?? 2, MAX_CHANNELS);
  // Every run's AAC frames sit on one grid from the file's start, the frame
  // before the seek first, so a segment from a run that began elsewhere
  // meets its neighbour exactly. Safari drops the audio and jumps back on a
  // frame that overlaps the one before it by even a few samples.
  const firstFrame = Math.max(0, Math.floor((from * AAC_RATE) / AAC_FRAME) - 1);
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    ...(from > 0 ? ['-ss', from.toFixed(3), '-noaccurate_seek'] : []),
    // The file's own timestamps, which every run then shares.
    '-copyts',
    '-i',
    url,
    '-map',
    source.video,
    '-map',
    audio.map,
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-c:v',
    'copy',
    '-af',
    `aresample=${AAC_RATE}:async=1:first_pts=${firstFrame * AAC_FRAME}`,
    '-c:a',
    'aac',
    '-ar',
    String(AAC_RATE),
    '-ac',
    String(channels),
    '-b:a',
    channels > 2 ? '384k' : '192k',
    '-output_ts_offset',
    String(TIME_OFFSET),
    '-avoid_negative_ts',
    'disabled',
    // An edit list would shift B-frame times by a different amount each run.
    '-use_editlist',
    '0',
    '-movflags',
    '+frag_keyframe+empty_moov+default_base_moof+frag_discont',
    '-f',
    'mp4',
    'pipe:1',
    ...source.subtitles.flatMap((sub, i) => [
      '-map',
      sub.map,
      ...SUBTITLE_OUTPUT[remuxSubtitleFormat(sub.codec) ?? 'vtt'],
      '-flush_packets',
      '1',
      `pipe:${3 + i}`,
    ]),
  ];
}

const sessions = new Map<string, RemuxSession>();
const opening = new Map<string, Promise<RemuxSession>>();

export class RemuxLimitError extends Error {}

/**
 * The session for a version's file and one of its audio tracks, opening one
 * when none runs. Only Matroska files with a keyframe index can be remuxed.
 */
export function remuxSession(
  source: RemuxSource,
  audioStreamIndex: number | undefined,
  /** Where playback begins, which gets short segments for a quick start. */
  startSeconds = 0
): Promise<RemuxSession> {
  // Without a track named, the one playing, or about to, will do.
  if (audioStreamIndex === undefined) {
    const playing = [...sessions.values()].find(
      (s) => s.source.key === source.key
    );
    if (playing) {
      playing.touch();
      return Promise.resolve(playing);
    }
    const starting = [...opening.entries()].find(([key]) =>
      key.startsWith(`${source.key}:`)
    );
    if (starting) return starting[1];
  }
  const audio =
    source.audio.find((a) => a.streamIndex === audioStreamIndex) ??
    source.audio.find((a) => a.default) ??
    source.audio[0];
  if (!audio) return Promise.reject(new Error('no audio track to remux'));
  const sessionKey = `${source.key}:${audio.streamIndex}`;
  const existing = [...sessions.values()].find(
    (s) =>
      s.source.key === source.key && s.audio.streamIndex === audio.streamIndex
  );
  if (existing) {
    existing.touch();
    return Promise.resolve(existing);
  }
  const pending = opening.get(sessionKey);
  if (pending) return pending;
  const work = openSession(source, audio, startSeconds);
  opening.set(sessionKey, work);
  void work.finally(() => opening.delete(sessionKey)).catch(() => undefined);
  return work;
}

async function openSession(
  source: RemuxSource,
  audio: RemuxTrack,
  startSeconds: number
): Promise<RemuxSession> {
  // Another audio track of the same file replaces its session.
  closeRemuxSessions((s) => s.source.key === source.key);
  if (sessions.size >= appConfig.jellyfin.remux.maxSessions)
    throw new RemuxLimitError('too many remuxes running');
  const abort = new AbortController();
  try {
    const file = await source.open(abort.signal);
    const index = await matroskaKeyframes(file, abort.signal);
    const duration =
      index.durationSeconds ??
      (source.durationMs ? source.durationMs / 1000 : undefined);
    if (!duration) throw new Error('unknown duration');
    const reader: FileReader = {
      size: file.size,
      open: (start, end, signal) => file.open(start, end, signal),
    };
    const loopback = await openLoopback(reader);
    const session: RemuxSession = new RemuxSession(
      source,
      audio,
      loopback.url,
      file,
      index.keyframes,
      duration,
      startSeconds,
      () => {
        sessions.delete(session.id);
        logger.info({ session: session.id }, 'remux session closed');
        abort.abort();
        void loopback.close().catch(() => undefined);
      }
    );
    // Set before ffmpeg, the loopback's only reader, first starts.
    reader.onRead = (bytes) => {
      session.bytesRead += bytes;
    };
    sessions.set(session.id, session);
    logger.info(
      { session: session.id, segments: session.count },
      'remux session opened'
    );
    return session;
  } catch (err) {
    abort.abort();
    throw err;
  }
}

/** Every remux on this instance, newest first, and the ones still opening. */
export function remuxOverview(): {
  sessions: RemuxSessionInfo[];
  opening: number;
} {
  const now = Date.now();
  return {
    sessions: [...sessions.values()]
      .map((s) => s.info(now))
      .sort((a, b) => b.startedAt - a.startedAt),
    opening: opening.size,
  };
}

export function remuxSessionById(id: string): RemuxSession | undefined {
  return sessions.get(id);
}

export function closeRemuxSessions(
  match: (session: RemuxSession) => boolean = () => true
): void {
  for (const session of [...sessions.values()])
    if (match(session)) session.close();
}
