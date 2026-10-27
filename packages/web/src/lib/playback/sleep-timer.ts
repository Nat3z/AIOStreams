import React from 'react';
import type { PlayerController } from './controller';

/**
 * When playback stops for the night: at a time, or as the title playing ends
 * rather than playing on. Kept outside the player, which mounts afresh for
 * every title, so a timer set on one episode carries on through the next.
 */
export type SleepTimer =
  { endsAt: number; minutes: number } | { atEnd: true } | null;

export const SLEEP_MINUTES = [15, 30, 45, 60, 90] as const;

/** The sound fades out over this long before it pauses. */
const FADE_MS = 15_000;

let timer: SleepTimer = null;
const listeners = new Set<() => void>();

export function setSleepTimer(next: SleepTimer): void {
  timer = next;
  for (const listener of listeners) listener();
}

export function sleepTimer(): SleepTimer {
  return timer;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useSleepTimer(): SleepTimer {
  return React.useSyncExternalStore(subscribe, sleepTimer);
}

/** Takes the timer that stops at the end of the title, if that is the one set. */
export function takeSleepAtEnd(): boolean {
  if (!timer || !('atEnd' in timer)) return false;
  setSleepTimer(null);
  return true;
}

/** Long enough for the next title's player to open in place of the last one. */
const LEFT_MS = 30_000;
let leaving: ReturnType<typeof setTimeout> | undefined;

/**
 * Fades the sound out as a set time comes, then pauses and puts it back. A
 * timer outlives one title's player, but not leaving the player altogether.
 */
export function useSleepCountdown(player: PlayerController): void {
  const set = useSleepTimer();
  const latest = React.useRef(player);
  latest.current = player;
  React.useEffect(() => {
    clearTimeout(leaving);
    return () => {
      leaving = setTimeout(() => setSleepTimer(null), LEFT_MS);
    };
  }, []);
  const endsAt = set && 'endsAt' in set ? set.endsAt : null;
  React.useEffect(() => {
    if (endsAt === null) return;
    let from: { volume: number; muted: boolean } | null = null;
    const restore = () => {
      if (!from) return;
      const { volume } = from;
      from = null;
      latest.current.setVolume(volume);
    };
    const tick = setInterval(() => {
      const p = latest.current;
      const left = endsAt - Date.now();
      if (left <= 0) {
        p.setPaused(true);
        restore();
        setSleepTimer(null);
        return;
      }
      if (left > FADE_MS || p.state.paused) return restore();
      from ??= { volume: p.state.volume, muted: p.state.muted };
      if (!from.muted) p.setVolume(from.volume * (left / FADE_MS));
    }, 250);
    return () => {
      clearInterval(tick);
      restore();
    };
  }, [endsAt]);
}
