import { Router, type Request, type Response } from 'express';
import {
  canExport,
  canRemux,
  closeRemuxSessions,
  config as appConfig,
  createLogger,
  convertSubtitle,
  exportMp4,
  openVersion,
  remuxSession,
  remuxSessionById,
  remuxSourceOf,
  RemuxLimitError,
  thumbnailAt,
  type RemuxSession,
  type RemuxSource,
} from '@aiostreams/core';
import { jfOptional, param, qs } from './context.js';
import { ensureMemo, locate, pickSource } from './playback.js';
import { profileName } from './users.js';
import { applyProbedMediaInfo } from './resolve.js';

const logger = createLogger('jellyfin');
const router: Router = Router({ mergeParams: true });

const PLAYLIST_TYPE = 'application/vnd.apple.mpegurl';

/**
 * The remux source of the version asked for, or null once it has answered.
 * An export waits for the version's probe, which a download's list skips.
 */
async function remuxSourceFor(
  req: Request,
  res: Response,
  exporting = false
): Promise<RemuxSource | null> {
  // Subtitles and fonts name their version in the path, not the query.
  const loc = await locate(req, param(req, 'itemId'), {
    bySession: true,
    hintMsid: param(req, 'mediaSourceId') || undefined,
  });
  const memo = loc ? await ensureMemo(loc) : null;
  const source = memo ? pickSource(memo, loc!.requestedMsid) : undefined;
  if (source && exporting)
    await applyProbedMediaInfo(loc!.ctx, memo!, source.msid, {
      playing: true,
      exporting: true,
    });
  if (!source || !(exporting ? canExport(source) : canRemux(source))) {
    res.status(404).json({ Message: 'This version cannot be remuxed' });
    return null;
  }
  const { ctx } = loc!;
  return remuxSourceOf(source, memo!.psid, {
    name: profileName(ctx.userData, ctx.profile),
    client: ctx.client.name,
    device: ctx.client.device,
    ip: req.requestIp || req.ip,
  });
}

function audioIndexOf(req: Request): number | undefined {
  const audio = qs(req, 'AudioStreamIndex');
  return audio !== undefined ? Number(audio) : undefined;
}

/** Opens, or finds, the session of the version and audio track asked for. */
async function sessionFor(
  req: Request,
  res: Response
): Promise<RemuxSession | null> {
  const source = await remuxSourceFor(req, res);
  if (!source) return null;
  try {
    return await remuxSession(source, audioIndexOf(req), startSecondsOf(req));
  } catch (err) {
    const message = (err as Error).message;
    logger.warn({ key: source.key, err: message }, 'remux failed to open');
    res
      .status(err instanceof RemuxLimitError ? 503 : 502)
      .json({ Message: `Remux unavailable: ${message}` });
    return null;
  }
}

/** Where the player starts, which it names in ticks. */
function startSecondsOf(req: Request): number {
  const start = Number(qs(req, 'StartTimeTicks') ?? 0) / 10_000_000;
  return Number.isFinite(start) && start > 0 ? start : 0;
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
  const start = startSecondsOf(req);
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
  const init = await session.initSegment(startSecondsOf(req) * 1000);
  if (!init) {
    res.status(502).json({ Message: 'The remux did not start' });
    return;
  }
  res.type('video/mp4').setHeader('Cache-Control', 'no-store');
  res.send(init);
  session.sent(init.length);
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
  session.sent(segment.bytes.length);
}

const SUBTITLE_TYPES = {
  ass: 'text/x-ssa; charset=utf-8',
  sup: 'application/octet-stream',
  vtt: 'text/vtt; charset=utf-8',
} as const;

/**
 * An embedded subtitle as far as the remux has read the file around `At`
 * seconds: a styled script as itself or as WebVTT, and PGS pictures as they
 * are. `X-Read-To` says how far that is, so a player asks again past it.
 */
async function remuxSubtitle(req: Request, res: Response) {
  const asked = param(req, 'format').toLowerCase();
  if (asked !== 'ass' && asked !== 'sup' && asked !== 'vtt') {
    res.status(404).end();
    return;
  }
  const session = await sessionFor(req, res);
  if (!session) return;
  const at = Number(qs(req, 'At') ?? 0);
  const sub = session.subtitle(
    Number(param(req, 'index')),
    Number.isFinite(at) ? at : 0
  );
  if (!sub) {
    res.status(404).end();
    return;
  }
  let body: Buffer | string = sub.data;
  if (asked === 'vtt' && sub.format === 'ass')
    body = convertSubtitle(sub.data.toString('utf8'), 'ass', 'vtt').body;
  else if (asked !== (sub.format === 'pgs' ? 'sup' : sub.format)) {
    res.status(404).end();
    return;
  }
  res.type(SUBTITLE_TYPES[asked]).setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'X-Read-To, X-Read-Complete');
  res.setHeader('X-Read-To', sub.readTo.toFixed(3));
  if (sub.complete) res.setHeader('X-Read-Complete', '1');
  res.send(body);
}

