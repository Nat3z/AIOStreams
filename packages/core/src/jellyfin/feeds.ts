import pLimit from 'p-limit';
import { Cache } from '../utils/cache.js';
import type { MetaPreview, UserData } from '../db/schemas.js';
import type { AIOStreams } from '../main/index.js';
import { WatchStateRepository } from '../db/repositories/watch-state.js';
import type { WatchScope } from '../watch-state/types.js';
import { IdMappingDataset } from '../metadata/id-mappings.js';
import type { TMDBMetadata, TMDBTitle } from '../metadata/tmdb.js';
import { providerIdsFor } from './dto.js';
import { titlePreviews, tmdbFor } from './tmdb-titles.js';

/*
 * Home rows made from what someone watched: "Because you watched" a recent
 * title, and "Recommended for you" across their history. TMDB's per-title
 * recommendations are the source; nothing they've already seen is offered.
 */

export interface Seed {
  kind: 'movie' | 'series';
  /** The Stremio type and id it was watched under. */
  type: string;
  id: string;
  tmdbId: number;
}

export interface Feed {
  kind: 'because' | 'recommended';
  /** The title a "because" row is about. */
  seed?: Seed;
  items: MetaPreview[];
}

const SEEDS = 12;
const BECAUSE_ROWS = 3;
const LOOKUPS = 4;
/** A new watch reaches the rows within this long. */
const FEED_TTL = 10 * 60;
/** Fewer than this and a row isn't worth showing. */
const MIN_ROW = 4;

function tmdbIdOf(kind: 'movie' | 'series', id: string): number | undefined {
  const ids = providerIdsFor({ id, type: kind });
  return (
    Number(ids.Tmdb) ||
    (ids.Imdb
      ? IdMappingDataset.getInstance().resolve(kind, { imdbId: ids.Imdb })
          .tmdbId
      : undefined)
  );
}

/**
 * The movies and shows watched most recently, a show once however many
 * episodes, and the TMDB keys of everything watched, to leave out.
 */
async function historyOf(
  scope: WatchScope
): Promise<{ seeds: Seed[]; watched: Set<string> }> {
  const seeds: Seed[] = [];
  const watched = new Set<string>();
  for (const row of await WatchStateRepository.listPlayed(scope)) {
    const kind = row.kind === 'movie' ? 'movie' : 'series';
    const tmdbId = tmdbIdOf(kind, row.baseId);
    if (!tmdbId) continue;
    const key = `${kind === 'movie' ? 'movie' : 'tv'}:${tmdbId}`;
    if (watched.has(key)) continue;
    watched.add(key);
    if (seeds.length < SEEDS)
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

const cache = Cache.getInstance<string, Feed[]>(
  'jellyfin:feeds',
  500,
  'memory'
);

/** Every feed for one history, or none without TMDB set up or anything watched. */
export async function watchFeeds(
  engine: AIOStreams,
  userData: UserData,
  scope: WatchScope,
  limit: number
): Promise<Feed[]> {
  const key = `${scope.uuid}|${scope.persona}|${limit}`;
  const cached = await cache.get(key);
  if (cached) return cached;
  const feeds = await buildFeeds(engine, userData, scope, limit);
  if (feeds.length) await cache.set(key, feeds, FEED_TTL);
  return feeds;
}

async function buildFeeds(
  engine: AIOStreams,
  userData: UserData,
  scope: WatchScope,
  limit: number
): Promise<Feed[]> {
  const tmdb = tmdbFor(userData);
  if (!tmdb) return [];
  const { seeds, watched } = await historyOf(scope);
  if (!seeds.length) return [];

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

  const feeds: Feed[] = [];
  const recommended = await openable(engine, tmdb, rank(unseen), limit);
  if (recommended.length)
    feeds.push({ kind: 'recommended', items: recommended });
  let because = 0;
  for (const [i, seed] of seeds.entries()) {
    if (because >= BECAUSE_ROWS) break;
    if (unseen[i].length < MIN_ROW) continue;
    const items = await openable(engine, tmdb, unseen[i], limit);
    if (items.length < MIN_ROW) continue;
    feeds.push({ kind: 'because', seed, items });
    because++;
  }
  return feeds;
}
