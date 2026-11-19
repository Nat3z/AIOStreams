import React from 'react';
import { t } from '@lingui/core/macro';
import { LuCompass, LuHeart, LuHouse, LuSearch } from 'react-icons/lu';
import { Select } from '@aiostreams/ui/select';
import { Combobox } from '@aiostreams/ui/combobox';
import { Switch } from '@aiostreams/ui/switch';
import { cn } from '@aiostreams/ui/core/styling';
import { useLiveTvView, useViews } from '@/lib/jellyfin/queries';
import { libraryLabel } from '@/lib/format';
import { currentHost } from '@/lib/hosts';
import {
  settings,
  useSetting,
  MAX_FEATURED,
  HERO_SECONDS,
  type EpisodeLayout,
  type GlassSurface,
  type TrailerSpot,
  type HeroMode,
  type LiveTvPlace,
  type PosterLine,
  type PosterSize,
} from '@/lib/settings';
import {
  Answer,
  AnswerGroup,
  Pills,
  deviceOnly,
  DeviceOnly,
  seconds,
} from './_components/common';
import { Example, cover, useArt, type Art } from './example';
import { backgroundOptions, shownBackground } from './interface';

/*
 * What follows the user comes first, then what's kept on this device. It
 * opens on an example: a mock of the app with the quick answers beside it.
 */

const NOTHING = 'none';

export function BrowsingSection() {
  return (
    <div className="space-y-12">
      <Home />
      <Grids />
      <Episodes />
    </div>
  );
}

/** What home opens on and shows. */
function Home() {
  const views = useViews();
  const [featured, setFeatured] = useSetting(settings.interface.featured);
  const [heroMode, setHeroMode] = useSetting(settings.interface.heroMode);
  const [heroSeconds, setHeroSeconds] = useSetting(
    settings.interface.heroSeconds
  );
  const [mergeNextUp, setMergeNextUp] = useSetting(
    settings.interface.mergeNextUp
  );
  const [liveTv, setLiveTv] = useSetting(settings.interface.liveTv);
  const hasLiveTv = !!useLiveTvView().data;

  const option = (value: string, label: string) => ({
    value,
    label,
    textValue: label,
  });
  const featuredOptions = [
    option('resume', t`Continue watching`),
    option('next-up', t`Next up`),
    ...(views.data?.Items ?? []).map((v) =>
      option(
        `view:${v.Id}`,
        [v.Name, libraryLabel(v)].filter(Boolean).join(' · ')
      )
    ),
    option(NOTHING, t`Nothing`),
  ];
  // Catalogs since removed would count towards the limit without showing.
  const known = new Set(featuredOptions.map((o) => o.value));
  const featuredValue =
    featured === 'auto'
      ? []
      : !featured.length
        ? [NOTHING]
        : views.data
          ? featured.filter((s) => known.has(s))
          : featured;
  // Nothing excludes every other choice.
  const changeFeatured = (next: string[]) => {
    const added = next.filter((v) => !featuredValue.includes(v));
    if (added.includes(NOTHING)) setFeatured([]);
    else {
      const sources = next.filter((v) => v !== NOTHING);
      setFeatured(sources.length ? sources : 'auto');
    }
  };

  return (
    <AnswerGroup name="home" title={t`Home`} holds="profile">
      <Answer
        label={t`Featured`}
        help={t`Up to ${MAX_FEATURED}, mixed together. Left empty, your first movie and show libraries are featured.`}
      >
        <div className="max-w-md">
          <Combobox
            multiple
            aria-label={t`Featured on home`}
            placeholder={t`Automatic`}
            emptyMessage={t`Nothing matches.`}
            options={featuredOptions}
            maxItems={MAX_FEATURED}
            value={featuredValue}
            onValueChange={changeFeatured}
          />
        </div>
      </Answer>
      <Answer
        label={t`Hero`}
        help={
          heroMode === 'rotate'
            ? t`Rotates through the featured titles.`
            : t`Pinned above the rows, showing the card the pointer, keyboard or remote is on. Touch screens and narrow windows keep it rotating.`
        }
      >
        <Pills
          label={t`Hero`}
          options={heroOptions()}
          isOn={(v) => v === heroMode}
          onPick={(v) => setHeroMode(v as HeroMode)}
        />
      </Answer>
      <Answer
        label={t`Time on each title`}
        help={t`How long the hero stays on a featured title while it rotates.`}
      >
        <div className="max-w-md">
          <Select
            aria-label={t`Time on each title`}
            options={HERO_SECONDS.map((s) => ({
              value: String(s),
              label: seconds(s),
            }))}
            value={String(heroSeconds)}
            onValueChange={(v) => setHeroSeconds(Number(v))}
          />
        </div>
      </Answer>
      {hasLiveTv && (
        <Answer
          label={t`Live TV`}
          help={t`Hidden, channels also leave search and favourites.`}
        >
          <Pills
            label={t`Live TV`}
            options={liveTvOptions()}
            isOn={(v) => v === liveTv}
            onPick={(v) => setLiveTv(v as LiveTvPlace)}
          />
        </Answer>
      )}
      <Answer label={t`Rows`}>
        <Switch
          side="right"
          label={t`Merge continue watching and next up`}
          help={t`Next episodes join the continue watching row, after what you are partway through.`}
          value={mergeNextUp}
          onValueChange={setMergeNextUp}
        />
      </Answer>
    </AnswerGroup>
  );
}

