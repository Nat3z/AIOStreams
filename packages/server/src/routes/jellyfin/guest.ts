import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import {
  config as appConfig,
  closeRemuxSessions,
  createLogger,
  GuestPassRepository,
  JellyfinRepository,
  mintGuestToken,
  profileUserId,
  proxyTargetKey,
  resolveByItem,
  resolveByPlaySession,
  serverId as instanceServerId,
  stopStreamsTo,
  unwrapProxyUrl,
  WatchSessionRepository,
  WatchStateRepository,
  type ContentDescriptor,
  type GuestPass,
  type JellyfinDescriptor,
} from '@aiostreams/core';
import {
  bodyField,
  canProxyGuests,
  guestPersona,
  guestLeaveOf,
  jf,
  jfOptional,
  param,
  qs,
  qlist,
  type JellyfinRequestContext,
} from './context.js';
import { decodeItemForRequest, itemFromDescriptor } from './items.js';
import { userConfiguration, userPolicy } from './users.js';
import { serverName } from './system.js';

/*
 * A guest pass lets someone without an account watch one title on a
 * configuration. Its session reaches only the routes a player needs, and only
 * for that title and what is under it, or what the pass's party plays now.
 */

const logger = createLogger('jellyfin');
const router: Router = Router({ mergeParams: true });

const HOUR_MS = 3600_000;
const LIFETIMES_HOURS = [24, 72, 168];

