/* eslint-disable lingui/no-unlocalized-strings -- PROTOTYPE */
import React from 'react';
import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import {
  LuCheck,
  LuCopy,
  LuDownload,
  LuMonitor,
  LuSmartphone,
} from 'react-icons/lu';
import { SiApple, SiAndroid, SiInfuse, SiJellyfin } from 'react-icons/si';
import { Button } from '@aiostreams/ui/button';
import { cn } from '@aiostreams/ui/core/styling';
import { copyToClipboard } from '@aiostreams/ui/utils/clipboard';
import { useSession } from '../lib/session';
import { PillTabs } from '../components/pill-tabs';
import { QrCode } from '../components/party/qr-code';
import {
  PrototypeSwitcher,
  usePrototypeVariant,
} from '../components/prototype-switcher';

/*
 * PROTOTYPE: three takes on a welcome step that shows how to add this server
 * to Jellyfin, Streamyfin and Infuse on a phone, and to the desktop app.
 * Switch with `?variant=A|B|C`; `?step=apps` opens straight on it.
 * Question: what should the step look like? Throw away once one wins.
 */

const DESKTOP_DOWNLOAD_URL =
  'https://github.com/Viren070/AIOStreams/releases/tag/desktop';

type AppId = 'jellyfin' | 'streamyfin' | 'infuse' | 'desktop';
type Store = { label: string; icon: React.ReactNode; url: string };

interface App {
  id: AppId;
  name: string;
  icon: React.ReactNode;
  device: 'phone' | 'computer';
  blurb: string;
  stores: Store[];
  /** Steps, where `{address}`, `{username}` and `{password}` become chips. */
  steps: string[];
}

const appStore = (url: string): Store => ({
  label: 'App Store',
  icon: <SiApple />,
  url,
});
const playStore = (url: string): Store => ({
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
    blurb: 'A cleaner Jellyfin app with downloads.',
    stores: [
      appStore('https://apps.apple.com/app/streamyfin/id6593660679'),
      playStore(
        'https://play.google.com/store/apps/details?id=com.fredrikburmester.streamyfin'
      ),
    ],
    steps: [
      'Open Streamyfin and type {address} as the server.',
      'Sign in as {username} with {password}.',
    ],
  },
  {
    id: 'infuse',
    name: 'Infuse',
    icon: <SiInfuse />,
    device: 'phone',
    blurb: 'Plays almost anything, on iPhone, iPad and Apple TV.',
    stores: [appStore('https://apps.apple.com/app/infuse-7/id1136220934')],
    steps: [
      'In Infuse, go to Settings, then Add Files, then Add Share.',
      'Pick Jellyfin and type {address} as the address.',
      'Sign in as {username} with {password}, then Save.',
    ],
  },
  {
    id: 'jellyfin',
    name: 'Jellyfin',
    icon: <SiJellyfin />,
    device: 'phone',
    blurb: 'The official app.',
    stores: [
      appStore('https://apps.apple.com/app/jellyfin-mobile/id1480192618'),
      playStore(
        'https://play.google.com/store/apps/details?id=org.jellyfin.mobile'
      ),
    ],
    steps: [
      'Open Jellyfin and add {address} as a server.',
      'Sign in as {username} with {password}.',
    ],
  },
  {
    id: 'desktop',
    name: 'AIOStreams',
    icon: <LuMonitor />,
    device: 'computer',
    blurb: 'This app with mpv built in, for Windows, Mac and Linux.',
    stores: [
      { label: 'Download', icon: <LuDownload />, url: DESKTOP_DOWNLOAD_URL },
    ],
    steps: [
      'Install it and open it once.',
      'Press Open in the app below, or add {address} in it yourself.',
      'Sign in as {username} with {password}.',
    ],
  },
];

const VARIANTS = [
  { key: 'A', name: 'Details + list' },
  { key: 'B', name: 'By device, step by step' },
  { key: 'C', name: 'Phone preview + QR' },
] as const;

function useDetails() {
  const { client, user } = useSession();
  return { address: client.base, username: user.Name ?? '' };
}

