import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LuFastForward } from 'react-icons/lu';
import { cn } from '@aiostreams/ui/core/styling';
import { useSession } from '@/lib/jellyfin/session';
import { useItem, useKey } from '@/lib/jellyfin/queries';
import { currentHost } from '@/lib/hosts';
import { usePlayerFullscreen } from '@/lib/playback/fullscreen';
import { usePlayer } from '@/lib/playback/use-player';
import { videoEngine } from '@/lib/playback/video';
import { settings, useSetting } from '@/lib/settings';
import { goBack, navigate, to } from '@/lib/paths';
import { clock } from '@/lib/format';
import { closePlayback } from '@/lib/playback/session';
import {
  isHd,
  trailerSource,
  trailersOf,
  useFetchTrailer,
} from '@/lib/playback/trailers';
import {
  createReel,
  trailerCandidates,
  type Clip,
  type Reel,
  type Showing,
} from '@/lib/playback/preshow';
import { youTubeEngine } from '@/lib/playback/youtube-engine';
import { useLatest } from '@/hooks/use-latest';
import type { Query } from '@/lib/jellyfin/client';
import type { BaseItemDto, BaseItemDtoQueryResult } from '@/lib/jellyfin/types';
import { PlayerControls } from '@/features/player/controls';
import { PlayerAction } from '@/features/player/buttons';
import { Cover } from '@/features/player/cover';
import { usePlayhead } from '@/lib/playback/playhead';
import type { PlayerController } from '@/lib/playback/controller';
import { OBJECT_FIT, usePlayerPage } from '@/app/player/page';

/** Movies looked through for trailers; each costs a lookup only when its turn comes. */
const CANDIDATES = 40;

type Playable =
  | { kind: 'video'; url: string; originalLanguage?: string }
  | { kind: 'embed'; id: string };

/**
 * Bumpers and trailers for other movies before `itemId`, then the movie
 * itself, in place of this page so Back from it leaves the pre-show behind.
 */
export function PreshowPage({
  itemId,
  sourceId,
  showing,
  playlist,
}: {
  itemId: string;
  sourceId: string;
  showing: Showing;
  playlist?: string;
}) {
  const movie = useItem(itemId);
  usePlayerPage();
  const host = currentHost();
  usePlayerFullscreen(!host.player || !!host.fullscreen);
  React.useEffect(closePlayback, []);
  const feature = React.useCallback(
    () => navigate(to.play(itemId, sourceId, 0, playlist), { replace: true }),
    [itemId, sourceId, playlist]
  );
  const reel = useReel(movie.data, showing);
  const [clip, setClip] = React.useState<
    { clip: Clip; playable: Playable } | null | undefined
  >(undefined);
  // Set once the clip on screen plays; the card covers every hand-over until then.
  const [playing, setPlaying] = React.useState(false);
  // The trailer whose green band shows before it.
  const [band, setBand] = React.useState<BaseItemDto | null>(null);
  // One move at a time, so a clip ending as Skip is pressed moves on once.
  const moving = React.useRef(false);
  const advance = useLatest(async (): Promise<void> => {
    if (!reel || moving.current) return;
    moving.current = true;
    try {
      for (let next = await reel.next(); next; next = await reel.next()) {
        const playable = await reel.resolve(next);
        if (!playable) continue;
        // A trailer loads, held, behind its green band, then plays as it lifts.
        setPlaying(false);
        setClip({ clip: next, playable });
        reel.prepare();
        if (next.item) {
          setBand(next.item);
          await new Promise((done) => setTimeout(done, BAND_MS));
          setBand(null);
        }
        return;
      }
      feature();
    } finally {
      moving.current = false;
    }
  });
  React.useEffect(() => {
    if (reel) void advance.current();
  }, [reel, advance]);
  React.useEffect(() => {
    if (movie.isError) feature();
  }, [movie.isError, feature]);

  const back = () => goBack(to.item(itemId));
  const skip = () => {
    setPlaying(false);
    void advance.current();
  };
  if (!movie.data) return <Cover item={movie.data} />;
  const card = (
    <>
      <Blackout shown={!playing} />
      {band && <GreenBand item={band} />}
    </>
  );
  if (!clip) return card;
  const props = {
    movie: movie.data,
    clip: clip.clip,
    endsAt: reel!.endsAt,
    onBack: back,
    onSkip: skip,
    onFeature: feature,
    onPlaying: () => setPlaying(true),
    covered: !playing,
    held: !!band,
  };
  return (
    <>
      {clip.playable.kind === 'embed' ? (
        <EmbeddedClip key={clip.clip.url} {...props} id={clip.playable.id} />
      ) : (
        <PlayedClip
          key={clip.clip.url}
          {...props}
          url={clip.playable.url}
          originalLanguage={clip.playable.originalLanguage}
        />
      )}
      {card}
    </>
  );
}

