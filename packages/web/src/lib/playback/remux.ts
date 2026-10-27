import { t } from '@lingui/core/macro';
import type Hls from 'hls.js';
import type { SourceInfo } from '@/lib/jellyfin/types';
import { ofType, trackLabel } from './controller';
import type { EngineTrack } from './engine';
import { tracePlayback } from './playback-trace';
import { chooseTracks } from './track-picks';
import type { PlaybackPrefs } from '../user-config';

/**
 * The tracks of a remuxed version, which the server lists as the browser
 * can't: its audio as `server:` ids, as the reporter reads them back.
 */
export function remuxTracks(source: SourceInfo): EngineTrack[] {
  return ofType(source, 'Audio').map((s, i) => ({
    id: `server:${s.Index}`,
    type: 'audio',
    label: trackLabel(s, i + 1),
    lang: s.Language ?? undefined,
    title: s.Title ?? undefined,
    codec: s.Codec ?? undefined,
    default: s.IsDefault ?? false,
  }));
}

/**
 * The audio track to remux first: the one the player's picks will settle on,
 * as switching starts the remux over.
 */
export function remuxAudio(
  source: SourceInfo,
  prefs: PlaybackPrefs
): string | null {
  const tracks = remuxTracks(source);
  const server = source.DefaultAudioStreamIndex;
  const current =
    server === undefined || server === null ? null : `server:${server}`;
  return (
    chooseTracks(
      tracks,
      [],
      { audio: current, subtitle: null },
      prefs,
      source,
      false
    ).audio ?? current
  );
}

const hasMediaSource = () =>
  typeof (window as { MediaSource?: unknown }).MediaSource === 'function' ||
  typeof (window as { ManagedMediaSource?: unknown }).ManagedMediaSource ===
    'function';

/** Whether the page can play HLS, through hls.js or natively. */
function playsHls(): boolean {
  return (
    hasMediaSource() ||
    !!document
      .createElement('video')
      .canPlayType('application/vnd.apple.mpegurl')
  );
}

/** The video codecs this browser decodes in MP4, as ffmpeg names them. */
function videoCodecs(): string[] {
  const types: [string, string][] = [
    ['h264', 'avc1.640029'],
    ['hevc', 'hvc1.1.6.L120.90'],
    ['av1', 'av01.0.08M.08'],
    ['vp9', 'vp09.00.40.08'],
  ];
  type Source = { isTypeSupported(t: string): boolean };
  const ms =
    (window as { MediaSource?: Source }).MediaSource ??
    (window as { ManagedMediaSource?: Source }).ManagedMediaSource;
  const video = document.createElement('video');
  return types
    .filter(([, codec]) => {
      const type = `video/mp4; codecs="${codec}"`;
      return ms?.isTypeSupported(type) || !!video.canPlayType(type);
    })
    .map(([name]) => name);
}

/**
 * Asks the server to remux what this browser can't play as it is, naming the
 * video it decodes, as the remux only repackages it.
 */
export function remuxProfile(): object[] {
  if (!playsHls()) return [];
  return [
    {
      Type: 'Video',
      Protocol: 'hls',
      Container: 'mp4',
      VideoCodec: videoCodecs().join(','),
      AudioCodec: 'aac',
    },
  ];
}

/** Plays `url` as a remux when it is the server's one for this version. */
export function remuxUrl(source: SourceInfo, url: string) {
  const path = source.TranscodingUrl;
  if (!path || source.TranscodingSubProtocol !== 'hls' || !url.endsWith(path))
    return null;
  return {
    play(
      el: HTMLVideoElement,
      opts: {
        audio: string | null;
        startMs: number;
        onError: (message: string) => void;
      }
    ): { stop(): void } {
      const index = opts.audio?.replace(/^server:/, '');
      const address = new URL(url, window.location.href);
      if (index) address.searchParams.set('AudioStreamIndex', index);
      // Its first read starts where the player does.
      if (opts.startMs)
        address.searchParams.set(
          'StartTimeTicks',
          String(Math.round(opts.startMs * 10_000))
        );
      return playHls(el, address.href, opts.startMs / 1000, opts.onError);
    },
  };
}

/** Sends a playback trace to the server's client log, signed as the remux is. */
function traceSender(url: string): (text: string) => void {
  const address = new URL(url);
  const log = new URL(
    address.pathname.replace(/\/Videos\/.*$/, '/ClientLog/Document'),
    address
  );
  const token = address.searchParams.get('ApiKey');
  if (token) log.searchParams.set('ApiKey', token);
  return (text) =>
    void fetch(log, {
      method: 'POST',
      body: text,
      headers: { 'Content-Type': 'text/plain' },
      keepalive: true,
    }).catch(() => {});
}

/** A hole closer than this ahead of the playhead is jumped before it stalls on it. */
const HOLE_LEAD_S = 0.25;
/** Holes longer than this are left to hls.js, as they are no dropped frames. */
const MAX_HOLE_S = 1.5;

/**
 * Jumps the holes a remux leaves where it dropped damaged frames, just before
 * playback reaches them, rather than after it stalls there, as hls.js does.
 * Only a hole inside a segment already buffered counts, so a segment still
 * loading is waited for.
 */
