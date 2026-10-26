import { Router, type Request, type Response } from 'express';
import {
  canRemux,
  closeRemuxSessions,
  createLogger,
  cuesToVtt,
  remuxSession,
  remuxSessionById,
  remuxSourceOf,
  RemuxLimitError,
  type RemuxSession,
} from '@aiostreams/core';
import { jfOptional, param, qs } from './context.js';
import { ensureMemo, locate, pickSource } from './playback.js';

const logger = createLogger('jellyfin');
const router: Router = Router({ mergeParams: true });

const PLAYLIST_TYPE = 'application/vnd.apple.mpegurl';

/** Opens, or finds, the session of the version and audio track asked for. */
async function sessionFor(
  req: Request,
  res: Response
): Promise<RemuxSession | null> {
  const loc = await locate(req, param(req, 'itemId'), { bySession: true });
  const memo = loc ? await ensureMemo(loc) : null;
  const source = memo ? pickSource(memo, loc!.requestedMsid) : undefined;
  if (!source || !canRemux(source)) {
    res.status(404).json({ Message: 'This version cannot be remuxed' });
    return null;
  }
  const audio = qs(req, 'AudioStreamIndex');
  try {
    return await remuxSession(
      remuxSourceOf(source, memo!.psid),
      audio !== undefined ? Number(audio) : undefined
    );
  } catch (err) {
    const message = (err as Error).message;
    logger.warn({ msid: source.msid, err: message }, 'remux failed to open');
    res
      .status(err instanceof RemuxLimitError ? 503 : 502)
      .json({ Message: `Remux unavailable: ${message}` });
    return null;
  }
}

/** Every part's address keeps the query the playlist was asked with, which carries the token. */
function partQuery(req: Request): string {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query))
    if (typeof v === 'string') query.set(k, v);
  const text = query.toString();
  return text ? `?${text}` : '';
}

/** The only variant, so a player that starts from it needs nothing more. */
async function masterPlaylist(req: Request, res: Response) {
  const session = await sessionFor(req, res);
  if (!session) return;
  const query = new URLSearchParams(partQuery(req).slice(1));
  query.set('RemuxSessionId', session.id);
  res.type(PLAYLIST_TYPE).setHeader('Cache-Control', 'no-store');
  res.send(
    [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      // Rough, as only the player's own measure matters for one variant.
      '#EXT-X-STREAM-INF:BANDWIDTH=8000000',
      `main.m3u8?${query}`,
      '',
    ].join('\n')
  );
}

/** The session a part names; a stale one is reopened from the request. */
async function namedSession(
  req: Request,
  res: Response
): Promise<RemuxSession | null> {
  const id = qs(req, 'RemuxSessionId');
  const named = id ? remuxSessionById(id) : undefined;
  return named ?? sessionFor(req, res);
}

async function mediaPlaylist(req: Request, res: Response) {
  const session = await namedSession(req, res);
  if (!session) return;
  const query = new URLSearchParams(partQuery(req).slice(1));
  query.set('RemuxSessionId', session.id);
  const { bounds } = session;
  const start = Number(qs(req, 'StartTimeTicks') ?? 0) / 10_000_000;
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-TARGETDURATION:${Math.ceil(
      Math.max(...bounds.slice(1).map((b, i) => b - bounds[i]))
    )}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    // Where the player resumes, so its first read is there and not at 0.
    ...(start > 0 ? [`#EXT-X-START:TIME-OFFSET=${start.toFixed(3)}`] : []),
    `#EXT-X-MAP:URI="hls1/main/init.mp4?${query}"`,
  ];
  for (let n = 0; n < session.count; n++)
    lines.push(
      `#EXTINF:${(bounds[n + 1] - bounds[n]).toFixed(6)},`,
      `hls1/main/${n}.mp4?${query}`
    );
  lines.push('#EXT-X-ENDLIST', '');
  res.type(PLAYLIST_TYPE).setHeader('Cache-Control', 'no-store');
  res.send(lines.join('\n'));
}

async function initPart(req: Request, res: Response) {
  const session = await namedSession(req, res);
  if (!session) return;
  const start = Number(qs(req, 'StartTimeTicks') ?? 0) / 10_000;
  const init = await session.initSegment(Number.isFinite(start) ? start : 0);
  if (!init) {
    res.status(502).json({ Message: 'The remux did not start' });
    return;
  }
  res.type('video/mp4').setHeader('Cache-Control', 'no-store');
  res.send(init);
}

async function segmentPart(req: Request, res: Response) {
  const session = await namedSession(req, res);
  if (!session) return;
  const n = Number(param(req, 'segment'));
  const abort = new AbortController();
  req.on('close', () => abort.abort());
  const segment = Number.isInteger(n) ? await session.segment(n) : null;
  if (abort.signal.aborted) return;
  if (!segment) {
    res.status(502).json({ Message: 'The segment could not be read' });
    return;
  }
  res.type('video/mp4').setHeader('Cache-Control', 'no-store');
  res.send(segment.bytes);
}

/** An embedded text subtitle as WebVTT, once the file's subtitles are read. */
async function remuxSubtitle(req: Request, res: Response) {
  const session = await sessionFor(req, res);
  if (!session) return;
  const index = Number(param(req, 'index'));
  const cues = session.subtitleCues(index);
  if (!cues) {
    res.status(404).end();
    return;
  }
  const read = await cues;
  if (!read) {
    res.status(502).end();
    return;
  }
  res.type('text/vtt; charset=utf-8').setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(cuesToVtt(read));
}

router.get(
  ['/Videos/:itemId/master.m3u8', '/Videos/:itemId/live.m3u8'],
  jfOptional(masterPlaylist)
);
router.get('/Videos/:itemId/main.m3u8', jfOptional(mediaPlaylist));
router.get('/Videos/:itemId/hls1/main/init.mp4', jfOptional(initPart));
router.get('/Videos/:itemId/hls1/main/:segment.mp4', jfOptional(segmentPart));
router.get(
  '/Videos/:itemId/:mediaSourceId/Subtitles/:index/remux/Stream.vtt',
  jfOptional(remuxSubtitle)
);
router.delete('/Videos/ActiveEncodings', (req, res) => {
  const psid = qs(req, 'PlaySessionId');
  if (psid) closeRemuxSessions((s) => s.source.playSessionId === psid);
  res.status(204).end();
});

export default router;
