import React from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { toast } from 'sonner';
import { LuCopy, LuDownload, LuMonitor } from 'react-icons/lu';
import { SiAndroid, SiApple, SiInfuse, SiJellyfin } from 'react-icons/si';
import { Button } from '@aiostreams/ui/button';
import { cn } from '@aiostreams/ui/core/styling';
import { copyToClipboard } from '@aiostreams/ui/utils/clipboard';
import { useSession } from '@/lib/jellyfin/session';
import { appBridge } from '@/lib/hosts/shell/bridge';
import { PillTabs } from '@/components/pill-tabs';

/*
 * The welcome step on adding this server elsewhere: pick a device, then an
 * app, then follow its steps, with the address and name to copy in them.
 */

const DESKTOP_DOWNLOAD_URL =
  'https://github.com/Viren070/AIOStreams/releases/tag/desktop';

type Device = 'phone' | 'computer';
type Store = { label: string; icon: React.ReactNode; url: string };

interface App {
  id: string;
  name: string;
  icon: React.ReactNode;
  device: Device;
  blurb: () => string;
  stores: Store[];
  /** What to do once it's installed, given chips of the address and name. */
  steps: (address: React.ReactNode, name: React.ReactNode) => React.ReactNode[];
}

/* eslint-disable lingui/no-unlocalized-strings -- app and store names */
const appStore = (url: string): Store => ({
  label: 'App Store',
  icon: <SiApple />,
  url,
});
const googlePlay = (url: string): Store => ({
  label: 'Google Play',
  icon: <SiAndroid />,
  url,
});

const APPS: App[] = [
  {
    id: 'streamyfin',
    name: 'Streamyfin',
    icon: <span className="font-black">S</span>,
    device: 'phone',
    blurb: () => t`A cleaner Jellyfin app, with downloads.`,
    stores: [
      appStore('https://apps.apple.com/app/streamyfin/id6593660679'),
      googlePlay(
        'https://play.google.com/store/apps/details?id=com.fredrikburmester.streamyfin'
      ),
    ],
    steps: (address, name) => [
      <Trans key="server">
        Open Streamyfin and enter {address} as the server.
      </Trans>,
      <Trans key="sign-in">Sign in as {name} with your password.</Trans>,
    ],
  },
  {
    id: 'infuse',
    name: 'Infuse',
    icon: <SiInfuse />,
    device: 'phone',
    blurb: () => t`Plays almost anything, on iPhone, iPad and Apple TV.`,
    stores: [appStore('https://apps.apple.com/app/infuse-7/id1136220934')],
    steps: (address, name) => [
      <Trans key="share">In Infuse, tap Add Files and pick Jellyfin.</Trans>,
      <Trans key="server">Enter {address} as the address.</Trans>,
      <Trans key="sign-in">
        Sign in as {name} with your password, then save.
      </Trans>,
    ],
  },
  {
    id: 'jellyfin',
    name: 'Jellyfin',
    icon: <SiJellyfin />,
    device: 'phone',
    blurb: () => t`The official Jellyfin app.`,
    stores: [
      appStore('https://apps.apple.com/app/jellyfin-mobile/id1480192618'),
      googlePlay(
        'https://play.google.com/store/apps/details?id=org.jellyfin.mobile'
      ),
    ],
    steps: (address, name) => [
      <Trans key="server">Open Jellyfin and add {address} as a server.</Trans>,
      <Trans key="sign-in">Sign in as {name} with your password.</Trans>,
    ],
  },
  {
    id: 'desktop',
    name: 'AIOStreams',
    icon: <LuMonitor />,
    device: 'computer',
    blurb: () =>
      t`This app with mpv built in, which plays what a browser can't, on Windows, Mac and Linux.`,
    stores: [
      {
        get label() {
          return t`Download`;
        },
        icon: <LuDownload />,
        url: DESKTOP_DOWNLOAD_URL,
      },
    ],
    steps: (address, name) => [
      <Trans key="open">Install it and open it once.</Trans>,
      <Trans key="server">
        Press Add to the app below, or enter {address} in it yourself.
      </Trans>,
      <Trans key="sign-in">Sign in as {name} with your password.</Trans>,
    ],
  },
];
/* eslint-enable lingui/no-unlocalized-strings */

