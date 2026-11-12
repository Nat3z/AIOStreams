import { t } from '@lingui/core/macro';
import { Select } from '@aiostreams/ui/select';
import { dateFormat } from '@/lib/format';
import { currentHost } from '@/lib/hosts';
import { HIDDEN_LOCALES, LOCALES, localeName, systemLocale } from '@/lib/i18n';
import { canRefract } from '@/components/shell/glass-surface';
import {
  settings,
  useSetting,
  type GlassSurface,
  type DesktopNavigation,
  type RailNames,
  type RailShape,
  type StartPage,
  type TabNames,
  type TimeFormat,
  type TopBar,
  type TouchNavigation,
  type TvNavigation,
} from '@/lib/settings';
import {
  Answer,
  AnswerGroup,
  Pills,
} from './_components/common';
import { startPages } from '@/lib/start-page';

/* What follows the user comes first, then what's kept on this device. */

function startPageName(page: StartPage): string {
  switch (page) {
    case 'home':
      return t`Home`;
    case 'discover':
      return t`Discover`;
    case 'live':
      return t`Live TV`;
    case 'favourites':
      return t`Favourites`;
    case 'calendar':
      return t`Calendar`;
    case 'activity':
      return t`Activity`;
    case 'downloads':
      return t`Downloads`;
  }
}

export function InterfaceSection() {
  return (
    <div className="space-y-12">
      <Language />
      <Navigation />
    </div>
  );
}

/** Half past seven in the evening, as `cycle` writes it. */
function sampleTime(cycle: 'h12' | 'h23'): string {
  const at = new Date();
  at.setHours(19, 30, 0, 0);
  return dateFormat({
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: cycle,
  }).format(at);
}

