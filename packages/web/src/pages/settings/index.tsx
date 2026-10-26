import React from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useReducedMotion } from 'motion/react';
import type { IconType } from 'react-icons';
import {
  LuAppWindow,
  LuCaptions,
  LuCirclePlay,
  LuDatabase,
  LuDownload,
  LuHeart,
  LuInfo,
  LuKeyboard,
  LuLayoutGrid,
  LuMonitor,
  LuSmartphone,
  LuPalette,
  LuTv,
  LuUser,
  LuUserPen,
  LuVolume2,
} from 'react-icons/lu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@aiostreams/ui/tabs';
import { Button } from '@aiostreams/ui/button';
import { cn } from '@aiostreams/ui/core/styling';
import { DonationModal } from '@aiostreams/ui/shared/donation-modal';
import { useDisclosure } from '@aiostreams/ui/hooks/disclosure';
import { currentHost } from '../../lib/hosts';
import { useFeature } from '../../lib/server-info';
import { shellHost } from '../../lib/hosts/shell';
import { appBridge } from '../../lib/hosts/shell/bridge';
import { PageBody } from '../../components/layout';
import { ShortcutSettings } from '../../components/shortcut-settings';
import { SettingsPageHeader } from '../../components/settings-card';
import { PlaybackSection } from './playback';
import { AudioSection } from './audio';
import { SubtitlesSection } from './subtitles';
import { InterfaceExample, InterfaceSection } from './interface';
import { ThemeSection } from './theme';
import { CacheSection } from './cache';
import { DownloadsSection } from './downloads';
import { AccountSection } from './account';
import { ProfileSection } from './profile';
import { AppSection, DesktopSection, AndroidSection } from './apps';
import { AboutSection } from './about';
import { PlayerExample } from './player-example';

interface Section {
  id: string;
  label: string;
  description: string;
  icon: IconType;
  group: 'watching' | 'app';
  /** Quick answers beside a mock of what they change, above the rest. */
  Example?: React.ComponentType;
  Content: React.ComponentType;
}

/* Tracking is asked where it happens, at the end of an episode. */
const PlaybackExample = () => (
  <PlayerExample ids={['skips', 'next']} tracking />
);
const AudioExample = () => <PlayerExample ids={['audio']} />;
const SubtitlesExample = () => <PlayerExample ids={['subtitles', 'size']} />;

const groupLabel = (group: Section['group']) =>
  group === 'watching' ? t`Watching` : t`App`;

function sections(profile: boolean): Section[] {
  const host = currentHost();
  return [
    ...(profile
      ? [
          {
            id: 'profile',
            label: t`Profile`,
            description: t`You, tracking, your streams and Stremio`,
            icon: LuUserPen,
            group: 'watching' as const,
            Content: ProfileSection,
          },
        ]
      : []),
    {
      id: 'playback',
      label: t`Playback`,
      description: t`Next episode, controls and players`,
      icon: LuCirclePlay,
      group: 'watching' as const,
      Example: PlaybackExample,
      Content: PlaybackSection,
    },
    {
      id: 'audio',
      label: t`Audio`,
      description: shellHost() ? t`Language and output` : t`Language`,
      icon: LuVolume2,
      group: 'watching' as const,
      Example: AudioExample,
      Content: AudioSection,
    },
    {
      id: 'subtitles',
      label: t`Subtitles`,
      description: t`Language and how subtitles look`,
      icon: LuCaptions,
      group: 'watching' as const,
      Example: SubtitlesExample,
      Content: SubtitlesSection,
    },
    {
      id: 'interface',
      label: t`Interface`,
      description: t`Language, home, grids and episodes`,
      icon: LuLayoutGrid,
      group: 'app' as const,
      Example: InterfaceExample,
      Content: InterfaceSection,
    },
    // A touch screen has no keys to set, and a remote too few to move around.
    ...(host.tv || matchMedia('(pointer: coarse)').matches
      ? []
      : [
          {
            id: 'shortcuts',
            label: t`Shortcuts`,
            description: t`Keys, remotes and gamepads`,
            icon: LuKeyboard,
            group: 'app' as const,
            Content: ShortcutSettings,
          },
        ]),
    {
      id: 'theme',
      label: t`Theme`,
      description: t`Colours and custom CSS`,
      icon: LuPalette,
      group: 'app' as const,
      Content: ThemeSection,
    },
    ...(host.downloads
      ? [
          {
            id: 'downloads',
            label: t`Downloads`,
            description: t`Where they go and how many run at once`,
            icon: LuDownload,
            group: 'app' as const,
            Content: DownloadsSection,
          },
        ]
      : []),
    {
      id: 'cache',
      label: t`Cache`,
      description: t`Pages and artwork saved on this device`,
      icon: LuDatabase,
      group: 'app' as const,
      Content: CacheSection,
    },
    {
      id: 'account',
      label: t`Account`,
      description: t`Who you are signed in as`,
      icon: LuUser,
      group: 'app' as const,
      Content: AccountSection,
    },
    ...(host.name === 'desktop'
      ? [
          {
            id: 'desktop',
            label: t`Desktop app`,
            description: t`Updates, Discord, mpv and troubleshooting`,
            icon: LuMonitor,
            group: 'app' as const,
            Content: DesktopSection,
          },
        ]
      : []),
    ...(host.name === 'android-app'
      ? [
          {
            id: 'android',
            label: t`Android app`,
            description:
              appBridge()?.pip === false
                ? t`Updates, mpv and troubleshooting`
                : t`Updates, picture-in-picture, mpv and troubleshooting`,
            icon: host.tv ? LuTv : LuSmartphone,
            group: 'app' as const,
            Content: AndroidSection,
          },
        ]
      : []),
    ...(host.settings
      ? [
          {
            id: 'app',
            label: host.settings.label,
            description: host.settings.description,
            icon: LuAppWindow,
            group: 'app' as const,
            Content: AppSection,
          },
        ]
      : []),
    {
      id: 'about',
      label: t`About`,
      description: t`Versions and links`,
      icon: LuInfo,
      group: 'app' as const,
      Content: AboutSection,
    },
  ];
}

