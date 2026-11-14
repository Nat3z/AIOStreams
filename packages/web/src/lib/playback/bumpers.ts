import { t } from '@lingui/core/macro';

/** The parts of a showing around its trailers, in the order they play. */
export const BUMPER_SLOTS = [
  'welcome',
  'kidman',
  'silence',
  'feature',
] as const;
export type BumperSlot = (typeof BUMPER_SLOTS)[number];

interface Bumper {
  url: string;
  ms: number;
}

/* eslint-disable lingui/no-unlocalized-strings -- links */
const yt = (id: string, ms: number): Bumper => ({
  url: `https://www.youtube.com/watch?v=${id}`,
  ms,
});

/**
 * AMC's, as clean copies on YouTube rather than ones filmed in a theater.
 * Each showing draws one from each slot, so they vary from night to night;
 * Kidman always plays.
 */
export const BUMPERS: Record<BumperSlot, Bumper[]> = {
  welcome: [
    yt('bj-ro6OD9VI', 92_000), // pre-roll, 2017-2019
    yt('Xures7AcKHU', 55_000), // PRIME at AMC pre-roll
  ],
  // AMC's own upload of the 2021 ad.
  kidman: [yt('KiEeIxZJ9x0', 61_000)],
  silence: [
    yt('XTWSmTXIdF8', 33_000), // Stitch, AMC's own
    yt('cXyYK0EC3eI', 40_000), // Wicked, 2024
    yt('CLoz9xOvJk0', 17_000), // the conductor
    yt('nUsGl7fr9KM', 19_000), // film reels
    yt('0nfRMJz6lxM', 30_000), // "don't add your own soundtrack", 2003-2008
  ],
  // The thank you to AMC Stubs and A-List members, into the feature.
  feature: [
    yt('e1jp6zFyvso', 73_000), // A-List, 2026
    yt('ZKiyQj0aMbU', 15_000), // AMC Stubs
    yt('ErCkzWodcfc', 14_000), // AMC Stubs at IMAX, 2018
    yt('-dBmaN9ycsw', 33_000), // feature presentation, 2024
    yt('e4uSpIeSSIU', 32_000), // PRIME at AMC feature presentation
  ],
};
/* eslint-enable lingui/no-unlocalized-strings */

/** The links a slot draws from, one a line, as settings keep them. */
export const defaultBumpers = (slot: BumperSlot) =>
  BUMPERS[slot].map((b) => b.url).join('\n');

/** The length of a bumper of the list's own; others are taken to run a minute. */
export const bumperMs = (url: string) =>
  Object.values(BUMPERS)
    .flat()
    .find((b) => b.url === url)?.ms ?? 60_000;

export const bumperLabel = (slot: BumperSlot) =>
  ({
    welcome: t`Welcome`,
    kidman: t`Nicole Kidman`,
    silence: t`Silence your phones`,
    feature: t`Feature presentation`,
  })[slot];
