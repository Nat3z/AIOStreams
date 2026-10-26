import React from 'react';
import { t } from '@lingui/core/macro';
import { LuAudioLines, LuCheck, LuPlay, LuSkipForward } from 'react-icons/lu';
import { Button } from '@aiostreams/ui/button';
import { cn } from '@aiostreams/ui/core/styling';
import {
  audioLanguages,
  subtitleLanguages,
  usePlaybackPrefs,
  ORIGINAL_LANGUAGE,
  type PlaybackPrefs,
  type SubtitleMode,
} from '@/lib/jellyfin/user-config';
import {
  settings,
  useSetting,
  SUBTITLE_SIZES,
  type SegmentAction,
  type SubtitleSize,
  type SubtitleStyle,
} from '@/lib/settings';
import { subtitleCss, subtitleSizeLabel } from '@/lib/subtitles/style';
import { LANGUAGES, languageName } from '@/lib/languages';
import { formatLocale } from '@/lib/i18n';
import { Pills } from './_components/common';
import { Example, cover, useArt } from './example';
import { TRACKERS, useTrackerAccounts } from './profile';

/*
 * The example Playback, Audio and Subtitles open on: a still from a show with
 * what the player would draw over it, turned to the moment the question being
 * answered changes.
 */

type Scene = 'talk' | 'intro' | 'end';

interface Option {
  value: string;
  label: string;
}

/** What the player draws from. */
interface View {
  audio: string;
  /** The language subtitles show in. */
  reads: string;
  mode: SubtitleMode;
  skips: SegmentAction | 'mixed';
  autoplay: boolean;
  size: SubtitleSize;
  style: SubtitleStyle;
}

interface Question {
  id: string;
  scene: Scene;
  title: string;
  value: string;
  options: Option[];
  pick: (v: string) => void;
  peek: (v: string) => Partial<View>;
}

const COMMON_LANGUAGES = ['eng', 'spa', 'fre', 'ger', 'ita', 'jpn', 'por'];
/** The language the example's show is made in. */
const SHOW_LANGUAGE = 'kor';

const nameOf = (code: string): string => {
  if (code === ORIGINAL_LANGUAGE) return t`Original`;
  const l = LANGUAGES.find((x) => x.code === code);
  return l ? languageName(l) : code;
};

const languageOptions = (current: string): Option[] =>
  [...new Set([...COMMON_LANGUAGES, ...(current ? [current] : [])])].map(
    (code) => ({ value: code, label: nameOf(code) })
  );

/** `code` first, the rest of the list kept after it. */
const first = (code: string, list: string[]) => [
  code,
  ...list.filter((c) => c !== code),
];

const modeLabel = (mode: SubtitleMode): string =>
  ({
    Smart: t`When I don't understand`,
    Always: t`Always`,
    None: t`Never`,
    Default: t`As the version marks them`,
    OnlyForced: t`Only forced`,
  })[mode];

function useView() {
  const { prefs, update } = usePlaybackPrefs();
  const [segments, setSegments] = useSetting(settings.playback.segmentActions);
  const [size, setSize] = useSetting(settings.subtitle.size);
  const [style] = useSetting(settings.subtitle.style);
  const audios = audioLanguages(prefs);
  const subtitles = subtitleLanguages(prefs);
  const audio = audios[0] ?? ORIGINAL_LANGUAGE;
  // Subtitles show in the first subtitle language, else the first spoken one.
  const reads =
    subtitles[0] ??
    audios.find((c) => c !== ORIGINAL_LANGUAGE) ??
    COMMON_LANGUAGES[0];
  const view: View = {
    audio,
    reads,
    mode: prefs.SubtitleMode ?? 'Default',
    skips:
      segments.Intro === segments.Recap && segments.Recap === segments.Outro
        ? segments.Intro
        : 'mixed',
    autoplay: prefs.EnableNextEpisodeAutoPlay !== false,
    size,
    style,
  };
  // A server without the lists keeps only the first language.
  const lists = (key: 'AudioLanguages' | 'SubtitleLanguages') =>
    Array.isArray(prefs[key]);
  const audioPatch = (code: string): PlaybackPrefs => ({
    AudioLanguagePreference: code,
    ...(lists('AudioLanguages') && { AudioLanguages: first(code, audios) }),
  });
  const subtitlePatch = (code: string): PlaybackPrefs => ({
    SubtitleLanguagePreference: code,
    ...(lists('SubtitleLanguages') && {
      SubtitleLanguages: first(code, subtitles),
    }),
  });
  return {
    view,
    setAudio: (code: string) => update(audioPatch(code)),
    // Subtitles turned on need a language to show in.
    setMode: (mode: SubtitleMode) =>
      update({
        SubtitleMode: mode,
        ...(mode !== 'None' && !subtitles.length && subtitlePatch(reads)),
      }),
    setSkips: (action: SegmentAction) =>
      setSegments({ ...segments, Intro: action, Recap: action, Outro: action }),
    setAutoplay: (on: boolean) => update({ EnableNextEpisodeAutoPlay: on }),
    setSize,
  };
}