/** The running order, with each trailer looked up as its turn comes. */
function useReel(movie: BaseItemDto | undefined, showing: Showing) {
  const { client, user } = useSession();
  const key = useKey();
  const queryClient = useQueryClient();
  const fetchTrailer = useFetchTrailer();
  const [sameGenre] = useSetting(settings.preshow.sameGenre);
  const [reel, setReel] = React.useState<
    (Reel & { resolve(clip: Clip): Promise<Playable | null> }) | null
  >(null);
  React.useEffect(() => {
    if (!movie?.Id) return;
    const list = (path: string, query: Query) =>
      queryClient
        .fetchQuery({
          queryKey: [...key, 'preshow', path],
          queryFn: () => client.get<BaseItemDtoQueryResult>(path, query),
          staleTime: 30 * 60_000,
        })
        .then((r) => r.Items ?? [])
        .catch(() => [] as BaseItemDto[]);
    // Latest answers with a bare list, not a page.
    const latest = queryClient
      .fetchQuery({
        queryKey: [...key, 'preshow', 'latest'],
        queryFn: () =>
          client.get<BaseItemDto[]>('/Items/Latest', {
            userId: user.Id,
            IncludeItemTypes: 'Movie',
            Limit: CANDIDATES,
          }),
        staleTime: 30 * 60_000,
      })
      .catch(() => [] as BaseItemDto[]);
    const candidates = Promise.all([
      list(`/Items/${movie.Id}/Similar`, { userId: user.Id, Limit: 20 }),
      latest,
    ]).then(([similar, newest]) =>
      trailerCandidates(movie, similar, newest, sameGenre)
    );
    // Each movie's details carry its trailers, which lists leave out; only HD ones play.
    const nextTrailer = async (): Promise<Clip | null> => {
      const pool = await candidates;
      while (pool.length) {
        const pick = pool.shift()!;
        const details = await queryClient
          .fetchQuery({
            queryKey: [...key, 'preshow-item', pick.Id],
            queryFn: () =>
              client.get<BaseItemDtoQueryResult>('/Items', {
                userId: user.Id,
                Ids: pick.Id,
                Fields: 'RemoteTrailers,Genres,OfficialRating',
              }),
            staleTime: 30 * 60_000,
          })
          .then((r) => r.Items?.[0])
          .catch(() => undefined);
        for (const trailer of details ? trailersOf(details) : [])
          if (await isHd(trailer.url)) return { ...trailer, item: details };
      }
      return null;
    };
    const made = createReel(movie, showing, nextTrailer);
    made.prepare();
    setReel({
      ...made,
      resolve: async (clip) => {
        const found = await fetchTrailer(clip.url).catch(() => null);
        return found && found.kind !== 'external' ? found : null;
      },
    });
    // Built once per movie; a setting changed mid-show waits for the next.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie?.Id]);
  return reel;
}

interface ClipProps {
  movie: BaseItemDto;
  clip: Clip;
  endsAt: number;
  onBack(): void;
  onSkip(): void;
  onFeature(): void;
  /** The clip got going, so the card can lift. */
  onPlaying(): void;
  /** The card is over it, which the controls keep out of the way of. */
  covered: boolean;
  /** Loaded but waiting, behind the green band, to play. */
  held: boolean;
}

/** Played this far, a clip is past its loading, and the black lifts off it. */
const FLOWING_MS = 250;

/** How long a trailer's green band holds. */
const BAND_MS = 7000;

/** Between clips: cut to at once, then faded out as the next one plays. */
function Blackout({ shown }: { shown: boolean }) {
  return (
    <div
      data-ui="preshow-black"
      className={cn(
        'pointer-events-none fixed inset-0 z-[5] bg-black',
        shown ? 'opacity-100' : 'opacity-0 transition-opacity duration-700'
      )}
    />
  );
}

/** The MPA's names for its ratings, which the band gives over the rating. */
const RATING_NAMES: Record<string, () => string> = {
  G: () => t`General audiences`,
  PG: () => t`Parental guidance suggested`,
  'PG-13': () => t`Parents strongly cautioned`,
  R: () => t`Restricted`,
  'NC-17': () => t`No one 17 and under admitted`,
};

const BAND_GREEN = '#1f7a45';

/**
 * The green band before a trailer, as theaters show it: the preview is
 * approved to go with the feature, and the film it advertises is rated so.
 * Sized in `em` off the card's width, so it keeps its look on any screen.
 */
function GreenBand({ item }: { item: BaseItemDto }) {
  const rating = item.OfficialRating?.replace(/^US[-:]/i, '').toUpperCase();
  const label = rating ? RATING_NAMES[rating]?.() : undefined;
  return (
    <div
      data-ui="preshow-band"
      className="pointer-events-none fixed inset-0 z-[6] flex items-center justify-center bg-black"
    >
      <div
        className="flex aspect-video w-[min(100vw,calc(100vh*16/9))] flex-col items-center font-semibold uppercase leading-tight text-white"
        style={{ backgroundColor: BAND_GREEN, fontSize: 'min(2.3vw, 4.1vh)' }}
      >
        <div className="mt-[13%] flex flex-col items-center gap-[0.4em] text-center tracking-wide">
          <p>
            <Trans>
              The following preview has been{' '}
              <span className="text-[1.3em]">approved</span> to
            </Trans>
          </p>
          <p className="text-[1.75em] font-bold">
            <Trans>Accompany this feature</Trans>
          </p>
          <p>
            <Trans>By the Motion Picture Association of America, Inc.</Trans>
          </p>
        </div>
        <div className="mt-[8%] flex flex-col items-start gap-[0.35em]">
          <p className="text-[0.6em] tracking-wide">
            {rating
              ? t`The film advertised has been rated`
              : t`The film advertised has not yet been rated`}
          </p>
          {rating && (
            <div className="flex h-[5em] w-[19em] border-[0.12em] border-white">
              <div className="flex w-[5.5em] flex-col border-e-[0.12em] border-white">
                {label && (
                  <p
                    className="text-balance bg-white px-[0.5em] py-[0.2em] text-center text-[0.42em] font-bold leading-tight"
                    style={{ color: BAND_GREEN }}
                  >
                    {label}
                  </p>
                )}
                <p
                  className={cn(
                    'flex flex-1 items-center justify-center px-[0.2em] font-black leading-none tracking-tight',
                    rating.length > 2 ? 'text-[1.9em]' : 'text-[2.6em]'
                  )}
                >
                  {rating}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Whether a clip's player is far enough in to show it. */
function useFlowing(player: PlayerController): boolean {
  return usePlayhead(
    player.playhead,
    (head) =>
      player.state.started &&
      !player.state.paused &&
      head.positionMs >= FLOWING_MS
  );
}

/** The time left to the movie, by the wall clock. */
function useTimeLeft(endsAt: number): string {
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return clock(Math.max(0, endsAt - now));
}

/** Where the skip intro button would be: the time to the movie, and a way straight to it. */
function Marquee({
  movie,
  endsAt,
  onFeature,
  shown,
}: Pick<ClipProps, 'movie' | 'endsAt' | 'onFeature'> & { shown: boolean }) {
  const left = useTimeLeft(endsAt);
  const name = movie.Name ?? '';
  return (
    <div
      data-ui="preshow-marquee"
      className={cn(
        'absolute bottom-[calc(7rem+env(safe-area-inset-bottom))] end-[max(1rem,env(safe-area-inset-right))] z-20 flex flex-col items-end gap-2 transition-opacity duration-300 sm:bottom-[calc(8rem+env(safe-area-inset-bottom))] sm:end-[max(2rem,env(safe-area-inset-right))]',
        !shown && 'pointer-events-none opacity-0'
      )}
    >
      <p className="rounded-full bg-black/60 px-3 py-1 text-xs font-medium tabular-nums text-gray-200 backdrop-blur-sm">
        <Trans>
          {name} in {left}
        </Trans>
      </p>
      <PlayerAction
        className="shadow-lg"
        rightIcon={<LuFastForward />}
        onClick={onFeature}
      >
        <Trans>Skip to the movie</Trans>
      </PlayerAction>
    </div>
  );
}

function PlayedClip({
  url,
  originalLanguage,
  ...props
}: ClipProps & { url: string; originalLanguage: string | undefined }) {
  const { client } = useSession();
  const video = React.useRef<HTMLVideoElement>(null);
  const [hostPlayer] = React.useState(() => currentHost().player);
  const [fit] = useSetting(settings.video.fit);
  const [subtitleStyle] = useSetting(settings.subtitle.style);
  const source = React.useMemo(
    () => trailerSource(url, originalLanguage),
    [url, originalLanguage]
  );
  const player = usePlayer([hostPlayer ?? videoEngine(video)], {
    client,
    item: props.clip.item ?? props.movie,
    url,
    source,
    startMs: 0,
    startPaused: props.held,
    onEnded: props.onSkip,
    subtitleStyle,
  });
  usePlayingClip(player, props);
  return (
    <div
      data-page="player"
      data-name="preshow"
      className={cn('fixed inset-0', !hostPlayer && 'bg-black')}
    >
      {hostPlayer ? null : (
        <video
          ref={video}
          data-ui="video"
          className={cn('h-full w-full', OBJECT_FIT[fit])}
          autoPlay
          playsInline
        />
      )}
      <ClipControls player={player} {...props} />
    </div>
  );
}

/** Moves on from a clip that fails, and tells the page once one plays. */
function usePlayingClip(player: PlayerController, props: ClipProps): boolean {
  // Once shown it stays shown, through pauses.
  const flowing = useFlowing(player);
  const [revealed, setRevealed] = React.useState(false);
  if (flowing && !revealed) setRevealed(true);
  // Held behind the band, it plays the moment the band lifts.
  const wasHeld = React.useRef(props.held);
  const play = useLatest(() => player.setPaused(false));
  React.useEffect(() => {
    if (wasHeld.current && !props.held) play.current();
    wasHeld.current = props.held;
  }, [props.held, play]);
  const latest = useLatest(props);
  React.useEffect(() => {
    if (revealed) latest.current.onPlaying();
  }, [revealed, latest]);
  const failed = !!player.state.error;
  React.useEffect(() => {
    if (failed) latest.current.onSkip();
  }, [failed, latest]);
  // Skipped: the card is back over a clip that showed, and it falls quiet
  // while the next loads. Not on the way in, when the card is still lifting.
  const shown = React.useRef(false);
  const pause = useLatest(() => player.setPaused(true));
  React.useEffect(() => {
    if (!props.covered) shown.current = true;
    else if (shown.current) pause.current();
  }, [props.covered, pause]);
  return revealed;
}

/** The player's controls and the way to the movie, kept out of sight while the card covers the clip. */
function ClipControls({
  player,
  ...props
}: ClipProps & { player: PlayerController }) {
  return (
    <div className={cn(props.covered && 'pointer-events-none opacity-0')}>
      <PlayerControls
        item={props.clip.item ?? props.movie}
        player={player}
        onBack={props.onBack}
        caption={props.clip.item ? t`Trailer` : props.clip.name}
        steps="preshow"
        onNext={props.onSkip}
      />
      <Marquee {...props} shown={!props.covered} />
    </div>
  );
}

/**
 * The embed's own size. YouTube picks the stream's quality from the player's
 * size, so it is drawn this big and scaled down to fit; set in pixels, it also
 * keeps iOS from sizing the frame to its content.
 */
const EMBED_WIDTH = 1920;
const EMBED_HEIGHT = 1080;

/** Where a 16:9 picture sits in `box`, filling it as far as it can. */
function useFitted(box: React.RefObject<HTMLDivElement | null>) {
  const [fitted, setFitted] = React.useState({ x: 0, y: 0, scale: 0 });
  React.useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const place = () => {
      const { width, height } = el.getBoundingClientRect();
      const scale = Math.min(width / EMBED_WIDTH, height / EMBED_HEIGHT);
      setFitted({
        x: (width - EMBED_WIDTH * scale) / 2,
        y: (height - EMBED_HEIGHT * scale) / 2,
        scale,
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => observer.disconnect();
  }, [box]);
  return fitted;
}

/**
 * A YouTube video under the page's own controls: its embed draws the picture
 * and takes no clicks, and the controls drive it as they would any player.
 */
function EmbeddedClip({ id, ...props }: ClipProps & { id: string }) {
  const { client } = useSession();
  const frame = React.useRef<HTMLIFrameElement>(null);
  const box = React.useRef<HTMLDivElement>(null);
  const fitted = useFitted(box);
  const [subtitleStyle] = useSetting(settings.subtitle.style);
  const url = `youtube:${id}`;
  const source = React.useMemo(() => trailerSource(url, undefined), [url]);
  const player = usePlayer([youTubeEngine(frame)], {
    client,
    item: props.clip.item ?? props.movie,
    url,
    source,
    startMs: 0,
    startPaused: props.held,
    onEnded: props.onSkip,
    subtitleStyle,
    thumbnails: false,
  });
  const flowing = usePlayingClip(player, props);
  return (
    <div
      data-page="player"
      data-name="preshow"
      className="fixed inset-0 bg-black"
    >
      <div ref={box} className="absolute inset-0 overflow-hidden">
        <iframe
          ref={frame}
          data-ui="video"
          title={props.clip.item?.Name ?? props.clip.name}
          allow="autoplay; encrypted-media"
          referrerPolicy="strict-origin-when-cross-origin"
          tabIndex={-1}
          width={EMBED_WIDTH}
          height={EMBED_HEIGHT}
          style={{
            transform: `translate(${fitted.x}px, ${fitted.y}px) scale(${fitted.scale})`,
          }}
          className={cn(
            'pointer-events-none absolute left-0 top-0 max-w-none origin-top-left border-0',
            // Hidden outright until it plays, so none of YouTube's own loading shows.
            !flowing && 'invisible'
          )}
        />
      </div>
      <ClipControls player={player} {...props} />
    </div>
  );
}
