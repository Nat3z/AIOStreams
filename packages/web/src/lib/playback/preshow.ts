import { settings } from '@/lib/settings';
import { ticksToMs } from '@/lib/format';
import { to } from '@/lib/paths';
import type { BaseItemDto } from '@/lib/jellyfin/types';
import {
  BUMPER_SLOTS,
  bumperLabel,
  bumperMs,
  type BumperSlot,
} from './bumpers';

/** What a trailer is taken to run, as their lengths aren't known before they play. */
const TRAILER_MS = 150_000;
/** The most a showtime leaves for the pre-show, however short the movie. */
const MAX_PRESHOW_MS = 30 * 60_000;

/** Bumpers kept when there's little time, the first most. */
const KEPT_FIRST: BumperSlot[] = ['feature', 'silence', 'kidman', 'welcome'];

/** The welcome plays before the trailers, the rest after. */
const BEFORE = new Set<BumperSlot>(['welcome']);

/** One of the slot's links at random, so showings vary; null for a slot left empty. */
function drawBumper(slot: BumperSlot): string | null {
  const urls = settings.preshow.bumper[slot]
    .read()
    .split('\n')
    .map((url) => url.trim())
    .filter(Boolean);
  return urls.length ? urls[Math.floor(Math.random() * urls.length)] : null;
}

export interface Clip {
  url: string;
  name: string;
  /** The movie a trailer is for. */
  item?: BaseItemDto;
  bumper?: BumperSlot;
}

/** A set length of pre-show, or the length of a whole showing the pre-show fills out. */
export type Showing =
  { kind: 'length'; minutes: number } | { kind: 'showtime'; minutes: number };

/** The showing asked for, which the next play of that movie opens with. */
let asked: { itemId: string; showing: Showing } | null = null;

/** Asked for from Play's hold or menu; the version list may come between. */
export function askPreshow(itemId: string, showing: Showing): void {
  asked = { itemId, showing };
}

/** The pre-show's page for a showing asked for, else the player's. */
export function playPath(
  item: BaseItemDto,
  sourceId: string,
  startMs: number,
  playlist?: string
): string {
  const showing = asked && asked.itemId === item.Id ? asked.showing : null;
  asked = null;
  return showing
    ? to.preshow(item.Id!, sourceId, showing, playlist)
    : to.play(item.Id!, sourceId, startMs, playlist);
}

/** How long the pre-show may run: its set length, or what the showtime leaves after the movie. */
export function preshowBudgetMs(movie: BaseItemDto, showing: Showing): number {
  const minutes = showing.minutes * 60_000;
  if (showing.kind === 'length') return minutes;
  const runtime = ticksToMs(movie.RunTimeTicks);
  if (!runtime) return Math.min(MAX_PRESHOW_MS, minutes);
  return Math.max(0, Math.min(MAX_PRESHOW_MS, minutes - runtime));
}

/** A bumper drawn for each slot that fits in `budgetMs`, in the order they play around the trailers. */
function bumpersWithin(budgetMs: number) {
  let left = budgetMs;
  const kept = new Map<BumperSlot, string>();
  for (const slot of KEPT_FIRST) {
    const url = drawBumper(slot);
    if (url && bumperMs(url) <= left) {
      kept.set(slot, url);
      left -= bumperMs(url);
    }
  }
  const clips = (before: boolean): Clip[] =>
    BUMPER_SLOTS.filter(
      (slot) => kept.has(slot) && BEFORE.has(slot) === before
    ).map((slot) => ({
      url: kept.get(slot)!,
      name: bumperLabel(slot),
      bumper: slot,
    }));
  return { before: clips(true), after: clips(false) };
}

function shuffled<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Movies to show trailers for, sharing the most genres with `movie` first when `sameGenre`. */
export function trailerCandidates(
  movie: BaseItemDto,
  similar: BaseItemDto[],
  latest: BaseItemDto[],
  sameGenre: boolean
): BaseItemDto[] {
  const seen = new Set([movie.Id]);
  const pool = shuffled([...similar, ...latest]).filter((m) => {
    if (m.Type !== 'Movie' || !m.Id || seen.has(m.Id)) return false;
    seen.add(m.Id);
    return true;
  });
  if (!sameGenre) return pool;
  const genres = new Set(movie.Genres ?? []);
  const similarIds = new Set(similar.map((m) => m.Id));
  // A similar title counts as one genre shared, as its genres may not be listed.
  const score = (m: BaseItemDto) =>
    (m.Genres ?? []).filter((g) => genres.has(g)).length +
    (similarIds.has(m.Id) ? 1 : 0);
  return pool.sort((a, b) => score(b) - score(a));
}

/**
 * The pre-show's running order: bumpers before, trailers while the clock
 * leaves room for one more and the bumpers after, then those bumpers. Time is
 * the wall clock's, so pausing eats into it as it would in a theater.
 */
export function createReel(
  movie: BaseItemDto,
  showing: Showing,
  nextTrailer: () => Promise<Clip | null>
) {
  const startedAt = Date.now();
  const budget = preshowBudgetMs(movie, showing);
  const { before, after } = bumpersWithin(budget);
  const afterMs = after.reduce((sum, c) => sum + bumperMs(c.url), 0);
  let trailersDone = budget <= 0;
  let pending: Promise<Clip | null> | null = null;
  const roomForTrailer = () =>
    Date.now() - startedAt + TRAILER_MS + afterMs <= budget;
  return {
    /** When the movie is due, for the countdown. */
    endsAt: startedAt + budget,
    /** Looks up the next trailer while the current clip plays. */
    prepare() {
      if (!trailersDone) pending ??= nextTrailer();
    },
    async next(): Promise<Clip | null> {
      const first = before.shift();
      if (first) return first;
      if (!trailersDone && roomForTrailer()) {
        const found = await (pending ?? nextTrailer());
        pending = null;
        if (found) return found;
      }
      trailersDone = true;
      return after.shift() ?? null;
    },
  };
}

export type Reel = ReturnType<typeof createReel>;