/** Routes a guest's player needs. Anything else is refused. */
const GUEST_ROUTES: { method: string; path: RegExp }[] = [
  { method: 'GET', path: /^\/system\/info(\/public)?$/i },
  { method: 'GET', path: /^\/system\/ping$/i },
  { method: 'GET', path: /^\/users\/me$/i },
  { method: 'GET', path: /^\/displaypreferences\/[^/]+$/i },
  { method: 'POST', path: /^\/displaypreferences\/[^/]+$/i },
  { method: 'POST', path: /^\/sessions\/capabilities(\/full)?$/i },
  { method: 'POST', path: /^\/sessions\/logout$/i },
  {
    method: 'POST',
    path: /^\/sessions\/playing(\/progress|\/stopped|\/ping)?$/i,
  },
  { method: 'GET', path: /^\/items$/i },
  { method: 'GET', path: /^\/items\/[^/]+$/i },
  { method: 'GET', path: /^\/items\/[^/]+\/ancestors$/i },
  { method: 'GET', path: /^\/items\/[^/]+\/images(\/|$)/i },
  { method: 'HEAD', path: /^\/items\/[^/]+\/images(\/|$)/i },
  { method: 'GET', path: /^\/items\/[^/]+\/(playbackinfo|mediasources)$/i },
  { method: 'POST', path: /^\/items\/[^/]+\/playbackinfo$/i },
  { method: 'GET', path: /^\/shows\/[^/]+\/(seasons|episodes)$/i },
  { method: 'GET', path: /^\/useritems\/[^/]+\/userdata$/i },
  { method: 'POST', path: /^\/useritems\/[^/]+\/userdata$/i },
  // Marks and favourites land in the pass's own history.
  { method: 'POST', path: /^\/user(played|favorite)items\/[^/]+$/i },
  { method: 'DELETE', path: /^\/user(played|favorite)items\/[^/]+$/i },
  { method: 'GET', path: /^\/shows\/nextup$/i },
  { method: 'GET', path: /^\/mediasegments\/[^/]+$/i },
  { method: 'GET', path: /^\/videos\/[^/]+\/(stream|original)(\.[^/]+)?$/i },
  { method: 'HEAD', path: /^\/videos\/[^/]+\/(stream|original)(\.[^/]+)?$/i },
  { method: 'GET', path: /^\/videos\/[^/]+\/(main|master|live)\.m3u8$/i },
  { method: 'GET', path: /^\/videos\/[^/]+\/hls1\//i },
  {
    method: 'GET',
    path: /^\/videos\/[^/]+\/[^/]+\/(subtitles|attachments|thumbnail)(\/|$)/i,
  },
  { method: 'DELETE', path: /^\/videos\/activeencodings$/i },
  { method: 'GET', path: /^\/aiostreams\/guest$/i },
];

/** Where a route names its item: the path's second part, or `Ids`/`ParentId`. */
function itemIdsOf(req: Request): string[] {
  const parts = req.path.split('/').filter(Boolean);
  const kind = parts[0]?.toLowerCase();
  const ids: string[] = [];
  if (
    parts[1] &&
    [
      'items',
      'shows',
      'useritems',
      'userplayeditems',
      'userfavoriteitems',
      'mediasegments',
      'videos',
    ].includes(kind) &&
    !/^(activeencodings|nextup)$/i.test(parts[1])
  )
    ids.push(parts[1]);
  if (kind === 'items' && parts.length === 1) {
    ids.push(...qlist(req, 'Ids'));
    const parent = qs(req, 'ParentId');
    if (parent) ids.push(parent);
  }
  const season = qs(req, 'SeasonId');
  if (season) ids.push(season);
  const series = qs(req, 'SeriesId');
  if (series) ids.push(series);
  const body = bodyField(req, 'ItemId');
  if (typeof body === 'string' && body) ids.push(body);
  return ids;
}

/** Whether `d` is the shared title or something under it. */
function within(scope: JellyfinDescriptor, d: JellyfinDescriptor): boolean {
  if (!('i' in scope) || !('i' in d) || scope.i !== d.i) return false;
  switch (scope.k) {
    case 'movie':
      return d.k === 'movie';
    case 'series':
      return d.k === 'series' || d.k === 'season' || d.k === 'episode';
    case 'season':
      return (d.k === 'season' || d.k === 'episode') && d.s === scope.s;
    case 'episode':
      return d.k === 'episode' && d.s === scope.s && d.e === scope.e;
    default:
      return false;
  }
}

/** Whether `d` is the show or season the shared title sits in, which a page shows around it. */
function around(scope: JellyfinDescriptor, d: JellyfinDescriptor): boolean {
  if (!('i' in scope) || !('i' in d) || scope.i !== d.i) return false;
  if (d.k === 'series') return scope.k === 'season' || scope.k === 'episode';
  return d.k === 'season' && scope.k === 'episode' && d.s === scope.s;
}

/** A play needs the title itself; a page may also read the show around it. */
async function inScope(
  ctx: JellyfinRequestContext,
  pass: GuestPass,
  raw: string,
  playing: boolean
): Promise<boolean> {
  const d = await decodeItemForRequest(ctx, raw).catch(() => null);
  if (!d) return false;
  for (const id of [pass.itemId, pass.playing]) {
    if (!id) continue;
    const scope = await decodeItemForRequest(ctx, id).catch(() => null);
    if (scope && (within(scope, d) || (!playing && around(scope, d))))
      return true;
  }
  return false;
}

const PLAYING =
  /^\/(videos\/|mediasegments\/|items\/[^/]+\/(playbackinfo|mediasources)$)/i;

const refuse = (res: Response, status = 403) =>
  res.status(status).json({ Message: 'Not part of this link' });

/**
 * Before every route: a guest's request goes through only on a route a player
 * needs and for the pass's title, and a new play only while the pass lasts.
 */
export async function guestGuard(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const ctx = req.jf;
  const pass = ctx?.guest;
  if (!ctx || !pass) return next();
  try {
    const allowed = GUEST_ROUTES.some(
      (r) => r.method === req.method && r.path.test(req.path)
    );
    if (!allowed) return void refuse(res);
    // The user is the guest, not whoever's configuration it plays on.
    if (/^\/users\/me$/i.test(req.path)) return void res.json(guestUser(ctx));
    // Nothing to remote control, and no device of the owner's to become.
    if (/^\/sessions\/(capabilities|logout)/i.test(req.path))
      return void res.status(204).end();
    const playing = PLAYING.test(req.path);
    for (const id of itemIdsOf(req))
      if (!(await inScope(ctx, pass, id, playing))) return void refuse(res);
    // Listing everything would list the owner's libraries.
    if (/^\/(items|shows\/nextup)$/i.test(req.path) && !itemIdsOf(req).length)
      return void refuse(res);
    // A stream already playing plays on; nothing new starts once the pass ends.
    const starting =
      /^\/items\/[^/]+\/playbackinfo$/i.test(req.path) ||
      (/^\/videos\/[^/]+\/(stream|original)/i.test(req.path) &&
        !qs(req, 'MediaSourceId') &&
        !qs(req, 'PlaySessionId'));
    if (starting && pass.expiresAt <= Date.now())
      return void res.status(401).json({ Message: 'This link has expired' });
    if (/^\/items\/[^/]+\/playbackinfo$/i.test(req.path)) {
      if (pass.expiresAt <= Date.now())
        return void res.status(401).json({ Message: 'This link has expired' });
      if (await atStreamLimit(ctx, pass))
        return void res.status(429).json({
          Message: `This link is already playing on ${pass.maxStreams} devices`,
        });
    }
    next();
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'guest request check failed'
    );
    refuse(res, 500);
  }
}