const heardIn = (v: View): string =>
  v.audio === ORIGINAL_LANGUAGE ? SHOW_LANGUAGE : v.audio;

const showsSubtitles = (v: View): boolean =>
  v.mode === 'Always' ||
  v.mode === 'Default' ||
  (v.mode === 'Smart' && heardIn(v) !== v.reads);

function questions(
  ids: string[],
  v: View,
  set: ReturnType<typeof useView>
): Question[] {
  const modes: SubtitleMode[] = ['Smart', 'Always', 'None'];
  const all: Question[] = [
    {
      id: 'audio',
      scene: 'talk',
      title: t`What language do you watch in?`,
      value: v.audio,
      options: [
        { value: ORIGINAL_LANGUAGE, label: t`Original` },
        ...languageOptions(v.audio === ORIGINAL_LANGUAGE ? '' : v.audio),
      ],
      pick: set.setAudio,
      peek: (audio) => ({ audio }),
    },
    {
      id: 'subtitles',
      scene: 'talk',
      title: t`When should subtitles show?`,
      value: v.mode,
      // The other modes are kept to the full settings, unless one is on.
      options: (modes.includes(v.mode) ? modes : [...modes, v.mode]).map(
        (mode) => ({ value: mode, label: modeLabel(mode) })
      ),
      pick: (mode) => set.setMode(mode as SubtitleMode),
      peek: (mode) => ({ mode: mode as SubtitleMode }),
    },
    {
      id: 'size',
      scene: 'talk',
      title: t`How big?`,
      value: v.size,
      options: SUBTITLE_SIZES.map((s) => ({
        value: s,
        label: subtitleSizeLabel(s),
      })),
      pick: (size) => set.setSize(size as SubtitleSize),
      peek: (size) => ({ size: size as SubtitleSize }),
    },
    {
      id: 'skips',
      scene: 'intro',
      title: t`Intros, recaps and credits?`,
      value: v.skips,
      options: [
        { value: 'skip', label: t`Skip them` },
        { value: 'ask', label: t`Ask me` },
        { value: 'none', label: t`Leave them` },
      ],
      pick: (a) => set.setSkips(a as SegmentAction),
      peek: (a) => ({ skips: a as SegmentAction }),
    },
    {
      id: 'next',
      scene: 'end',
      title: t`When an episode ends?`,
      value: v.autoplay ? 'on' : 'off',
      options: [
        { value: 'on', label: t`Play the next one` },
        { value: 'off', label: t`Stop and wait` },
      ],
      pick: (on) => set.setAutoplay(on === 'on'),
      peek: (on) => ({ autoplay: on === 'on' }),
    },
  ];
  // Subtitles that never show have no size to pick.
  return all.filter(
    (q) => ids.includes(q.id) && !(q.id === 'size' && v.mode === 'None')
  );
}