const heroOptions = () => [
  { value: 'rotate', label: t`Rotates` },
  { value: 'follow', label: t`Follows the card` },
  { value: 'corner', label: t`In the corner` },
];

const liveTvOptions = () => [
  { value: 'home', label: t`On home and in the navigation` },
  { value: 'nav', label: t`In the navigation only` },
  { value: 'off', label: t`Hidden` },
];

const posterSizeOptions = () => [
  { value: 'small', label: t`Small` },
  { value: 'medium', label: t`Medium` },
  { value: 'large', label: t`Large` },
];

const posterLineOptions = () => [
  { value: 'title', label: t`Title` },
  { value: 'year', label: t`Year` },
];

const episodeOptions = () => [
  { value: 'auto', label: t`Automatic` },
  { value: 'row', label: t`Row` },
  { value: 'list', label: t`List` },
];

const toggled = (lines: PosterLine[], line: PosterLine): PosterLine[] =>
  lines.includes(line) ? lines.filter((l) => l !== line) : [...lines, line];

/** How posters and results are laid out. */
function Grids() {
  const [posterSize, setPosterSize] = useSetting(settings.interface.posterSize);
  const [posterLines, setPosterLines] = useSetting(
    settings.interface.posterLines
  );
  const [combineSearch, setCombineSearch] = useSetting(
    settings.interface.combineSearch
  );
  const [cardPreview, setCardPreview] = useSetting(
    settings.interface.cardPreview
  );
  const [trailers, setTrailers] = useSetting(settings.interface.trailers);
  const [trailerSound, setTrailerSound] = useSetting(
    settings.interface.trailerSound
  );
  const touch = !currentHost().tv && matchMedia('(pointer: coarse)').matches;

  return (
    <AnswerGroup
      name="posters-and-grids"
      title={t`Posters and search`}
      holds="profile"
    >
      <Answer label={t`Poster size`} help={t`How large cards are in a grid.`}>
        <Pills
          label={t`Poster size`}
          options={posterSizeOptions()}
          isOn={(v) => v === posterSize}
          onPick={(v) => setPosterSize(v as PosterSize)}
        />
      </Answer>
      <Answer
        label={t`Under posters`}
        help={t`With neither, posters stand alone. One without artwork still shows its title.`}
      >
        <Pills
          multiple
          label={t`Under posters`}
          options={posterLineOptions()}
          isOn={(v) => posterLines.includes(v as PosterLine)}
          onPick={(v) => setPosterLines(toggled(posterLines, v as PosterLine))}
        />
      </Answer>
      {!touch && (
        <DeviceOnly>
          <Answer label={t`Card you rest on`}>
            <Switch
              side="right"
              label={t`Preview the card you rest on`}
              help={t`On home while the hero rotates, in search and in grids. Under a mouse a card pops out; with a keyboard or remote it opens out to its details. Kept on this device.`}
              value={cardPreview}
              onValueChange={setCardPreview}
            />
          </Answer>
        </DeviceOnly>
      )}
      <DeviceOnly>
        <Answer
          label={t`Trailers`}
          help={t`Play by themselves once you rest on a title for a moment. In the hero, only one you went to. Kept on this device.`}
        >
          <Pills
            multiple
            label={t`Play by themselves`}
            options={[
              ...(touch ? [] : [{ value: 'cards', label: t`Cards` }]),
              { value: 'hero', label: t`Hero` },
              { value: 'item', label: t`Title pages` },
            ]}
            isOn={(v) => trailers[v as TrailerSpot]}
            onPick={(v) =>
              setTrailers({
                ...trailers,
                [v]: !trailers[v as TrailerSpot],
              })
            }
          />
          <Switch
            side="right"
            label={t`Sound`}
            help={t`Off, a trailer still plays with sound once you open it whole.`}
            value={trailerSound}
            onValueChange={setTrailerSound}
          />
        </Answer>
      </DeviceOnly>
      <Answer label={t`Search`}>
        <Switch
          side="right"
          label={t`Combine movie and show results`}
          help={t`One grid instead of a row each for movies and shows.`}
          value={combineSearch}
          onValueChange={setCombineSearch}
        />
      </Answer>
    </AnswerGroup>
  );
}