/** Devices playing on the pass now, this one aside. */
async function playingOn(
  ctx: JellyfinRequestContext,
  pass: GuestPass
): Promise<string[]> {
  const since = Date.now() - appConfig.watchState.sessionIdleTimeout * 1000;
  const rows = await WatchSessionRepository.listForScope(
    { uuid: pass.uuid, profile: guestPersona(pass.id) },
    50
  );
  return rows
    .filter((r) => r.endedAt == null && r.lastCheckinAt >= since)
    .map((r) => r.deviceId ?? r.sessionKey)
    .filter((device) => device !== ctx.client.deviceId);
}

async function atStreamLimit(
  ctx: JellyfinRequestContext,
  pass: GuestPass
): Promise<boolean> {
  return new Set(await playingOn(ctx, pass)).size >= pass.maxStreams;
}

function guestUser(ctx: JellyfinRequestContext) {
  const now = new Date().toISOString();
  return {
    Name: 'Guest',
    ServerId: instanceServerId(),
    ServerName: serverName(),
    Id: ctx.userId,
    HasPassword: false,
    HasConfiguredPassword: false,
    HasConfiguredEasyPassword: false,
    EnableAutoLogin: true,
    LastLoginDate: now,
    LastActivityDate: now,
    Configuration: userConfiguration(),
    Policy: userPolicy(),
  };
}

/** What a guest's app is told about its pass. */
function passInfo(pass: GuestPass) {
  return {
    Id: pass.id,
    ItemId: pass.itemId,
    ItemName: pass.itemName,
    ExpiresAt: pass.expiresAt,
    MaxStreams: pass.maxStreams,
  };
}

/** What the owner sees of a pass. */
async function ownerView(pass: GuestPass) {
  const since = Date.now() - appConfig.watchState.sessionIdleTimeout * 1000;
  const rows = await WatchSessionRepository.listForScope(
    { uuid: pass.uuid, profile: guestPersona(pass.id) },
    50
  ).catch(() => []);
  return {
    ...passInfo(pass),
    Label: pass.label,
    CreatedAt: pass.createdAt,
    Party: !!pass.party,
    Watching: rows.filter((r) => r.endedAt == null && r.lastCheckinAt >= since)
      .length,
  };
}

/** Passes are the owner's: not a guest's, not an API key's. */
function owner(res: Response, ctx: JellyfinRequestContext): boolean {
  if (ctx.guest || ctx.apiKey) {
    res.status(403).json({ Message: 'Not allowed' });
    return false;
  }
  if (!appConfig.guestPasses.enabled) {
    res.status(404).json({ Message: 'Guest passes are off on this server' });
    return false;
  }
  return true;
}

const SHAREABLE: ContentDescriptor['k'][] = [
  'movie',
  'series',
  'season',
  'episode',
];

// Signs a guest in with the code in their link.
router.post(
  '/AIOStreams/Guest',
  jfOptional(async (req, res) => {
    const code = String(bodyField(req, 'Code') ?? '');
    const pass =
      appConfig.guestPasses.enabled && code
        ? await GuestPassRepository.open(code)
        : null;
    if (!pass) {
      res.status(401).json({ Message: 'This link has expired' });
      return;
    }
    const deviceId = req.jfClient?.deviceId;
    const userId = profileUserId(pass.uuid, guestPersona(pass.id));
    logger.info({ uuid: pass.uuid, pass: pass.id }, 'guest pass opened');
    res.json({
      AccessToken: mintGuestToken({ g: pass.id, d: deviceId }),
      ServerId: instanceServerId(),
      User: {
        Name: 'Guest',
        Id: userId,
        ServerId: instanceServerId(),
        Policy: userPolicy(),
        Configuration: userConfiguration(),
      },
      Pass: passInfo(pass),
    });
  })
);