/** The app's language and clock. */
function Language() {
  const [language, setLanguage] = useSetting(settings.interface.language);
  const [timeFormat, setTimeFormat] = useSetting(settings.interface.timeFormat);
  const twelve = sampleTime('h12');
  const twentyFour = sampleTime('h23');
  const listed = LOCALES.filter(
    (l) => !HIDDEN_LOCALES.includes(l) || import.meta.env.DEV || l === language
  )
    .map((l) => ({ value: l, label: localeName(l) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const system = localeName(systemLocale());

  return (
    <AnswerGroup name="language" title={t`Language`} holds="profile">
      <Answer
        label={t`Language`}
        help={t`Titles, synopses and version names stay in the language the server sends.`}
      >
        <div className="max-w-md">
          <Select
            aria-label={t`App language`}
            options={[
              { value: 'auto', label: t`System (${system})` },
              ...listed,
            ]}
            value={LOCALES.includes(language) ? language : 'auto'}
            onValueChange={setLanguage}
          />
        </div>
      </Answer>
      <Answer
        label={t`Time format`}
        help={t`For clocks and times of day, such as the player's clock and the TV guide.`}
      >
        <Pills
          label={t`Time format`}
          options={[
            { value: 'auto', label: t`Automatic` },
            { value: '12', label: t`12-hour (${twelve})` },
            { value: '24', label: t`24-hour (${twentyFour})` },
          ]}
          isOn={(v) => v === timeFormat}
          onPick={(v) => setTimeFormat(v as TimeFormat)}
        />
      </Answer>
    </AnswerGroup>
  );
}

export const backgroundOptions = () => [
  { value: 'solid', label: t`Solid` },
  { value: 'frosted', label: t`Frosted glass` },
  ...(canRefract ? [{ value: 'liquid', label: t`Liquid glass` }] : []),
];

/** Glass that can't bend falls back to frosted. */
export const shownBackground = (background: GlassSurface): GlassSurface =>
  background === 'liquid' && !canRefract ? 'frosted' : background;

/** Where the navigation goes and how it looks, with only what this device shows. */
function Navigation() {
  const tv = !!currentHost().tv;
  const touch = matchMedia('(pointer: coarse)').matches;
  const [touchNavigation, setTouchNavigation] = useSetting(
    settings.interface.touchNavigation
  );
  const [tvNavigation, setTvNavigation] = useSetting(
    settings.interface.tvNavigation
  );
  const [desktopNavigation, setDesktopNavigation] = useSetting(
    settings.interface.desktopNavigation
  );
  const [topBar, setTopBar] = useSetting(settings.interface.topBar);
  const [tabNames, setTabNames] = useSetting(settings.interface.tabNames);
  const [railShape, setRailShape] = useSetting(settings.interface.railShape);
  const [railNames, setRailNames] = useSetting(settings.interface.railNames);
  const [background, setBackground] = useSetting(settings.theme.glassSurface);
  const [startPage, setStartPage] = useSetting(settings.interface.startPage);
  const rail = tv
    ? tvNavigation === 'rail'
    : touch && touchNavigation === 'rail';
  const topTabs =
    (tv ? tvNavigation : touch ? touchNavigation : desktopNavigation) === 'top';
  // A TV's docked rail and fade sit on nothing.
  const onBar = !tv || (rail ? railShape !== 'docked' : topBar !== 'fade');
  const shown = shownBackground(background);

  return (
    <AnswerGroup
      name="navigation"
      title={t`Navigation`}
      holds="device"
    >
      <Answer
        label={t`Start on`}
        help={t`The page the app opens on. A link still opens what it points to.`}
      >
        <div className="max-w-md">
          <Select
            aria-label={t`Start on`}
            options={startPages().map((page) => ({
              value: page,
              label: startPageName(page),
            }))}
            value={startPage}
            onValueChange={(value) => setStartPage(value as StartPage)}
          />
        </div>
      </Answer>
      {tv && (
        <Answer label={t`Navigation`}>
          <Pills
            label={t`Navigation`}
            options={[
              { value: 'rail', label: t`Side rail` },
              { value: 'top', label: t`Top tabs` },
            ]}
            isOn={(v) => v === tvNavigation}
            onPick={(v) => setTvNavigation(v as TvNavigation)}
          />
        </Answer>
      )}
      {!tv && touch && (
        <Answer
          label={t`Wide screens`}
          help={t`Where the navigation goes when there's room for a sidebar, such as a tablet held sideways.`}
        >
          <Pills
            label={t`Wide screens`}
            options={[
              { value: 'rail', label: t`Side rail` },
              { value: 'bar', label: t`Bottom bar` },
              { value: 'top', label: t`Top tabs` },
            ]}
            isOn={(v) => v === touchNavigation}
            onPick={(v) => setTouchNavigation(v as TouchNavigation)}
          />
        </Answer>
      )}
      {!tv && !touch && (
        <Answer
          label={t`Wide screens`}
          help={t`Where the navigation goes when the window is wide enough for a sidebar.`}
        >
          <Pills
            label={t`Wide screens`}
            options={[
              { value: 'sidebar', label: t`Sidebar` },
              { value: 'top', label: t`Top tabs` },
            ]}
            isOn={(v) => v === desktopNavigation}
            onPick={(v) => setDesktopNavigation(v as DesktopNavigation)}
          />
        </Answer>
      )}
      {rail && (
        <Answer
          label={t`Rail`}
          help={
            railShape === 'docked'
              ? t`In a column of its own.`
              : railShape === 'floating'
                ? t`Hovering over the page, a little in from the edge.`
                : t`Just the current page's button in the top corner, which opens into the whole menu.`
          }
        >
          <Pills
            label={t`Rail`}
            options={[
              { value: 'docked', label: t`Docked` },
              { value: 'floating', label: t`Floating` },
              { value: 'corner', label: t`Corner button` },
            ]}
            isOn={(v) => v === railShape}
            onPick={(v) => setRailShape(v as RailShape)}
          />
        </Answer>
      )}
      {rail && railShape !== 'corner' && (
        <Answer label={t`Page names`}>
          <Pills
            label={t`Page names`}
            options={
              tv
                ? [
                    { value: 'auto', label: t`While you're in it` },
                    { value: 'always', label: t`Always` },
                  ]
                : [
                    { value: 'auto', label: t`Shown` },
                    { value: 'never', label: t`Hidden` },
                  ]
            }
            isOn={(v) => v === railNames}
            onPick={(v) => setRailNames(v as RailNames)}
          />
        </Answer>
      )}
      {topTabs && (
        <Answer label={t`Top bar`}>
          <Pills
            label={t`Top bar`}
            options={[
              { value: 'pill', label: t`Floating pills` },
              { value: 'bar', label: t`Bar` },
              { value: 'fade', label: t`Fade` },
            ]}
            isOn={(v) => v === topBar}
            onPick={(v) => setTopBar(v as TopBar)}
          />
        </Answer>
      )}
      {/* Narrow screens other than a TV always have the bottom bar. */}
      {(!tv || topTabs) && (
        <Answer
          label={t`Tab names`}
          help={
            tv
              ? t`Whether the tabs name each page beside its icon.`
              : t`Whether the bar at the bottom, and tabs along the top, name each page.`
          }
        >
          <Pills
            label={t`Tab names`}
            options={[
              { value: 'shown', label: t`Shown` },
              { value: 'hidden', label: t`Hidden` },
            ]}
            isOn={(v) => v === tabNames}
            onPick={(v) => setTabNames(v as TabNames)}
          />
        </Answer>
      )}
      {onBar && (
        <Answer
          label={t`Navigation background`}
          help={
            shown === 'liquid'
              ? t`Glass that also bends what's behind its edges, which costs more on a slow device.`
              : shown === 'frosted'
                ? t`Glass that shows the page through it.`
                : t`The app's own colour.`
          }
        >
          <Pills
            label={t`Navigation background`}
            options={backgroundOptions()}
            isOn={(v) => v === shown}
            onPick={(v) => setBackground(v as GlassSurface)}
          />
        </Answer>
      )}
    </AnswerGroup>
  );
}
