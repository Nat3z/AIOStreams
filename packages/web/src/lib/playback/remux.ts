import { t } from '@lingui/core/macro';
import type Hls from 'hls.js';
import type { SourceInfo } from '@/lib/jellyfin/types';
import { ofType, trackLabel } from './controller';
import type { EngineTrack } from './engine';

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

/** The server's pick, which the player's own picks then replace. */
export function remuxAudio(source: SourceInfo): string | null {
  const index =
    source.DefaultAudioStreamIndex ?? ofType(source, 'Audio')[0]?.Index;
  return index === undefined || index === null ? null : `server:${index}`;
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

function playHls(
  el: HTMLVideoElement,
  url: string,
  start: number,
  onError: (message: string) => void
): { stop(): void } {
  let hls: Hls | null = null;
  let stopped = false;
  // Only where hls.js can't run, as on an iPhone: Chrome now says it plays HLS
  // too, but reads from the start before it seeks.
  if (!hasMediaSource() && el.canPlayType('application/vnd.apple.mpegurl')) {
    el.src = url;
    return {
      stop: () => {
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
      // The server reads ahead of what is asked for, so asking far ahead costs it.
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      // Its first segment is the one with the start, not the first, which
      // a bandwidth test would fetch, though there is one variant to pick.
      startPosition: start || undefined,
      testBandwidth: false,
    });
    // One recovery, as a decoder that can't take the video fails every time.
    let recovered = false;
    hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
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
    hls.loadSource(url);
    hls.attachMedia(el);
  });
  return {
    stop: () => {
      stopped = true;
      hls?.destroy();
      hls = null;
      el.removeAttribute('src');
      el.load();
    },
  };
}