/** The fonts a styled subtitle needs, which the file carries: their names first. */
async function remuxFonts(req: Request, res: Response) {
  const session = await sessionFor(req, res);
  if (!session) return;
  const fonts = await session.attachedFonts();
  res.setHeader('Cache-Control', 'no-store');
  res.json(
    fonts.map((f, i) => ({ index: i, name: f.name, size: f.data.length }))
  );
}

async function remuxFont(req: Request, res: Response) {
  const session = await sessionFor(req, res);
  if (!session) return;
  const font = (await session.attachedFonts())[Number(param(req, 'font'))];
  if (!font) {
    res.status(404).end();
    return;
  }
  res
    .type(font.mimeType || 'font/ttf')
    .setHeader('Cache-Control', 'private, max-age=86400');
  res.send(font.data);
}

/**
 * The version as one MP4 to save, for a browser that keeps downloads itself
 * and can't play Matroska. `Skip` drops the bytes a save cut short already has.
 */
async function exportFile(req: Request, res: Response) {
  const source = await remuxSourceFor(req, res, true);
  if (!source) return;
  const skip = Math.max(0, Math.floor(Number(qs(req, 'Skip') ?? 0)) || 0);
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  let body;
  try {
    body = await exportMp4(source, audioIndexOf(req), skip, abort.signal);
  } catch (err) {
    const message = (err as Error).message;
    logger.warn({ title: source.title, err: message }, 'mp4 export failed');
    res
      .status(err instanceof RemuxLimitError ? 503 : 502)
      .json({ Message: `Export unavailable: ${message}` });
    return;
  }
  res.type('video/mp4').setHeader('Cache-Control', 'no-store');
  body.on('error', () => res.destroy());
  body.pipe(res);
}

/**
 * A picture of the keyframe at or before `At` ms, for the seek bar of a
 * player that makes none itself. `Showing` is the keyframe on screen, which
 * gets a 204 rather than the same picture again; 404 means the file has none.
 */
async function thumbnail(req: Request, res: Response) {
  if (!appConfig.jellyfin.remux.thumbnails) {
    res.status(404).end();
    return;
  }
  const loc = await locate(req, param(req, 'itemId'), {
    hintMsid: param(req, 'mediaSourceId') || undefined,
  });
  const memo = loc ? await ensureMemo(loc) : null;
  const source = memo ? pickSource(memo, loc!.requestedMsid) : undefined;
  if (!source || source.live || source.notice || source.extension.ytId) {
    res.status(404).end();
    return;
  }
  const at = Number(qs(req, 'At') ?? 0);
  const showing = qs(req, 'Showing');
  const result = await thumbnailAt(
    source.msid,
    (signal) => openVersion(source, signal),
    Number.isFinite(at) ? at : 0,
    showing !== undefined ? Number(showing) : undefined
  );
  res.setHeader('Access-Control-Expose-Headers', 'X-Position-Ms');
  if (result.kind === 'none') {
    res.status(404).end();
    return;
  }
  if (result.kind === 'same') {
    res.status(204).end();
    return;
  }
  res
    .type('image/jpeg')
    .setHeader('Cache-Control', 'private, max-age=3600')
    .setHeader('X-Position-Ms', String(result.positionMs));
  res.send(result.jpeg);
}

router.get('/Videos/:itemId/:mediaSourceId/Thumbnail', jfOptional(thumbnail));
router.get('/Videos/:itemId/:mediaSourceId/Export.mp4', jfOptional(exportFile));
router.get(
  ['/Videos/:itemId/master.m3u8', '/Videos/:itemId/live.m3u8'],
  jfOptional(masterPlaylist)
);
router.get('/Videos/:itemId/main.m3u8', jfOptional(mediaPlaylist));
router.get('/Videos/:itemId/hls1/main/init.mp4', jfOptional(initPart));
router.get('/Videos/:itemId/hls1/main/:segment.mp4', jfOptional(segmentPart));
router.get(
  '/Videos/:itemId/:mediaSourceId/Subtitles/:index/remux/Stream.:format',
  jfOptional(remuxSubtitle)
);
router.get(
  '/Videos/:itemId/:mediaSourceId/Attachments',
  jfOptional(remuxFonts)
);
router.get(
  '/Videos/:itemId/:mediaSourceId/Attachments/:font',
  jfOptional(remuxFont)
);
router.delete('/Videos/ActiveEncodings', (req, res) => {
  const psid = qs(req, 'PlaySessionId');
  if (psid) closeRemuxSessions((s) => s.source.playSessionId === psid);
  res.status(204).end();
});

export default router;
