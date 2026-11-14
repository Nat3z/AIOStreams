import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import React from 'react';
import { LuFilm } from 'react-icons/lu';
import { Button } from '@aiostreams/ui/button';
import { Modal } from '@aiostreams/ui/modal';
import { duration, ticksToMs } from '@/lib/format';
import { createLive, useLive } from '@/lib/live-value';
import { useRestoreFocus } from '@/lib/input/restore-focus';
import {
  PRESHOW_MINUTES,
  SHOWTIME_MINUTES,
  settings,
  useSetting,
  type PreshowMode,
} from '@/lib/settings';
import { askPreshow, preshowBudgetMs } from '@/lib/playback/preshow';
import { useVersionPicker } from '@/features/versions/version-picker';
import { PillTabs } from '@/components/pill-tabs';
import type { BaseItemDto } from '@/lib/jellyfin/types';

const asking = createLive<BaseItemDto | null>(null);

/** Offered for a movie, which plays from the start after it. */
export const offersPreshow = (item: BaseItemDto | undefined) =>
  item?.Type === 'Movie' && item.LocationType !== 'Virtual';

export const openPreshow = (movie: BaseItemDto) => asking.set(movie);

/**
 * Asks how long a pre-show to play before a movie: a set length, or the
 * length of the whole showing, which the movie's runtime takes from. The last
 * answer is kept on this device for next time.
 */
export function PreshowDialog() {
  const movie = useLive(asking);
  const restoreFocus = useRestoreFocus(!!movie);
  const picker = useVersionPicker();
  const [mode, setMode] = useSetting(settings.preshow.mode);
  const [length, setLength] = useSetting(settings.preshow.minutes);
  const [showtime, setShowtime] = useSetting(settings.preshow.showtime);
  const showing =
    mode === 'showtime'
      ? ({ kind: 'showtime', minutes: showtime } as const)
      : ({ kind: 'length', minutes: length } as const);
  const budget = movie ? preshowBudgetMs(movie, showing) : 0;
  // Run once the dialog has handed focus back, so the version list keeps it.
  const pending = React.useRef<(() => void) | null>(null);
  const start = () => {
    if (!movie) return;
    pending.current = () => {
      askPreshow(movie.Id!, showing);
      picker.play(movie, { startMs: 0 });
    };
    asking.set(null);
  };
  const runtime = movie ? ticksToMs(movie.RunTimeTicks) : 0;
  const runs = duration(runtime);
  const leaves = duration(budget);
  return (
    <Modal
      data-ui="dialog"
      data-name="preshow"
      open={!!movie}
      onOpenChange={(open) => !open && asking.set(null)}
      onCloseAutoFocus={(e) => {
        restoreFocus(e);
        const run = pending.current;
        pending.current = null;
        run?.();
      }}
      title={t`Play with a pre-show`}
      description={movie?.Name ?? undefined}
      contentClass="max-w-md"
    >
      <div className="space-y-5">
        <PillTabs<PreshowMode>
          name="preshow-mode"
          options={[
            { value: 'length', label: t`Pre-show length` },
            { value: 'showtime', label: t`Showtime` },
          ]}
          value={mode}
          onChange={setMode}
        />
        <div className="flex flex-wrap gap-2">
          {(mode === 'showtime' ? SHOWTIME_MINUTES : PRESHOW_MINUTES).map(
            (m) => {
              const selected = m === (mode === 'showtime' ? showtime : length);
              return (
                <Button
                  key={m}
                  data-name={String(m)}
                  size="sm"
                  intent={selected ? 'white' : 'gray-outline'}
                  className="rounded-full tabular-nums"
                  onClick={() =>
                    mode === 'showtime' ? setShowtime(m) : setLength(m)
                  }
                >
                  {mode === 'showtime'
                    ? duration(m * 60_000)
                    : plural(m, { one: '# min', other: '# min' })}
                </Button>
              );
            }
          )}
        </div>
        <p className="text-sm text-[--muted]">
          {mode === 'length'
            ? t`Bumpers and trailers for other movies, then the movie.`
            : runtime
              ? budget > 0
                ? t`The movie runs ${runs}, leaving ${leaves} of pre-show.`
                : t`The movie fills the showtime, so it starts straight away.`
              : t`This movie's runtime isn't known, so the pre-show runs up to 30 minutes.`}
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            intent="gray-outline"
            className="rounded-full"
            onClick={() => asking.set(null)}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button
            intent="white"
            className="rounded-full"
            leftIcon={<LuFilm />}
            autoFocus
            onClick={start}
          >
            <Trans>Play</Trans>
          </Button>
        </div>
      </div>
    </Modal>
  );
}