const copy = (text: string) =>
  copyToClipboard(text, {
    onSuccess: () => toast.success(t`Copied`),
    onError: () => toast.error(t`Could not copy it`),
  });

const desktopLink = (base: string) =>
  `aiostreams://server?url=${encodeURIComponent(base)}`;

function CopyChip({ text, className }: { text: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => copy(text)}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-md bg-white/10 px-1.5 py-0.5 align-middle font-mono text-[0.8em] hover:bg-white/15',
        className
      )}
    >
      <span className="truncate">{text}</span>
      <LuCopy className="flex-none opacity-60" />
    </button>
  );
}

/** A step's text with its placeholders as copyable chips. */
function StepText({ text }: { text: string }) {
  const { address, username } = useDetails();
  return (
    <>
      {text.split(/(\{\w+\})/).map((part, i) => {
        if (part === '{address}') return <CopyChip key={i} text={address} />;
        if (part === '{username}') return <CopyChip key={i} text={username} />;
        if (part === '{password}')
          return (
            <span key={i} className="font-medium">
              your password
            </span>
          );
        return part;
      })}
    </>
  );
}

function StoreButtons({ app }: { app: App }) {
  const { address } = useDetails();
  return (
    <div className="flex flex-wrap gap-2">
      {app.stores.map((s) => (
        <Button
          key={s.label}
          size="sm"
          intent="gray-outline"
          className="rounded-full"
          leftIcon={s.icon}
          onClick={() => window.open(s.url, '_blank', 'noopener')}
        >
          {s.label}
        </Button>
      ))}
      {app.id === 'desktop' && (
        <Button
          size="sm"
          intent="white"
          className="rounded-full"
          onClick={() => (window.location.href = desktopLink(address))}
        >
          Open in the app
        </Button>
      )}
    </div>
  );
}

function AppIcon({ app, className }: { app: App; className?: string }) {
  return (
    <span
      className={cn(
        'grid size-10 flex-none place-items-center rounded-xl bg-white/10 text-lg',
        className
      )}
    >
      {app.icon}
    </span>
  );
}