function explain(v: View, scene: Scene, marked: string): string {
  if (scene === 'talk') {
    const heard = nameOf(heardIn(v));
    const reads = nameOf(v.reads);
    if (showsSubtitles(v))
      return t`You hear ${heard}, with ${reads} subtitles.`;
    return v.mode === 'None'
      ? t`You hear ${heard}. Subtitles stay off.`
      : t`You hear ${heard}, so subtitles stay out of the way.`;
  }
  if (scene === 'intro')
    return v.skips === 'skip'
      ? t`The intro is skipped before you see it.`
      : v.skips === 'ask'
        ? t`A button lets you skip the intro.`
        : v.skips === 'none'
          ? t`The intro plays like any other part.`
          : t`Intros, recaps and credits are each set their own way below.`;
  const next = v.autoplay
    ? t`The next episode starts after a countdown you can cancel.`
    : t`It stops, and you choose what's next.`;
  return marked ? `${next} ${t`It's marked watched on ${marked}.`}` : next;
}

/** The example for a section's questions, tracking among them if asked. */
export function PlayerExample({
  ids,
  tracking = false,
}: {
  ids: string[];
  tracking?: boolean;
}) {
  const set = useView();
  const art = useArt();
  const accounts = useTrackerAccounts();
  const [peek, setPeek] = React.useState<Partial<View> | null>(null);
  // A tracker being pointed at, drawn as if it were connected.
  const [trying, setTrying] = React.useState<string | null>(null);
  const view: View = { ...set.view, ...peek };
  const qs = questions(ids, set.view, set);
  const [scene, setScene] = React.useState<Scene>(qs[0]?.scene ?? 'talk');
  const connected = TRACKERS.filter((tr) => accounts.data?.accounts[tr.id]).map(
    (tr) => tr.name
  );
  const marked =
    trying ??
    (connected.length
      ? new Intl.ListFormat(formatLocale(), { type: 'conjunction' }).format(
          connected
        )
      : '');
  const tracks = tracking && !!accounts.data?.available;

  return (
    <Example
      frame={
        <PlayerFrame
          v={view}
          scene={scene}
          marked={marked}
          backdrop={art[{ talk: 0, intro: 1, end: 2 }[scene]]?.backdrop}
        />
      }
      note={explain(view, scene, marked)}
      peeking={peek !== null || trying !== null}
      questions={[
        ...qs.map((q) => ({
          id: q.id,
          title: q.title,
          onAt: () => setScene(q.scene),
          body: (
            <Pills
              stacked
              label={q.title}
              options={q.options}
              isOn={(v) => v === q.value}
              onPick={q.pick}
              onPeek={(v) => setPeek(v === null ? null : q.peek(v))}
            />
          ),
        })),
        ...(tracks
          ? [
              {
                id: 'tracking',
                title: t`Mark it watched on`,
                onAt: () => setScene('end'),
                body: <TrackerChoices onTrying={setTrying} />,
              },
            ]
          : []),
      ]}
    />
  );
}

/** Trackers as answers: pointing at one shows it marking the episode. */
function TrackerChoices({
  onTrying,
}: {
  onTrying: (name: string | null) => void;
}) {
  const { data, waiting, signIn, disconnect } = useTrackerAccounts();
  if (!data) return null;
  return (
    <div className="grid gap-2" onMouseLeave={() => onTrying(null)}>
      {TRACKERS.map(({ id, name, icon: Icon }) => {
        const account = data.accounts[id];
        const point = () => onTrying(account ? null : name);
        return (
          <div
            key={id}
            onMouseEnter={point}
            onFocusCapture={point}
            onBlurCapture={() => onTrying(null)}
            className={cn(
              'flex items-center gap-3 rounded-full border py-1.5 pe-1.5 ps-4 text-sm',
              account ? 'border-[--brand] bg-brand-500/15' : 'border-white/15'
            )}
          >
            <Icon className="flex-none" />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{name}</span>
              {account && (
                <span className="ms-2 text-[--muted]">{account}</span>
              )}
            </span>
            {account ? (
              <Button
                size="sm"
                intent="gray-subtle"
                className="rounded-full"
                loading={disconnect.isPending && disconnect.variables === id}
                onClick={() => disconnect.mutate(id)}
              >
                {t`Disconnect`}
              </Button>
            ) : (
              <Button
                size="sm"
                intent="primary-subtle"
                className="rounded-full"
                disabled={data.shared}
                loading={waiting === id}
                onClick={() => signIn(id)}
              >
                {t`Connect`}
              </Button>
            )}
          </div>
        );
      })}
      {data.shared && (
        <p className="text-xs text-[--muted]">
          {t`You share the main history, so it's marked on its accounts.`}
        </p>
      )}
    </div>
  );
}