const TAB_REST_MS = 350;

export function SettingsPage({
  tab,
  onTabChange,
}: {
  tab: string;
  onTabChange(tab: string): void;
}) {
  const profile = useFeature('profile');
  const all = React.useMemo(() => sections(profile), [profile]);
  const donation = useDisclosure(false);
  // With no marker sliding, the tabs keep the usual focus mark.
  const still = useReducedMotion();
  const active = all.find((s) => s.id === tab) ?? all[0];
  // Passing through tabs would build every section on the way.
  const [focused, setFocused] = React.useState<string | null>(null);
  const resting = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(resting.current), []);
  const groups = new Map<Section['group'], Section[]>();
  for (const s of all) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);

  return (
    <PageBody>
      <Tabs
        value={active.id}
        onValueChange={onTabChange}
        activationMode="manual"
        marked={focused ?? undefined}
        variant="pill"
        className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-8 lg:grid-cols-[200px,minmax(0,1fr)]"
        triggerClass={cn(
          'h-9 w-fit flex-none rounded-lg border-0 px-3 text-sm lg:w-full lg:justify-start',
          'data-[state=active]:bg-[--subtle] data-[state=active]:text-white dark:hover:text-white',
          'transition duration-200 hover:bg-[--subtle]/50 focus-visible:ring-0 focus-visible:ring-offset-0',
          'motion-reduce:[[data-tv]_&]:focus-visible:bg-white/20'
        )}
        // The sliding marker carries the focus mark, so the two move together.
        indicatorClass="group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-[--ring] [[data-tv]_&]:group-focus-visible:bg-white/20 [[data-tv]_&]:group-focus-visible:outline-none [html[data-pointer-focus]_&]:!outline-none"
        listClass="h-fit w-full justify-start"
      >
        <div
          data-sticky
          className="min-w-0 space-y-4 lg:sticky lg:top-6 lg:h-fit"
        >
          <h1 data-ui="page-title" className="text-3xl font-bold">
            <Trans>Settings</Trans>
          </h1>
          <TabsList
            data-ui="settings-tabs"
            data-nav-enter="[role=tab][data-state=active]"
            // A row that scrolls on narrow screens, a column beside the section on wide ones.
            className="-mx-4 w-[calc(100%+2rem)] gap-1 overflow-x-auto px-4 [scrollbar-width:none] lg:mx-0 lg:block lg:w-full lg:space-y-4 lg:overflow-visible lg:px-0"
          >
            {[...groups.entries()].map(([group, items]) => (
              <div
                key={group}
                data-ui="settings-tab-group"
                data-name={group.toLowerCase()}
                className="contents lg:block lg:space-y-0.5"
              >
                <p className="hidden px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[--muted] lg:block">
                  {groupLabel(group)}
                </p>
                {items.map((s) => (
                  <TabsTrigger
                    key={s.id}
                    value={s.id}
                    data-ui="settings-tab"
                    data-name={s.id}
                    data-focus={still && !currentHost().tv ? undefined : 'own'}
                    className="group"
                    onFocus={() => {
                      setFocused(s.id);
                      clearTimeout(resting.current);
                      resting.current = setTimeout(
                        () => onTabChange(s.id),
                        TAB_REST_MS
                      );
                    }}
                    onBlur={() => {
                      setFocused(null);
                      clearTimeout(resting.current);
                    }}
                  >
                    <s.icon className="me-2 text-base transition-transform duration-200 group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5" />
                    {s.label}
                  </TabsTrigger>
                ))}
              </div>
            ))}
            <div className="flex flex-none items-center lg:pt-2">
              <Button
                data-ui="settings-donate"
                size="sm"
                intent="gray-outline"
                className="rounded-full"
                leftIcon={<LuHeart />}
                onClick={donation.open}
              >
                <Trans>Donate</Trans>
              </Button>
            </div>
          </TabsList>
        </div>
        <div className="min-w-0">
          {all.map((s) => (
            <TabsContent
              key={s.id}
              value={s.id}
              tabIndex={-1}
              data-ui="settings-panel"
              data-name={s.id}
              className="space-y-8 duration-300 animate-in fade-in-0 slide-in-from-bottom-2"
            >
              {s.id === active.id && (
                <>
                  <SettingsPageHeader
                    title={s.label}
                    description={s.description}
                  />
                  {s.Example && <s.Example />}
                  <s.Content />
                </>
              )}
            </TabsContent>
          ))}
        </div>
      </Tabs>
      <DonationModal open={donation.isOpen} onOpenChange={donation.toggle} />
    </PageBody>
  );
}