router.get(
  '/AIOStreams/Guest',
  jf(async (_req, res, ctx) => {
    if (!ctx.guest) {
      res.status(404).json({ Message: 'Not a guest' });
      return;
    }
    res.json(passInfo(ctx.guest));
  })
);

/** The signed-in profile, by the id their passes are kept under. */
const userKey = (ctx: JellyfinRequestContext) => ctx.profile.id;

/** What the user's settings let them make, and how much of it is used. */
async function allowanceOf(ctx: JellyfinRequestContext) {
  const leave = guestLeaveOf(ctx.profile);
  if (!leave) return null;
  const [active, thisMonth] = await Promise.all([
    GuestPassRepository.countActive(ctx.uuid, userKey(ctx)),
    GuestPassRepository.countThisMonth(ctx.uuid, userKey(ctx)),
  ]);
  return {
    maxActive: leave.maxActive ?? appConfig.guestPasses.maxActive,
    maxPerMonth: leave.maxPerMonth ?? appConfig.guestPasses.maxPerMonth,
    active,
    thisMonth,
  };
}

router.get(
  '/AIOStreams/GuestPasses',
  jf(async (_req, res, ctx) => {
    if (!owner(res, ctx)) return;
    const [passes, allowance] = await Promise.all([
      GuestPassRepository.list(ctx.uuid, userKey(ctx)),
      allowanceOf(ctx),
    ]);
    res.json({
      Passes: await Promise.all(passes.map(ownerView)),
      Allowed: !!allowance,
      CanCreate: canProxyGuests(ctx.userData),
      Limits: {
        MaxActive: allowance?.maxActive ?? 0,
        MaxPerMonth: allowance?.maxPerMonth ?? 0,
        MadeThisMonth: allowance?.thisMonth ?? 0,
        MaxStreams: appConfig.guestPasses.maxStreams,
        LifetimesHours: lifetimes(),
      },
    });
  })
);

/** The lifetimes offered, up to the longest allowed. */
function lifetimes(): number[] {
  const most = appConfig.guestPasses.maxLifetimeSeconds / 3600;
  const offered = LIFETIMES_HOURS.filter((h) => h <= most);
  return offered.length ? offered : [Math.max(1, Math.floor(most))];
}

router.post(
  '/AIOStreams/GuestPasses',
  jf(async (req, res, ctx) => {
    if (!owner(res, ctx)) return;
    if (!canProxyGuests(ctx.userData)) {
      res.status(400).json({
        Message:
          'Set up a proxy on this configuration first: a guest only plays through one.',
      });
      return;
    }
    const allowance = await allowanceOf(ctx);
    if (!allowance) {
      res.status(403).json({
        Message: "Your account isn't allowed to make guest links.",
      });
      return;
    }
    if (allowance.active >= allowance.maxActive) {
      res.status(400).json({
        Message: `You have ${allowance.maxActive} links already. End one first.`,
      });
      return;
    }
    if (allowance.thisMonth >= allowance.maxPerMonth) {
      res.status(400).json({
        Message: `You've made ${allowance.maxPerMonth} links in the last 30 days, the most you can.`,
      });
      return;
    }
    const itemId = String(bodyField(req, 'ItemId') ?? '');
    const d = itemId ? await decodeItemForRequest(ctx, itemId) : null;
    if (!d || !SHAREABLE.includes(d.k as ContentDescriptor['k'])) {
      res.status(400).json({ Message: 'Only a movie or a show can be shared' });
      return;
    }
    const item = await itemFromDescriptor(ctx, d, { bare: true }).catch(
      () => null
    );
    const hours = Number(bodyField(req, 'Hours'));
    if (!lifetimes().includes(hours)) {
      res.status(400).json({ Message: 'Pick one of the lifetimes offered' });
      return;
    }
    const streams = Math.round(Number(bodyField(req, 'MaxStreams') ?? 2));
    const maxStreams = Math.min(
      Math.max(1, Number.isFinite(streams) ? streams : 2),
      appConfig.guestPasses.maxStreams
    );
    const label = String(bodyField(req, 'Label') ?? '')
      .trim()
      .slice(0, 64);
    const party = String(bodyField(req, 'Party') ?? '');
    const { pass, code } = await GuestPassRepository.create({
      uuid: ctx.uuid,
      persona: userKey(ctx),
      encryptedPassword: ctx.encryptedPassword,
      itemId: itemId.replace(/-/g, '').toLowerCase(),
      itemName: itemTitle(item) ?? 'Shared title',
      label: label || undefined,
      party: /^[A-Za-z0-9_-]{16,32}$/.test(party) ? party : undefined,
      maxStreams,
      expiresAt: Date.now() + hours * HOUR_MS,
    });
    logger.info(
      { uuid: ctx.uuid, pass: pass.id, hours, party: !!pass.party },
      'guest pass made'
    );
    res.json({ ...(await ownerView(pass)), Code: code });
  })
);