/** How a show's episodes are laid out and marked. */
function Episodes() {
  const [episodeLayout, setEpisodeLayout] = useSetting(
    settings.interface.episodeLayout
  );
  const [blurSpoilers, setBlurSpoilers] = useSetting(
    settings.interface.blurSpoilers
  );
  const [markUnaired, setMarkUnaired] = useSetting(settings.next.markUnaired);

  return (
    <AnswerGroup name="episodes" title={t`Episodes`} holds="profile">
      <DeviceOnly>
        <Answer
          label={t`Episodes`}
          help={
            episodeLayout === 'auto'
              ? deviceOnly(t`Listed on narrow screens, in a row on wide ones.`)
              : t`Kept on this device.`
          }
        >
          <Pills
            label={t`Episodes`}
            options={episodeOptions()}
            isOn={(v) => v === episodeLayout}
            onPick={(v) => setEpisodeLayout(v as EpisodeLayout)}
          />
        </Answer>
      </DeviceOnly>
      <Answer label={t`Spoilers`}>
        <Switch
          side="right"
          label={t`Blur episodes you haven't started`}
          help={t`Blurs their pictures, titles and descriptions until the pointer, keyboard or remote is on one.`}
          value={blurSpoilers}
          onValueChange={setBlurSpoilers}
        />
      </Answer>
      <Answer label={t`Unaired`}>
        <Switch
          side="right"
          label={t`Mark unaired episodes`}
          help={t`Episodes that haven't aired yet show as unaired, ask before playing, and are passed over when playing on or downloading a season. Turn off if their air dates are often wrong.`}
          value={markUnaired}
          onValueChange={setMarkUnaired}
        />
      </Answer>
    </AnswerGroup>
  );
}

/* ------------------------------------------------------------ the example */

interface Look {
  hero: HeroMode;
  size: PosterSize;
  lines: PosterLine[];
  episodes: EpisodeLayout;
  background: GlassSurface;
}

type LookScene = 'home' | 'show';

interface LookQuestion {
  id: keyof Look;
  scene: LookScene;
  title: string;
  multiple?: boolean;
  options: { value: string; label: string }[];
  isOn: (v: string) => boolean;
  pick: (v: string) => void;
  peek: (v: string) => Partial<Look>;
}

const POSTERS_ACROSS: Record<PosterSize, number> = {
  small: 6,
  medium: 5,
  large: 4,
};

function explainLook(look: Look, id: keyof Look): string {
  switch (id) {
    case 'hero':
      return look.hero === 'rotate'
        ? t`The hero rotates through featured titles above the rows.`
        : look.hero === 'follow'
          ? t`The hero shows the card you're on, behind the whole page.`
          : t`The card you're on shows in the top corner, leaving the page to the rows.`;
    case 'size': {
      const across = POSTERS_ACROSS[look.size];
      return t`${across} posters fit across a row in a wide window.`;
    }
    case 'lines':
      return !look.lines.length
        ? t`Posters stand alone.`
        : look.lines.length === 2
          ? t`Each poster has its title and year under it.`
          : look.lines[0] === 'title'
            ? t`Each poster has its title under it.`
            : t`Each poster has its year under it.`;
    case 'episodes':
      return look.episodes === 'auto'
        ? t`Episodes sit in a row on a wide screen, and in a list on a narrow one.`
        : look.episodes === 'row'
          ? t`Episodes sit in a row you scroll sideways.`
          : t`Episodes are listed one under another, with more about each.`;
    case 'background':
      return look.background === 'solid'
        ? t`The navigation sits on the app's own colour.`
        : look.background === 'frosted'
          ? t`The navigation is frosted glass, the page blurred through it.`
          : t`The navigation is liquid glass, bending the page at its edges.`;
  }
}