/** Adds the server to the desktop app, which opens these links. */
const desktopLink = (base: string) =>
  `aiostreams://server?url=${encodeURIComponent(base)}`;

function CopyChip({ text }: { text: string }) {
  return (
    <button
      type="button"
      onClick={() =>
        copyToClipboard(text, {
          onSuccess: () => toast.success(t`Copied`),
          onError: () => toast.error(t`Could not copy it`),
        })
      }
      className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-white/10 px-1.5 py-0.5 align-middle font-mono text-[0.8em] hover:bg-white/15"
    >
      <span className="truncate">{text}</span>
      <LuCopy className="flex-none opacity-60" />
    </button>
  );
}

function AppIcon({ app }: { app: App }) {
  return (
    <span className="grid size-9 flex-none place-items-center rounded-xl bg-white/10 text-lg">
      {app.icon}
    </span>
  );
}

function Num({ n }: { n: number }) {
  return (
    <span className="mt-0.5 grid size-6 flex-none place-items-center rounded-full bg-white text-xs font-semibold text-black">
      {n}
    </span>
  );
}

export function AppsGuide() {
  const { client, user } = useSession();
  // Inside the desktop app, it's the phone apps left to add.
  const shell = appBridge();
  const apps = shell ? APPS.filter((a) => a.device === 'phone') : APPS;
  const [device, setDevice] = React.useState<Device>(() =>
    shell || /android|iphone|ipad/i.test(navigator.userAgent)
      ? 'phone'
      : 'computer'
  );
  const shown = apps.filter((a) => a.device === device);
  const [picked, setPicked] = React.useState(shown[0].id);
  const app = shown.find((a) => a.id === picked) ?? shown[0];
  const name = app.name;
  const steps = app.steps(
    <CopyChip text={client.base} />,
    <CopyChip text={user.Name ?? ''} />
  );
  return (
    <div className="space-y-5">
      {!shell && (
        <PillTabs
          name="welcome-apps-device"
          options={[
            { value: 'phone' as const, label: t`Phone or tablet` },
            { value: 'computer' as const, label: t`Computer` },
          ]}
          value={device}
          onChange={setDevice}
        />
      )}
      {shown.length > 1 && (
        <div className="grid grid-cols-3 gap-2">
          {shown.map((a) => (
            <button
              key={a.id}
              type="button"
              aria-pressed={a.id === app.id}
              onClick={() => setPicked(a.id)}
              className={cn(
                'flex flex-col items-center gap-2 rounded-xl border p-3 text-sm transition-colors',
                a.id === app.id
                  ? 'border-white bg-white/10'
                  : 'border-white/10 hover:border-white/30'
              )}
            >
              <AppIcon app={a} />
              {a.name}
            </button>
          ))}
        </div>
      )}
      <div className="space-y-4 rounded-xl bg-white/5 p-4">
        <p className="text-sm text-[--muted]">{app.blurb()}</p>
        <ol className="space-y-3 text-sm">
          <li className="flex gap-3">
            <Num n={1} />
            <div className="min-w-0 flex-1 space-y-2">
              <p>
                <Trans>Get {name}.</Trans>
              </p>
              <div className="flex flex-wrap gap-2">
                {app.stores.map((s) => (
                  <Button
                    key={s.url}
                    size="sm"
                    intent="gray-outline"
                    className="rounded-full"
                    leftIcon={s.icon}
                    onClick={() => window.open(s.url, '_blank', 'noopener')}
                  >
                    {s.label}
                  </Button>
                ))}
                {app.device === 'computer' && (
                  <Button
                    size="sm"
                    intent="white"
                    className="rounded-full"
                    onClick={() =>
                      (window.location.href = desktopLink(client.base))
                    }
                  >
                    <Trans>Add to the app</Trans>
                  </Button>
                )}
              </div>
            </div>
          </li>
          {steps.map((step, i) => (
            <li key={i} className="flex gap-3">
              <Num n={i + 2} />
              <p className="min-w-0 flex-1 leading-7">{step}</p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