const OVERLAY = 'duration-300 animate-in fade-in-0 motion-reduce:animate-none';
const CHIP =
  'absolute flex w-fit items-center gap-[0.4em] rounded-full bg-black/70 px-[0.8em] py-[0.3em] text-[0.8em] backdrop-blur';

/** A still with what the player would draw over it, sized in em so it reads the same at any width. */
function PlayerFrame({
  v,
  scene,
  marked,
  backdrop,
}: {
  v: View;
  scene: Scene;
  marked: string;
  backdrop?: string | null;
}) {
  return (
    <div
      aria-hidden
      className="relative aspect-video overflow-hidden rounded-2xl bg-gradient-to-br from-gray-700 to-gray-950 bg-cover bg-center ring-1 ring-white/10 [container-type:inline-size]"
      style={cover(backdrop)}
    >
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-black/40" />
      <div
        className="absolute inset-0"
        style={{ fontSize: 'min(2.6cqw, 15px)' }}
      >
        <span className={cn(CHIP, 'start-[0.8em] top-[0.8em]')}>
          <LuAudioLines /> {nameOf(heardIn(v))}
        </span>
        {scene === 'talk' && showsSubtitles(v) && (
          <span className="absolute inset-x-0 bottom-[2.2em] text-center text-[1.15em]">
            <span
              className="rounded px-[0.3em]"
              style={subtitleCss({ ...v.style, size: v.size })}
            >
              {t`I didn't think you'd come back.`}
            </span>
          </span>
        )}
        {scene === 'intro' && v.skips === 'ask' && (
          <span
            className={cn(
              'absolute bottom-[2.6em] end-[0.8em] rounded-[0.5em] border border-white/20 bg-black/70 px-[0.9em] py-[0.45em] text-[0.9em] font-medium backdrop-blur',
              OVERLAY
            )}
          >
            {t`Skip intro`}
          </span>
        )}
        {scene === 'intro' && v.skips === 'skip' && (
          <span className={cn(CHIP, 'inset-x-0 top-[0.8em] mx-auto', OVERLAY)}>
            <LuSkipForward /> {t`Skipped the intro`}
          </span>
        )}
        {scene === 'end' && marked && (
          <span className={cn(CHIP, 'inset-x-0 top-[0.8em] mx-auto', OVERLAY)}>
            <LuCheck className="text-[--brand]" />{' '}
            {t`Marked watched on ${marked}`}
          </span>
        )}
        {scene === 'end' && (
          <div
            className={cn(
              'absolute bottom-[2.6em] end-[0.8em] w-[13em] space-y-[0.5em] rounded-[0.8em] border border-white/15 bg-black/75 p-[0.8em] text-[0.8em] backdrop-blur',
              OVERLAY
            )}
          >
            <p className="text-[--muted]">{t`Next episode`}</p>
            {v.autoplay ? (
              <p className="flex items-center gap-[0.5em]">
                <span className="relative h-[0.3em] flex-1 overflow-hidden rounded-full bg-white/20">
                  <span className="absolute inset-y-0 start-0 w-2/3 bg-[--brand]" />
                </span>
                {t`8s`}
              </p>
            ) : (
              <span className="flex items-center justify-center gap-[0.3em] rounded-[0.4em] bg-white px-[0.5em] py-[0.25em] font-medium text-black">
                <LuPlay /> {t`Play`}
              </span>
            )}
          </div>
        )}
        <span className="absolute inset-x-[0.8em] bottom-[0.8em] h-[0.3em] overflow-hidden rounded-full bg-white/20">
          <span
            className="absolute inset-y-0 start-0 bg-[--brand] transition-all duration-500"
            style={{ width: { talk: '42%', intro: '4%', end: '97%' }[scene] }}
          />
        </span>
      </div>
    </div>
  );
}
