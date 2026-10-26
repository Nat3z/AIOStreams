import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appConfig, createLogger } from '../../utils/index.js';
import { openLoopback } from '../../media-info/loopback.js';
import type { OpenedFile } from '../../media-info/probe.js';
import { parseCues } from '../subtitles.js';
import { matroskaKeyframes } from './keyframes.js';
import { BoxReader, fragmentVideoTime, videoTrackOf } from './fmp4.js';

const logger = createLogger('remux');

/** Segments are cut at the first keyframe at least this far past the last. */
const TARGET_SEGMENT_SECONDS = 6;
/**
 * Output timestamps are shifted this far ahead, so a file whose audio starts
 * before its video, or whose B-frames show late, never goes negative.
 */
const TIME_OFFSET = 10;
/** A segment further than this past the run's position starts a new run. */
const MAX_LOOKAHEAD = 4;
/** How far ffmpeg may get ahead of the last segment asked for. */
const BUFFER_AHEAD = 3;
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
}

export function remuxableSubtitle(codec: string | undefined): boolean {
  return !!codec && TEXT_SUBTITLE_CODECS.has(codec.toLowerCase());
}

interface Segment {
  bytes: Buffer;
}

export interface RemuxCue {
  startMs: number;
  endMs: number;
  text: string;
}

interface Waiter {
  resolve(segment: Segment | null): void;
  timer: NodeJS.Timeout;
}

/** One ffmpeg reading the file from a segment onwards. */
interface Run {
  proc: ChildProcess;
  /** The segment it writes next. */
  next: number;
  pending: Buffer[];
  ended: boolean;
}

/** One file remuxed with one audio track. */
export class RemuxSession {
  readonly id = randomBytes(12).toString('hex');
  /** Segment start times in seconds, and the end of the last. */
  readonly bounds: number[];
  private readonly segments = new Map<number, Segment>();
  private readonly waiters = new Map<number, Waiter[]>();
  private readonly restarts = new Map<number, number>();
  private subtitlePass: Promise<Map<number, RemuxCue[]>> | null = null;
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
    private readonly keyframes: number[],
    durationSeconds: number,
    private readonly onClose: () => void
  ) {
    this.bounds = segmentBounds(keyframes, durationSeconds);
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
    for (const at of this.segments.keys())
      if (at < n - KEEP_BEHIND || at > n + BUFFER_AHEAD + 1)
        this.segments.delete(at);
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
   * An embedded subtitle's cues, once one pass over the file has read them
   * all; null when it isn't one of this session's subtitles or the pass fails.
   */
  subtitleCues(streamIndex: number): Promise<RemuxCue[] | null> {
    this.touch();
    if (!this.source.subtitles.some((s) => s.streamIndex === streamIndex))
      return Promise.resolve(null);
    this.subtitlePass ??= readSubtitles(
      this.url,
      this.source.subtitles,
      this.subtitleAbort.signal
    );
    return this.subtitlePass.then(
      (all) => all.get(streamIndex) ?? [],
      () => {
        this.subtitlePass = null;
        return null;
      }
    );
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
    if (this.run.next > this.wanted + BUFFER_AHEAD) out.pause();
    else out.resume();
  }

  private start(from: number): void {
    if (this.closed) return;
    this.stop();
    // The player has moved on from what it waited for before the seek.
    for (const n of [...this.waiters.keys()])
      if (n < from) this.settle(n, null);
    const proc = spawn(
      appConfig.jellyfin.remux.ffmpegPath,
      ffmpegArgs(this.url, this.seekTime(from), this.source, this.audio),
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const run: Run = { proc, next: from, pending: [], ended: false };
    this.run = run;
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
    if (n === 0) return 0;
    const at = this.bounds[n];
    const next = this.keyframes.find((k) => k > at) ?? Infinity;
    return Math.min(at + SEEK_EARLY + 0.001, next - 0.001);
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
      const time = this.video && fragmentVideoTime(box, this.video);
      const boundary = this.bounds[run.next + 1];
      // A little early counts, as the index keeps milliseconds.
      if (
        time !== undefined &&
        boundary !== undefined &&
        time - TIME_OFFSET >= boundary - 0.02
      ) {
        let upTo = run.next + 1;
        while (time - TIME_OFFSET >= (this.bounds[upTo + 1] ?? Infinity) - 0.02)
          upTo++;
        this.finish(run, upTo);
      }
      run.pending.push(Buffer.from(box));
    } else if (type === 'mdat' && run.pending.length) {
      run.pending.push(Buffer.from(box));
    }
  }

  /** Closes the segment being written and any it ran past, which index a keyframe ffmpeg didn't cut at. */
  private finish(run: Run, upTo: number): void {
    if (run.next >= upTo) return;
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

/**
 * A file's text subtitles, read in one pass that demuxes nothing else. It
 * still reads every block of the file, but no faster than the store sends it.
 */
function readSubtitles(
  url: string,
  subtitles: RemuxTrack[],
  signal: AbortSignal
): Promise<Map<number, RemuxCue[]>> {
  const texts = subtitles.map(() => [] as Buffer[]);
  return new Promise((resolve, reject) => {
    const proc = spawn(
      appConfig.jellyfin.remux.ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-discard:v',
        'all',
        '-discard:a',
        'all',
        '-i',
        url,
        ...subtitles.flatMap((sub, i) => [
          '-map',
          sub.map,
          '-c:s',
          'webvtt',
          '-f',
          'webvtt',
          `pipe:${3 + i}`,
        ]),
      ],
      {
        stdio: [
          'ignore',
          'ignore',
          'pipe',
          ...subtitles.map(() => 'pipe' as const),
        ],
        signal,
      }
    );
    subtitles.forEach((_, i) =>
      (proc.stdio[3 + i] as NodeJS.ReadableStream).on('data', (c: Buffer) =>
        texts[i].push(c)
      )
    );
    let stderr = '';
    proc.stderr!.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString()).slice(-500);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg ${code}`));
        return;
      }
      resolve(
        new Map(
          subtitles.map((sub, i) => [
            sub.streamIndex,
            parseCues(Buffer.concat(texts[i]).toString('utf8')),
          ])
        )
      );
    });
  });
}

/** Keyframes at least a target length apart, from the file's start to its end. */
export function segmentBounds(
  keyframes: number[],
  durationSeconds: number
): number[] {
  const bounds = [0];
  for (const k of keyframes) {
    if (k >= durationSeconds - 1) break;
    if (k >= bounds[bounds.length - 1] + TARGET_SEGMENT_SECONDS) bounds.push(k);
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
    '-c:a',
    'aac',
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
  audioStreamIndex: number | undefined
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
  const work = openSession(source, audio);
  opening.set(sessionKey, work);
  void work.finally(() => opening.delete(sessionKey)).catch(() => undefined);
  return work;
}

async function openSession(
  source: RemuxSource,
  audio: RemuxTrack
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
    const loopback = await openLoopback(file);
    const session: RemuxSession = new RemuxSession(
      source,
      audio,
      loopback.url,
      index.keyframes,
      duration,
      () => {
        sessions.delete(session.id);
        logger.info({ session: session.id }, 'remux session closed');
        abort.abort();
        void loopback.close().catch(() => undefined);
      }
    );
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

export function remuxSessionById(id: string): RemuxSession | undefined {
  return sessions.get(id);
}

export function closeRemuxSessions(
  match: (session: RemuxSession) => boolean = () => true
): void {
  for (const session of [...sessions.values()])
    if (match(session)) session.close();
}