/* A: what to type, once, above a plain list of apps. */
function VariantA() {
  const { address, username } = useDetails();
  return (
    <div className="space-y-5">
      <dl className="divide-y divide-white/10 rounded-xl border border-white/10">
        {[
          ['Server', address],
          ['Username', username],
        ].map(([label, value]) => (
          <div key={label} className="flex items-center gap-3 px-4 py-3">
            <dt className="w-20 flex-none text-sm text-[--muted]">{label}</dt>
            <dd className="min-w-0 flex-1 truncate font-mono text-sm">
              {value}
            </dd>
            <button
              type="button"
              aria-label={`Copy ${label}`}
              className="text-[--muted] hover:text-white"
              onClick={() => copy(value)}
            >
              <LuCopy />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-3 px-4 py-3">
          <dt className="w-20 flex-none text-sm text-[--muted]">Password</dt>
          <dd className="text-sm">The one you just set</dd>
        </div>
      </dl>
      <ul className="space-y-4">
        {APPS.map((app) => (
          <li key={app.id} className="flex gap-3">
            <AppIcon app={app} />
            <div className="min-w-0 flex-1 space-y-2">
              <div>
                <p className="text-sm font-medium">
                  {app.name}
                  {app.device === 'computer' && (
                    <span className="ms-2 text-xs text-[--muted]">
                      on a computer
                    </span>
                  )}
                </p>
                <p className="text-sm text-[--muted]">{app.blurb}</p>
              </div>
              <StoreButtons app={app} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* B: pick the device, then the app, then follow its numbered steps. */
function VariantB() {
  const [device, setDevice] = React.useState<App['device']>(() =>
    /android|iphone|ipad/i.test(navigator.userAgent) ? 'phone' : 'computer'
  );
  const apps = APPS.filter((a) => a.device === device);
  const [picked, setPicked] = React.useState<AppId>(apps[0].id);
  const app = apps.find((a) => a.id === picked) ?? apps[0];
  return (
    <div className="space-y-5">
      <PillTabs
        name="prototype-device"
        options={[
          { value: 'phone' as const, label: 'Phone or tablet' },
          { value: 'computer' as const, label: 'Computer' },
        ]}
        value={device}
        onChange={setDevice}
      />
      {apps.length > 1 && (
        <div className="grid grid-cols-3 gap-2">
          {apps.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setPicked(a.id)}
              className={cn(
                'flex flex-col items-center gap-2 rounded-xl border p-3 text-sm transition-colors',
                a.id === app.id
                  ? 'border-white bg-white/10'
                  : 'border-white/10 hover:border-white/30'
              )}
            >
              <AppIcon app={a} className="size-9" />
              {a.name}
            </button>
          ))}
        </div>
      )}
      <div className="space-y-4 rounded-xl bg-white/5 p-4">
        <p className="text-sm text-[--muted]">{app.blurb}</p>
        <ol className="space-y-3">
          <li className="flex gap-3">
            <Num n={1} />
            <div className="min-w-0 flex-1 space-y-2 text-sm">
              <p>Get {app.name}.</p>
              <StoreButtons app={app} />
            </div>
          </li>
          {app.steps.map((s, i) => (
            <li key={s} className="flex gap-3">
              <Num n={i + 2} />
              <p className="min-w-0 flex-1 text-sm leading-7">
                <StepText text={s} />
              </p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function Num({ n }: { n: number }) {
  return (
    <span className="grid size-6 flex-none place-items-center rounded-full bg-white text-xs font-semibold text-black">
      {n}
    </span>
  );
}

/* C: what the app's sign-in looks like, filled in, with a QR to carry the address. */
function VariantC() {
  const { address, username } = useDetails();
  const [picked, setPicked] = React.useState<AppId>('streamyfin');
  const app = APPS.find((a) => a.id === picked)!;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        {APPS.map((a) => (
          <Button
            key={a.id}
            size="sm"
            intent={a.id === picked ? 'white' : 'gray-basic'}
            className="rounded-full"
            leftIcon={
              a.device === 'computer' ? <LuMonitor /> : <LuSmartphone />
            }
            onClick={() => setPicked(a.id)}
          >
            {a.name}
          </Button>
        ))}
      </div>
      <div className="grid gap-5 sm:grid-cols-[11rem,1fr]">
        <div className="mx-auto w-44 rounded-[1.75rem] border-4 border-gray-800 bg-black p-3 shadow-inner sm:mx-0">
          <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-gray-800" />
          <div className="mb-4 flex items-center gap-2 text-xs font-semibold">
            <AppIcon app={app} className="size-6 rounded-md text-xs" />
            {app.name}
          </div>
          {[
            ['Server', address],
            ['Username', username],
            ['Password', '••••••••'],
          ].map(([label, value]) => (
            <div key={label} className="mb-2">
              <p className="mb-0.5 text-[0.6rem] text-[--muted]">{label}</p>
              <p className="truncate rounded-md bg-white/10 px-2 py-1 font-mono text-[0.65rem]">
                {value}
              </p>
            </div>
          ))}
          <div className="mt-3 flex items-center justify-center gap-1 rounded-md bg-[--brand] py-1 text-[0.65rem] font-semibold">
            <LuCheck /> Connect
          </div>
        </div>
        <div className="space-y-4 text-sm">
          <p className="text-[--muted]">{app.blurb}</p>
          <StoreButtons app={app} />
          <div className="flex items-center gap-3 rounded-xl bg-white/5 p-3">
            <QrCode text={address} className="size-20 flex-none rounded-md" />
            <p className="text-[--muted]">
              Scan with your phone to copy the server address there, or{' '}
              <CopyChip text={address} className="mt-1" />
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AppsStepBody() {
  const variant = usePrototypeVariant(VARIANTS.map((v) => v.key));
  return (
    <>
      {variant === 'A' && <VariantA />}
      {variant === 'B' && <VariantB />}
      {variant === 'C' && <VariantC />}
      <PrototypeSwitcher variants={VARIANTS} current={variant} />
    </>
  );
}

/** `?step=apps`: opens the welcome steps there, for trying the prototype. */
export const previewingAppsStep = () =>
  process.env.NODE_ENV !== 'production' &&
  new URLSearchParams(window.location.search).get('step') === 'apps';
