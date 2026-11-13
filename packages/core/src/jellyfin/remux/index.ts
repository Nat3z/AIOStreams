import { appConfig } from '../../utils/index.js';
import { parsePlaybackUrl } from '../../debrid/utils.js';
import {
  resolveExternalTarget,
  resolvePlaybackTarget,
} from '../../main/failover.js';
import { unwrapProxyUrl } from '../../proxy/token.js';
import { decodeUsenetStreamUrl } from '../../usenet/integration/tokens.js';
import { engineReader, httpReader } from '../../media-info/readers.js';
import type { OpenedFile } from '../../media-info/probe.js';
import { fileStreamsOf } from '../media.js';
import type { DeviceProfile, MediaSourceRecord } from '../types.js';
import {
  remuxableSubtitle,
  type RemuxSource,
  type RemuxViewer,
} from './session.js';

export {
  closeRemuxSessions,
  remuxSession,
  remuxOverview,
  remuxSessionById,
  RemuxLimitError,
  remuxSubtitleFormat,
  type RemuxSubtitle,
  type RemuxSubtitleFormat,
  type RemuxRunState,
  type RemuxSession,
  type RemuxSessionInfo,
  type RemuxSource,
  type RemuxViewer,
  type RemuxTrack,
} from './session.js';
export { thumbnailAt, type ThumbnailResult } from './thumbnails.js';
export { exportMp4 } from './export.js';

/** A remux reads the whole file, however long. */
const REMUX_READ_CAP = Number.MAX_SAFE_INTEGER;

/** Video a browser decodes, given an MP4 container to carry it. */
const BROWSER_VIDEO = new Set(['h264', 'hevc', 'av1', 'vp9']);

/** What the client said it plays, from its PlaybackInfo request. */
export interface RemuxSupport {
  /** It plays a remuxed version over HLS. */
  hls: boolean;
  /** Video codecs it decodes, as ffmpeg names them. */
  videoCodecs: string[];
}

/**
 * A device profile that lists an HLS transcoding profile takes a remux, as
 * Jellyfin's own clients ask for one; its video codecs are the ones it names.
 */
export function remuxSupportOf(
  profile: DeviceProfile | undefined
): RemuxSupport {
  const hls = (profile?.TranscodingProfiles ?? []).filter(
    (p) => p.Protocol?.toLowerCase() === 'hls' && p.Type !== 'Audio'
  );
  return {
    hls: hls.length > 0,
    videoCodecs: hls.flatMap((p) =>
      (p.VideoCodec ?? '')
        .split(',')
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean)
    ),
  };
}

/**
 * Whether a client that takes a remux may get this version's, once a probe
 * gives its tracks: it is Matroska, which no browser plays as it is.
 */
export function mayRemux(
  record: MediaSourceRecord,
  support: RemuxSupport
): boolean {
  return (
    support.hls &&
    appConfig.jellyfin.remux.enabled &&
    !record.notice &&
    !record.live &&
    !record.needs &&
    /^(mkv|webm)$/i.test(record.container)
  );
}

/** Whether a version can be remuxed: a probed Matroska file with known tracks. */
export function canRemux(record: MediaSourceRecord): boolean {
  if (!mayRemux(record, { hls: true, videoCodecs: [] })) return false;
  const streams = fileStreamsOf(record);
  return (
    !!streams?.some((s) => s.type === 'Video') &&
    streams.some((s) => s.type === 'Audio')
  );
}

/**
 * Whether a version can be saved as one MP4: any probed file with a video a
 * browser decodes and a sound, as the export needs no keyframe index.
 */
export function canExport(record: MediaSourceRecord): boolean {
  if (
    !appConfig.jellyfin.remux.enabled ||
    record.notice ||
    record.live ||
    record.needs
  )
    return false;
  const streams = fileStreamsOf(record);
  const codec = streams?.find((s) => s.type === 'Video')?.codec;
  return (
    !!codec &&
    BROWSER_VIDEO.has(codec) &&
    streams!.some((s) => s.type === 'Audio')
  );
}

/**
 * Whether a client that plays HLS gets the remux instead of the file, which
 * no browser plays as Matroska. Its video is only copied, so it must be one
 * the client decodes.
 */
export function wantsRemux(
  record: MediaSourceRecord,
  support: RemuxSupport
): boolean {
  if (!support.hls || !canRemux(record)) return false;
  const codec = fileStreamsOf(record)!.find((s) => s.type === 'Video')?.codec;
  if (!codec || !BROWSER_VIDEO.has(codec)) return false;
  return !support.videoCodecs.length || support.videoCodecs.includes(codec);
}

/**
 * Opens a version's file on this server. A remux reads every byte here, so
 * an owned debrid link is resolved for this server's IP, not the viewer's.
 */
export async function openVersion(
  record: MediaSourceRecord,
  signal: AbortSignal
): Promise<OpenedFile> {
  const url = unwrapProxyUrl(record.url);
  const headers = record.requestHeaders;
  const owned = parsePlaybackUrl(url);
  const resolved = owned
    ? await resolvePlaybackTarget(owned, {}, signal)
    : record.extension.proxied
      ? record.url
      : ((await resolveExternalTarget(record.url, {}, signal)) ?? record.url);
  if (!resolved) throw new Error('the file is still downloading');
  const token = decodeUsenetStreamUrl(resolved);
  if (token) return engineReader(token);
  return httpReader(resolved, signal, headers, REMUX_READ_CAP);
}

/** The remux source of a version {@link canRemux} passed. */
export function remuxSourceOf(
  record: MediaSourceRecord,
  /** The play session, which keeps one viewer's sessions from another's. */
  playSessionId: string,
  viewer?: RemuxViewer
): RemuxSource {
  const streams = fileStreamsOf(record) ?? [];
  const map = (fileIndex: number) => `0:${fileIndex}`;
  const video = streams.find((s) => s.type === 'Video')!;
  return {
    key: `${record.msid}:${playSessionId}`,
    open: (signal) => openVersion(record, signal),
    video: map(video.fileIndex),
    audio: streams
      .filter((s) => s.type === 'Audio')
      .map((s) => ({
        streamIndex: s.streamIndex,
        map: map(s.fileIndex),
        channels: s.channels,
        codec: s.codec,
        default: s.default,
      })),
    subtitles: streams
      .filter((s) => s.type === 'Subtitle' && remuxableSubtitle(s.codec))
      .map((s) => ({
        streamIndex: s.streamIndex,
        map: map(s.fileIndex),
        codec: s.codec,
        default: s.default,
      })),
    durationMs: record.durationMs,
    playSessionId,
    title: record.filename || record.label,
    videoCodec: video.codec,
    viewer,
  };
}
