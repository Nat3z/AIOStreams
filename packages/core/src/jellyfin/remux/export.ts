import { spawn } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import { appConfig, createLogger } from '../../utils/index.js';
import { openLoopback } from '../../media-info/loopback.js';
import { RemuxLimitError, type RemuxSource } from './session.js';

const logger = createLogger('remux');

/** Browsers decode AAC up to 5.1 reliably. */
const MAX_CHANNELS = 6;

let running = 0;

/**
 * A version's whole file as one MP4 a browser saves and plays offline: the
 * video copied and one audio track as AAC, kept where it already is. Its
 * subtitles are saved beside it as WebVTT. ffmpeg writes the same bytes
 * every time, so a save cut short asks again with `skip`, the bytes it
 * already has.
 */
export async function exportMp4(
  source: RemuxSource,
  audioStreamIndex: number | undefined,
  skip: number,
  signal: AbortSignal
): Promise<Readable> {
  const audio =
    source.audio.find((a) => a.streamIndex === audioStreamIndex) ??
    source.audio.find((a) => a.default) ??
    source.audio[0];
  if (!audio) throw new Error('no audio track to export');
  // Shares the remux limit, as each reads the whole file through ffmpeg.
  if (running >= appConfig.jellyfin.remux.maxSessions)
    throw new RemuxLimitError('too many remuxes running');
  running++;
  const file = await source.open(signal).catch((err: unknown) => {
    running--;
    throw err;
  });
  const loopback = await openLoopback(file);
  const channels = Math.min(audio.channels ?? 2, MAX_CHANNELS);
  // AAC a browser already plays is kept as it is.
  const keepAudio =
    audio.codec === 'aac' && (audio.channels ?? 2) <= MAX_CHANNELS;
  const proc = spawn(
    appConfig.jellyfin.remux.ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-fflags',
      '+bitexact',
      '-i',
      loopback.url,
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
      ...(keepAudio
        ? ['-c:a', 'copy']
        : [
            '-c:a',
            'aac',
            '-ac',
            String(channels),
            '-b:a',
            channels > 2 ? '384k' : '192k',
            '-flags:a',
            '+bitexact',
          ]),
      // Fragmented, so it streams out as it is written and plays while incomplete.
      '-movflags',
      '+frag_keyframe+empty_moov+default_base_moof',
      '-f',
      'mp4',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stderr = '';
  proc.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-1000);
  });
  const done = () => {
    running--;
    void loopback.close().catch(() => undefined);
  };
  proc.once('close', (code) => {
    done();
    if (code && !signal.aborted)
      logger.warn({ title: source.title, code, stderr }, 'mp4 export failed');
  });
  signal.addEventListener('abort', () => proc.kill('SIGKILL'), { once: true });

  // Drops what the browser already saved, then passes the rest on.
  const out = proc.stdout;
  if (skip <= 0) return out;
  let left = skip;
  const rest = new PassThrough();
  out.on('data', (chunk: Buffer) => {
    if (left >= chunk.length) {
      left -= chunk.length;
      return;
    }
    const tail = left ? chunk.subarray(left) : chunk;
    left = 0;
    if (!rest.write(tail)) {
      out.pause();
      rest.once('drain', () => out.resume());
    }
  });
  out.once('end', () => rest.end());
  out.once('error', (err) => rest.destroy(err));
  return rest;
}