function itemTitle(
  item: Awaited<ReturnType<typeof itemFromDescriptor>> | null
): string | null {
  if (!item?.Name) return null;
  const series = typeof item.SeriesName === 'string' ? item.SeriesName : null;
  return series && series !== item.Name ? `${series}: ${item.Name}` : item.Name;
}

router.delete(
  '/AIOStreams/GuestPasses/:id',
  jf(async (req, res, ctx) => {
    if (!owner(res, ctx)) return;
    const id = param(req, 'id');
    if (!(await GuestPassRepository.revoke(ctx.uuid, userKey(ctx), id))) {
      res.status(404).json({ Message: 'No such link' });
      return;
    }
    await endPass(ctx.uuid, id);
    logger.info({ uuid: ctx.uuid, pass: id }, 'guest pass revoked');
    res.status(204).end();
  })
);

/** Lets the passes in the owner's party play what it plays now, or nothing more. */
router.post(
  '/AIOStreams/GuestPasses/Playing',
  jf(async (req, res, ctx) => {
    if (!owner(res, ctx)) return;
    const party = String(bodyField(req, 'Party') ?? '');
    const raw = bodyField(req, 'ItemId');
    const itemId =
      typeof raw === 'string' && raw
        ? raw.replace(/-/g, '').toLowerCase()
        : null;
    if (!party) {
      res.status(400).json({ Message: 'Name the party' });
      return;
    }
    if (itemId && !(await decodeItemForRequest(ctx, itemId))) {
      res.status(400).json({ Message: 'Unknown item' });
      return;
    }
    await GuestPassRepository.setPlaying(ctx.uuid, party, itemId);
    res.status(204).end();
  })
);

/** Stops what a pass plays now and forgets its history. */
async function endPass(uuid: string, id: string): Promise<void> {
  const scope = { uuid, profile: guestPersona(id) };
  const rows = await WatchSessionRepository.listForScope(scope, 50).catch(
    () => []
  );
  const sessions = new Set(
    rows.map((r) => r.playSessionId).filter((p): p is string => !!p)
  );
  closeRemuxSessions((s) => sessions.has(s.source.playSessionId));
  // The builtin proxy keys a stream by what it reads, which its URL carries.
  for (const psid of sessions) {
    const pointer = await resolveByPlaySession(psid);
    const memo =
      pointer?.scope &&
      (await resolveByItem(uuid, pointer.scope, pointer.itemId));
    for (const source of memo ? memo.sources : []) {
      const upstream = unwrapProxyUrl(source.url);
      if (upstream !== source.url)
        await stopStreamsTo(proxyTargetKey(upstream)).catch(() => undefined);
    }
  }
  await forgetHistory(uuid, id);
}

async function forgetHistory(uuid: string, id: string): Promise<void> {
  const scope = { uuid, profile: guestPersona(id) };
  await Promise.all([
    WatchStateRepository.clearScope(scope),
    WatchSessionRepository.clearScope(scope),
    JellyfinRepository.clearDisplayPrefs(scope),
  ]).catch((error) =>
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'failed to forget a guest pass history'
    )
  );
}

/** Ends expired passes and the history they kept. */
export async function pruneGuestPasses(): Promise<number> {
  const ended = await GuestPassRepository.pruneExpired(Date.now());
  for (const pass of ended) await forgetHistory(pass.uuid, pass.id);
  return ended.length;
}

export default router;