/** Browsing's example: a mock of the app, the quick answers beside it. */
export function BrowsingExample() {
  const [heroMode, setHeroMode] = useSetting(settings.interface.heroMode);
  const [posterSize, setPosterSize] = useSetting(settings.interface.posterSize);
  const [posterLines, setPosterLines] = useSetting(
    settings.interface.posterLines
  );
  const [episodeLayout, setEpisodeLayout] = useSetting(
    settings.interface.episodeLayout
  );
  const [background, setBackground] = useSetting(settings.theme.glassSurface);
  const art = useArt();
  const look: Look = {
    hero: heroMode,
    size: posterSize,
    lines: posterLines,
    episodes: episodeLayout,
    background: shownBackground(background),
  };
  const [peek, setPeek] = React.useState<Partial<Look> | null>(null);
  const [at, setAt] = React.useState<keyof Look>('hero');
  const view: Look = { ...look, ...peek };

  const questions: LookQuestion[] = [
    {
      id: 'hero',
      scene: 'home',
      title: t`Hero`,
      options: heroOptions(),
      isOn: (v) => v === look.hero,
      pick: (v) => setHeroMode(v as HeroMode),
      peek: (v) => ({ hero: v as HeroMode }),
    },
    {
      id: 'size',
      scene: 'home',
      title: t`Poster size`,
      options: posterSizeOptions(),
      isOn: (v) => v === look.size,
      pick: (v) => setPosterSize(v as PosterSize),
      peek: (v) => ({ size: v as PosterSize }),
    },
    {
      id: 'lines',
      scene: 'home',
      title: t`Under posters`,
      multiple: true,
      options: posterLineOptions(),
      isOn: (v) => look.lines.includes(v as PosterLine),
      pick: (v) => setPosterLines(toggled(look.lines, v as PosterLine)),
      peek: (v) => ({ lines: toggled(look.lines, v as PosterLine) }),
    },
    {
      id: 'background',
      scene: 'home',
      title: t`Navigation background`,
      options: backgroundOptions(),
      isOn: (v) => v === look.background,
      pick: (v) => setBackground(v as GlassSurface),
      peek: (v) => ({ background: v as GlassSurface }),
    },
    {
      id: 'episodes',
      scene: 'show',
      title: t`Episodes`,
      options: episodeOptions(),
      isOn: (v) => v === look.episodes,
      pick: (v) => setEpisodeLayout(v as EpisodeLayout),
      peek: (v) => ({ episodes: v as EpisodeLayout }),
    },
  ];
  const scene = questions.find((q) => q.id === at)?.scene ?? 'home';

  return (
    <Example
      frame={<MockApp look={view} scene={scene} art={art} />}
      note={explainLook(view, at)}
      peeking={peek !== null}
      questions={questions.map((q) => ({
        id: q.id,
        title: q.title,
        onAt: () => setAt(q.id),
        body: (
          <Pills
            label={q.title}
            multiple={q.multiple}
            options={q.options}
            isOn={q.isOn}
            onPick={q.pick}
            onPeek={(v) => setPeek(v === null ? null : q.peek(v))}
          />
        ),
      }))}
    />
  );
}

/** A mock of the app from the user's own titles, sized in em so it reads the same at any width. */
function MockApp({
  look,
  scene,
  art,
}: {
  look: Look;
  scene: LookScene;
  art: Art[];
}) {
  // The card the pointer is on, which a following hero shows.
  const focused = art[1];
  const behind = scene === 'show' || look.hero === 'follow';
  return (
    <div
      aria-hidden
      className="relative aspect-video overflow-hidden rounded-2xl bg-gray-950 bg-cover bg-center ring-1 ring-white/10 [container-type:inline-size]"
      style={behind ? cover(focused?.backdrop) : undefined}
    >
      {behind && (
        <div className="absolute inset-0 bg-gradient-to-t from-gray-950 via-gray-950/70 to-black/30" />
      )}
      <div
        className="absolute inset-0 overflow-hidden"
        style={{ fontSize: 'min(1.9cqw, 13px)' }}
      >
        {scene === 'home' ? (
          <MockHome look={look} art={art} />
        ) : (
          <MockShow look={look} art={art} />
        )}
        <MockNav background={look.background} />
      </div>
    </div>
  );
}