function skipHoles(
  el: HTMLVideoElement,
  hls: Hls,
  Events: typeof Hls.Events
): () => void {
  const segments: { start: number; end: number }[] = [];
  const onBuffered = (
    _: unknown,
    { frag }: { frag: { start: number; end: number } }
  ) => {
    segments.push({ start: frag.start, end: frag.end });
    if (segments.length > 50) segments.shift();
  };
  hls.on(Events.FRAG_BUFFERED, onBuffered);
  const timer = setInterval(() => {
    if (el.paused || el.seeking) return;
    const now = el.currentTime;
    const ranges = el.buffered;
    for (let i = 0; i + 1 < ranges.length; i++) {
      const from = ranges.end(i);
      const to = ranges.start(i + 1);
      if (ranges.start(i) > now || from < now) continue;
      if (from - now > HOLE_LEAD_S || to - from > MAX_HOLE_S) return;
      if (segments.some((s) => s.start <= from && to <= s.end + 0.1))
        el.currentTime = to + 0.01;
      return;
    }
  }, 100);
  return () => {
    clearInterval(timer);
    hls.off(Events.FRAG_BUFFERED, onBuffered);
  };
}

function playHls(
  el: HTMLVideoElement,
  url: string,
  start: number,
  onError: (message: string) => void
): { stop(): void } {
  let hls: Hls | null = null;
  let stopped = false;
  let untrace = () => {};
  const send = traceSender(url);
  // Only where hls.js can't run, as on an iPhone: Chrome now says it plays HLS
  // too, but reads from the start before it seeks.
  if (!hasMediaSource() && el.canPlayType('application/vnd.apple.mpegurl')) {
    untrace = tracePlayback(el, null, send);
    el.src = url;
    return {
      stop: () => {
        untrace();
        el.removeAttribute('src');
        el.load();
      },
    };
  }
  void import('hls.js').then(({ default: HlsPlayer }) => {
    if (stopped) return;
    if (!HlsPlayer.isSupported()) {
      onError(
        t({
          comment: 'Follows "Playback failed:"',
          message: 'this browser cannot play streams.',
        })
      );
      return;
    }
    hls = new HlsPlayer({
      // A segment may wait on the file being read from the start of a seek.
      fragLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 60_000,
          maxLoadTimeMs: 120_000,
          timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
          errorRetry: {
            maxNumRetry: 3,
            retryDelayMs: 1000,
            maxRetryDelayMs: 8000,
          },
        },
      },
      // The server reads a minute and a half ahead, so a segment is waiting
      // for the player; 30 s ahead is enough to ride out a slow one.
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      // A cut can leave a few hundredths of a second between audio and
      // video, which is played over rather than treated as a stall.
      maxBufferHole: 0.5,
      // A remux keeps the file's bitrate, often 20-40 Mbit/s, and Safari on an
      // iPhone evicts what is playing once a page's buffer passes ~300 MB,
      // which drops the audio and throws playback back. So played video is let
      // go after a short while, and what is buffered ahead stays small.
      backBufferLength: 10,
      maxBufferSize: 60 * 1000 * 1000,
      // Its first segment is the one with the start, not the first, which
      // a bandwidth test would fetch, though there is one variant to pick.
      startPosition: start || undefined,
      testBandwidth: false,
    });
    // A reset MediaSource starts over at the start position, the video
    // having been emptied by then, so it is moved along with playback, and
    // past a segment that failed twice, which would fail every time.
    let playedTo = start;
    const failed = new Set<number | string>();
    el.addEventListener('timeupdate', () => {
      if (el.currentTime > 0) playedTo = el.currentTime;
    });
    // One recovery, as a decoder that can't take the video fails every time.
    let recovered = false;
    hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
      if (
        hls &&
        (data.details === HlsPlayer.ErrorDetails.MEDIA_SOURCE_REQUIRES_RESET ||
          (data.fatal && data.type === HlsPlayer.ErrorTypes.MEDIA_ERROR))
      ) {
        const frag = data.frag;
        const again = frag !== undefined && failed.has(frag.sn);
        if (frag) failed.add(frag.sn);
        hls.config.startPosition =
          again && frag ? Math.max(playedTo, frag.end + 0.1) : playedTo;
      }
      if (!data.fatal) return;
      if (data.type === HlsPlayer.ErrorTypes.MEDIA_ERROR && !recovered) {
        recovered = true;
        hls?.recoverMediaError();
        return;
      }
      if (data.type === HlsPlayer.ErrorTypes.MEDIA_ERROR) {
        hls?.destroy();
        hls = null;
        onError(
          t({
            comment: 'Follows "Playback failed:"',
            message:
              "this browser cannot play this version's video, which the server only repackages. Try another version, an external player or the desktop app.",
          })
        );
        return;
      }
      onError(
        data.response?.code === 503
          ? t({
              comment: 'Follows "Playback failed:"',
              message: 'the server is converting as many versions as it can.',
            })
          : t({
              comment: 'Follows "Playback failed:"',
              message: 'the server could not convert this version.',
            })
      );
    });
    const untraceOnly = tracePlayback(el, hls, send);
    const unskip = skipHoles(el, hls, HlsPlayer.Events);
    untrace = () => {
      untraceOnly();
      unskip();
    };
    hls.loadSource(url);
    hls.attachMedia(el);
  });
  return {
    stop: () => {
      stopped = true;
      untrace();
      hls?.destroy();
      hls = null;
      el.removeAttribute('src');
      el.load();
    },
  };
}
