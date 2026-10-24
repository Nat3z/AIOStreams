import pLimit from 'p-limit';
import { Cache } from '../utils/cache.js';
import type { MetaPreview, UserData } from '../db/schemas.js';
import type { AIOStreams } from '../main/index.js';
import { WatchStateRepository } from '../db/repositories/watch-state.js';
import type { WatchScope } from '../watch-state/types.js';
import { IdMappingDataset } from '../metadata/id-mappings.js';
import { AnimeDatabase } from '../anime-database/index.js';
import { IdParser } from '../utils/id-parser.js';
import type { TMDBMetadata, TMDBTitle } from '../metadata/tmdb.js';
import { providerIdsFor } from './dto.js';
import { titlePreviews, tmdbFor } from './tmdb-titles.js';

/*
 * What someone watched, made into a "Recommended for you" catalog any client
 * lists and "Because you watched" rows. TMDB's per-title recommendations are
 * the source; nothing they've already seen is offered.
 */

export interface Seed {
  kind: 'movie' | 'series';
  /** The Stremio type and id it was watched under. */
  type: string;
  id: string;
  tmdbId: number;
}

/** A "Because you watched" row. */
export interface Feed {
  seed: Seed;
  items: MetaPreview[];
}

const SEEDS = 12;
const BECAUSE_ROWS = 3;
const LOOKUPS = 4;
const CATALOG_SIZE = 40;
/** A new watch reaches the rows within this long. */
const PICKS_TTL = 10 * 60;
/** Fewer than this and a row isn't worth showing. */
const MIN_ROW = 4;

/** Through the anime mappings for ids TMDB has no lookup of, as trackers' anime lists are keyed. */
async function tmdbIdOf(
  kind: 'movie' | 'series',
  id: string
): Promise<number | undefined> {
  const ids = providerIdsFor({ id, type: kind });
  const mappings = IdMappingDataset.getInstance();
  const imdbId =
    ids.Imdb ??
    (ids.Tvdb ? mappings.imdbIdFor(kind, 'tvdb', Number(ids.Tvdb)) : undefined);
  const direct =
    Number(ids.Tmdb) ||
    (imdbId ? mappings.resolve(kind, { imdbId }).tmdbId : undefined);
  if (direct) return direct;
  const parsed = IdParser.parse(id, kind);
  if (!parsed) return undefined;
  const entry = await AnimeDatabase.getInstance()
    .getEntryById(parsed.type, parsed.value)
    .catch(() => null);
  return entry?.mappings?.themoviedbId;
}

/**
 * The movies and shows watched most recently, `SEEDS` of each so either has
 * recommendations, a show once however many episodes; and the TMDB keys of
 * everything watched, to leave out.
 */
async function historyOf(
  scope: WatchScope
): Promise<{ seeds: Seed[]; watched: Set<string> }> {
  const seeds: Seed[] = [];
  const watched = new Set<string>();
  const seen = new Set<string>();
  for (const row of await WatchStateRepository.listPlayed(scope)) {
    // A show's episodes all share its id, which only needs resolving once.
    if (seen.has(row.baseId)) continue;
    seen.add(row.baseId);
    const kind = row.kind === 'movie' ? 'movie' : 'series';
    const tmdbId = await tmdbIdOf(kind, row.baseId);
    if (!tmdbId) continue;
    const key = `${kind === 'movie' ? 'movie' : 'tv'}:${tmdbId}`;
    if (watched.has(key)) continue;
    watched.add(key);
    if (seeds.filter((s) => s.kind === kind).length < SEEDS)
      seeds.push({ kind, type: row.mediaType, id: row.baseId, tmdbId });
  }
  return { seeds, watched };
}

const keyOf = (t: { mediaType: string; tmdbId: number }) =>
  `${t.mediaType}:${t.tmdbId}`;

/**
 * Titles recommended alongside several seeds rank first, nearer seeds
 * weighing more, then by TMDB's own order.
 */
function rank(lists: TMDBTitle[][]): TMDBTitle[] {
  const scored = new Map<string, { title: TMDBTitle; score: number }>();
  lists.forEach((list, seed) => {
    const weight = 1 / (1 + seed * 0.25);
    list.forEach((title, at) => {
      const key = keyOf(title);
      const score = weight * (1 - at / (list.length + 1));
      const entry = scored.get(key);
      if (entry) entry.score += score;
      else scored.set(key, { title, score });
    });
  });
  return [...scored.values()]
    .sort((a, b) => b.score - a.score)
    .map((e) => e.title);
}

async function openable(
  engine: AIOStreams,
  tmdb: TMDBMetadata,
  titles: TMDBTitle[],
  limit: number
): Promise<MetaPreview[]> {
  return (await titlePreviews(engine, tmdb, titles.slice(0, limit + 8))).slice(
    0,
    limit
  );
}

interface Picks {
  seeds: Seed[];
  /** Each seed's recommendations, less what was watched. */
  unseen: TMDBTitle[][];
  /** All of them, best first. */
  ranked: TMDBTitle[];
}

const picksCache = Cache.getInstance<string, Picks>(
  'jellyfin:feed-picks',
  500,
  'memory'
);

/** TMDB's recommendations for one history; none until something is watched. */
async function picksFor(
  tmdb: TMDBMetadata,
  scope: WatchScope
): Promise<Picks | null> {
  const key = `${scope.uuid}|${scope.persona}`;
  const cached = await picksCache.get(key);
  if (cached) return cached;
  const { seeds, watched } = await historyOf(scope);
  if (!seeds.length) return null;

  const pool = pLimit(LOOKUPS);
  const lists = await Promise.all(
    seeds.map((seed) =>
      pool(() =>
        tmdb
          .getRecommendations(
            seed.kind === 'movie' ? 'movie' : 'tv',
            seed.tmdbId
          )
          .catch((): TMDBTitle[] => [])
      )
    )
  );
  const unseen = lists.map((list) =>
    list.filter((t) => !watched.has(keyOf(t)))
  );
  const picks: Picks = { seeds, unseen, ranked: rank(unseen) };
  await picksCache.set(key, picks, PICKS_TTL);
  return picks;
}

/** The "Because you watched" rows of one history, none without TMDB or anything watched. */
export async function watchFeeds(
  engine: AIOStreams,
  userData: UserData,
  scope: WatchScope,
  limit: number
): Promise<Feed[]> {
  const tmdb = tmdbFor(userData);
  const picks = tmdb && (await picksFor(tmdb, scope));
  if (!picks) return [];

  const feeds: Feed[] = [];
  for (const [i, seed] of picks.seeds.entries()) {
    if (feeds.length >= BECAUSE_ROWS) break;
    if (picks.unseen[i].length < MIN_ROW) continue;
    const items = await openable(engine, tmdb, picks.unseen[i], limit);
    if (items.length >= MIN_ROW) feeds.push({ seed, items });
  }
  return feeds;
}

/** "Recommended for you" as the catalog of one type. */
export async function recommendedCatalog(
  engine: AIOStreams,
  scope: WatchScope,
  type: string
): Promise<MetaPreview[]> {
  const tmdb = tmdbFor(engine.getUserData());
  const picks = tmdb && (await picksFor(tmdb, scope));
  if (!picks) return [];
  const mediaType = type === 'movie' ? 'movie' : 'tv';
  return openable(
    engine,
    tmdb,
    picks.ranked.filter((t) => t.mediaType === mediaType),
    CATALOG_SIZE
  );
}