function MockHome({ look, art }: { look: Look; art: Art[] }) {
  const across = POSTERS_ACROSS[look.size];
  const [lead, focused] = [art[0], art[1]];
  return (
    <div className="space-y-[1.2em] p-[1.2em]">
      {look.hero === 'rotate' && (
        <div
          className="relative flex h-[11em] items-end overflow-hidden rounded-[0.8em] bg-gray-800 bg-cover bg-center p-[1em]"
          style={cover(lead?.backdrop)}
        >
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
          <div className="relative">
            <p className="text-[1.6em] font-bold leading-tight">{lead?.name}</p>
            <p className="text-[0.85em] text-white/70">{lead?.year}</p>
          </div>
          <div className="absolute bottom-[1em] end-[1em] flex gap-[0.3em]">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className={cn(
                  'h-[0.35em] rounded-full bg-white',
                  i ? 'w-[0.35em] opacity-40' : 'w-[1em]'
                )}
              />
            ))}
          </div>
        </div>
      )}
      {look.hero === 'follow' && (
        <div className="flex h-[8em] flex-col justify-end">
          <p className="text-[1.8em] font-bold leading-tight">
            {focused?.name}
          </p>
          <p className="text-[0.85em] text-white/70">{focused?.year}</p>
        </div>
      )}
      {look.hero === 'corner' && (
        <div className="flex items-start justify-between gap-[1em]">
          <p className="pt-[0.3em] text-[1.4em] font-bold">{t`Home`}</p>
          <div
            className="relative flex aspect-video w-[42%] items-end overflow-hidden rounded-[0.6em] bg-gray-800 bg-cover bg-center p-[0.6em]"
            style={cover(focused?.backdrop)}
          >
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
            <p className="relative text-[0.9em] font-semibold">
              {focused?.name}
            </p>
          </div>
        </div>
      )}
      {[0, 1].map((row) => (
        <div key={row} className="space-y-[0.5em]">
          <span className="block h-[0.9em] w-[8em] rounded-full bg-white/15" />
          <div
            className="grid gap-[0.6em]"
            style={{ gridTemplateColumns: `repeat(${across}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: across }, (_, i) => {
              const item = art.length
                ? art[(i + row * 3) % art.length]
                : undefined;
              return (
                <div key={i} className="min-w-0 space-y-[0.25em]">
                  <div
                    className={cn(
                      'aspect-[2/3] rounded-[0.5em] bg-gray-800 bg-cover bg-center transition-all',
                      look.hero !== 'rotate' &&
                        row === 0 &&
                        i === 1 &&
                        'ring-[0.15em] ring-white'
                    )}
                    style={cover(item?.poster)}
                  />
                  {look.lines.includes('title') && (
                    <p className="truncate text-[0.75em]">
                      {item?.name || ' '}
                    </p>
                  )}
                  {look.lines.includes('year') && (
                    <p className="text-[0.7em] text-white/60">
                      {item?.year || ' '}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function MockShow({ look, art }: { look: Look; art: Art[] }) {
  const list = look.episodes === 'list';
  const show = art[1];
  return (
    <div className="space-y-[1.2em] p-[1.2em]">
      <div className="flex h-[9em] flex-col justify-end">
        <p className="text-[1.8em] font-bold leading-tight">{show?.name}</p>
        <p className="text-[0.85em] text-white/70">{t`Season 1`}</p>
      </div>
      <div
        className={cn(
          list
            ? 'space-y-[0.6em]'
            : 'flex gap-[0.8em] [&>*]:w-[38%] [&>*]:flex-none'
        )}
      >
        {[1, 2, 3, 4].map((n) => (
          <div key={n} className={cn(list && 'flex items-center gap-[0.8em]')}>
            <div
              className={cn(
                'aspect-video rounded-[0.5em] bg-gray-800 bg-cover bg-center',
                list ? 'w-[9em] flex-none' : 'w-full'
              )}
              style={cover(art[n + 1]?.backdrop)}
            />
            <div className={cn('min-w-0', !list && 'pt-[0.4em]')}>
              <p className="truncate text-[0.85em] font-medium">
                {t`Episode ${n}`}
              </p>
              {list && (
                <span className="mt-[0.4em] block h-[0.7em] w-[80%] rounded-full bg-white/10" />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The bottom bar over the page, on what the background answer says. */
function MockNav({ background }: { background: GlassSurface }) {
  return (
    <div
      className={cn(
        'absolute inset-x-0 bottom-[1em] mx-auto flex w-fit gap-[1.6em] rounded-full border px-[1.6em] py-[0.8em] text-[1.1em] transition-all',
        background === 'solid' && 'border-white/10 bg-gray-900',
        background === 'frosted' &&
          'border-white/15 bg-white/10 backdrop-blur-md',
        background === 'liquid' &&
          'border-white/30 bg-white/5 shadow-[inset_0_1px_0_rgb(255_255_255/0.4),inset_0_-1px_0_rgb(255_255_255/0.15)] backdrop-blur-sm backdrop-saturate-150'
      )}
    >
      <LuHouse />
      <LuCompass className="opacity-60" />
      <LuSearch className="opacity-60" />
      <LuHeart className="opacity-60" />
    </div>
  );
}
