import React from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LuCopy,
  LuEye,
  LuEyeOff,
  LuExternalLink,
  LuTrash2,
} from 'react-icons/lu';
import { SiAnilist, SiSimkl } from 'react-icons/si';
import type { IconType } from 'react-icons';
import { Button, IconButton } from '@aiostreams/ui/button';
import { Modal } from '@aiostreams/ui/modal';
import { Select } from '@aiostreams/ui/select';
import { Switch } from '@aiostreams/ui/switch';
import { TextInput } from '@aiostreams/ui/text-input';
import { PasswordInput } from '@aiostreams/ui/password-input';
import { Skeleton } from '@aiostreams/ui/skeleton';
import { formatBytes } from '@aiostreams/ui/core/format';
import { copyToClipboard } from '@aiostreams/ui/utils/clipboard';
import {
  ConfirmationDialog,
  useConfirmationDialog,
} from '@aiostreams/ui/shared/confirmation-dialog';
import { LANGUAGES as FILTER_LANGUAGES } from '@aiostreams/core/src/utils/language-list';
import { useSession } from '../../lib/session';
import { libraryLabel, relativeTime } from '../../lib/format';
import { orderKeyOf, useViews } from '../../lib/queries';
import { usePlaybackPrefs } from '../../lib/user-config';
import { UserAvatar } from '../../components/user-avatar';
import { AvatarPicker } from '../../components/avatar-picker';
import { SettingsCard, SettingsRow } from '../../components/settings-card';
import { Answer, AnswerGroup, LanguageList, Pills } from './common';

/*
 * The signed-in user's own part of the shared configuration: who they are,
 * how they sign in, the trackers they keep, a few stream preferences on top
 * of the owner's, their libraries' order, and the links that install their
 * streams in Stremio.
 */

const RESOLUTIONS = ['2160p', '1440p', '1080p', '720p'] as const;
type Resolution = (typeof RESOLUTIONS)[number];

interface Preferences {
  maxResolution?: Resolution;
  skipHdr?: boolean;
  languages?: string[];
  maxMovieSize?: number;
  maxEpisodeSize?: number;
  resultLimit?: number;
}

interface Profile {
  name: string | null;
  avatar: string | null;
  hasPin: boolean;
  hasPassword: boolean;
  passwordMin: number;
  preferences: Preferences;
  /** The instance's owner, who can open its configure page from here. */
  configure?: boolean;
}

interface StremioLink {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

type ProfileChange = {
  name?: string;
  avatar?: string | null;
  pin?: string | null;
  preferences?: Preferences;
};

const GB = 1e9;
const MOVIE_SIZES = [2, 4, 8, 15, 30, 60].map((n) => n * GB);
const EPISODE_SIZES = [0.5, 1, 2, 4, 8].map((n) => n * GB);
const RESULT_LIMITS = [3, 5, 10, 20, 50];
const MAX_LANGUAGES = 5;
const ANY = 'any';

const button = 'w-full rounded-full sm:w-auto';

function useProfileKey() {
  const { client, user } = useSession();
  return ['jf', client.base, user.Id, 'profile'] as const;
}

export function useProfile() {
  const { client } = useSession();
  return useQuery({
    queryKey: useProfileKey(),
    queryFn: () => client.get<Profile>('/AIOStreams/Profile'),
  });
}

/** Saves a change, shown at once and put back if the server refuses it. */
export function useSaveProfile() {
  const { client, renew } = useSession();
  const queryClient = useQueryClient();
  const key = useProfileKey();
  return useMutation({
    // A PIN change answers with this session's renewed token.
    mutationFn: (change: ProfileChange) =>
      client.post<{ AccessToken: string } | undefined>(
        '/AIOStreams/Profile',
        change
      ),
    onMutate: async (change) => {
      await queryClient.cancelQueries({ queryKey: key });
      const before = queryClient.getQueryData<Profile>(key);
      if (before) {
        queryClient.setQueryData<Profile>(key, {
          ...before,
          ...(change.name !== undefined && { name: change.name }),
          ...(change.avatar !== undefined && { avatar: change.avatar }),
          ...(change.pin !== undefined && { hasPin: !!change.pin }),
          ...(change.preferences && { preferences: change.preferences }),
        });
      }
      return { before };
    },
    onError: (error, _change, context) => {
      if (context?.before) queryClient.setQueryData(key, context.before);
      toast.error(error.message);
    },
    // The name and picture show elsewhere too, as the user picker lists them.
    // Not after a renewal: the old token's refetch would sign the user out.
    onSettled: (result) =>
      result
        ? renew(result.AccessToken)
        : queryClient.invalidateQueries({ queryKey: key.slice(0, 3) }),
  });
}

export function ProfileSection() {
  const profile = useProfile();
  if (!profile.data) {
    return profile.isError ? (
      <p className="text-sm text-[--muted]">{profile.error.message}</p>
    ) : (
      <div className="space-y-6">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }
  return (
    <div className="space-y-12">
      <Identity profile={profile.data} />
      <Tracking />
      <Streams preferences={profile.data.preferences} />
      <LibraryOrder />
      <Stremio hasPassword={profile.data.hasPassword} />
    </div>
  );
}

/** Who they are and how they sign in, in one line with its buttons beside it. */
function Identity({ profile }: { profile: Profile }) {
  const { user } = useSession();
  const [editing, setEditing] = React.useState<
    'face' | 'pin' | 'password' | null
  >(null);
  const save = useSaveProfile();
  const removePin = useConfirmationDialog({
    title: t`Remove PIN`,
    description: t`Anyone using this device can switch to you without it.`,
    actionText: t`Remove`,
    onConfirm: () =>
      save.mutate(
        { pin: null },
        { onSuccess: () => toast.success(t`PIN removed`) }
      ),
  });
  const close = () => setEditing(null);
  const name = profile.name ?? user.Name ?? '';
  const signIn = profile.hasPassword
    ? profile.hasPin
      ? t`Your own password and a PIN`
      : t`Your own password, no PIN`
    : profile.hasPin
      ? t`The shared password and a PIN`
      : t`The shared password, no PIN`;

  return (
    <section data-ui="settings-card" data-name="profile" className="space-y-3">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={() => setEditing('face')}
          aria-label={t`Edit name and picture`}
          className="group flex min-w-0 flex-1 items-center gap-4 text-start"
        >
          <UserAvatar
            name={name}
            src={profile.avatar}
            className="size-16 flex-none text-xl ring-2 ring-transparent transition group-hover:ring-white/30"
          />
          <span className="min-w-0">
            <span className="block truncate text-xl font-semibold">{name}</span>
            <span className="block text-sm text-[--muted]">{signIn}</span>
          </span>
        </button>
        <div className="flex flex-wrap gap-2">
          <Button
            intent="gray-outline"
            size="sm"
            className="rounded-full"
            onClick={() => setEditing('face')}
          >
            <Trans>Edit</Trans>
          </Button>
          <Button
            intent="gray-outline"
            size="sm"
            className="rounded-full"
            onClick={() => setEditing('password')}
          >
            {profile.hasPassword ? t`Change password` : t`Set a password`}
          </Button>
          <Button
            intent="gray-outline"
            size="sm"
            className="rounded-full"
            onClick={() => setEditing('pin')}
          >
            {profile.hasPin ? t`Change PIN` : t`Set a PIN`}
          </Button>
          {profile.hasPin && (
            <Button
              intent="alert-subtle"
              size="sm"
              className="rounded-full"
              onClick={() => removePin.open()}
            >
              {t`Remove PIN`}
            </Button>
          )}
        </div>
      </div>
      {profile.configure && (
        <div className="rounded-xl border border-white/10 px-4 py-3">
          <ConfigureRow />
        </div>
      )}
      <FaceModal open={editing === 'face'} profile={profile} onClose={close} />
      <PinModal open={editing === 'pin'} onClose={close} />
      <PasswordModal
        open={editing === 'password'}
        profile={profile}
        onClose={close}
      />
      <ConfirmationDialog {...removePin} />
    </section>
  );
}

function ConfigureRow() {
  const { client } = useSession();
  const open = useMutation({
    mutationFn: () =>
      client.post<{ url: string }>('/AIOStreams/Profile/Configure'),
  });
  return (
    <SettingsRow
      label={t`Configuration`}
      help={t`Addons, catalogs and everyone's accounts.`}
    >
      <Button
        intent="gray-outline"
        className={button}
        loading={open.isPending}
        onClick={() => {
          // Opened now, while the click still allows a new tab.
          const tab = window.open('', '_blank');
          open.mutate(undefined, {
            onSuccess: ({ url }) => {
              const href = new URL(url, client.base).href;
              if (tab) tab.location.href = href;
              else window.location.href = href;
            },
            onError: (error) => {
              tab?.close();
              toast.error(error.message);
            },
          });
        }}
      >
        <Trans>Open</Trans>
      </Button>
    </SettingsRow>
  );
}

function FormModal({
  name,
  open,
  title,
  description,
  onClose,
  onSubmit,
  saving,
  canSave,
  children,
}: {
  name: string;
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  onSubmit: () => void;
  saving: boolean;
  canSave: boolean;
  children: React.ReactNode;
}) {
  return (
    <Modal
      data-ui="dialog"
      data-name={name}
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={title}
      description={description}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave && !saving) onSubmit();
        }}
      >
        {children}
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            intent="gray-outline"
            className="rounded-full"
            onClick={onClose}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button
            type="submit"
            intent="white"
            className="rounded-full"
            loading={saving}
            disabled={!canSave}
          >
            <Trans>Save</Trans>
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Fields that start over from `initial` each time their modal opens. */
function useDraft<T>(open: boolean, initial: () => T) {
  const [draft, setDraft] = React.useState(initial);
  React.useEffect(() => {
    if (open) setDraft(initial());
    // Only a fresh opening starts over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return [draft, setDraft] as const;
}

function FaceModal({
  open,
  profile,
  onClose,
}: {
  open: boolean;
  profile: Profile;
  onClose: () => void;
}) {
  const save = useSaveProfile();
  const [draft, setDraft] = useDraft(open, () => ({
    name: profile.name ?? '',
    avatar: profile.avatar,
  }));
  const name = draft.name.trim();
  return (
    <FormModal
      name="profile-face"
      open={open}
      title={t`Name and picture`}
      onClose={onClose}
      saving={save.isPending}
      canSave={!!name}
      onSubmit={() =>
        save.mutate({ name, avatar: draft.avatar }, { onSuccess: onClose })
      }
    >
      <AvatarPicker
        name={name}
        src={draft.avatar}
        onChange={(avatar) => setDraft((d) => ({ ...d, avatar }))}
      />
      <TextInput
        label={t`Name`}
        value={draft.name}
        maxLength={32}
        onValueChange={(v) => setDraft((d) => ({ ...d, name: v }))}
      />
    </FormModal>
  );
}

function PinModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const save = useSaveProfile();
  const [pin, setPin] = useDraft(open, () => '');
  const valid = /^\d{4,12}$/.test(pin);
  return (
    <FormModal
      name="profile-pin"
      open={open}
      title={t`PIN`}
      description={t`4 to 12 digits.`}
      onClose={onClose}
      saving={save.isPending}
      canSave={valid}
      onSubmit={() =>
        save.mutate(
          { pin },
          {
            onSuccess: () => {
              toast.success(t`PIN saved`);
              onClose();
            },
          }
        )
      }
    >
      <PasswordInput
        label={t`New PIN`}
        inputMode="numeric"
        autoComplete="off"
        value={pin}
        onValueChange={(v) => setPin(v.replace(/\D/g, '').slice(0, 12))}
      />
    </FormModal>
  );
}

function PasswordModal({
  open,
  profile,
  onClose,
}: {
  open: boolean;
  profile: Profile;
  onClose: () => void;
}) {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const key = useProfileKey();
  const [draft, setDraft] = useDraft(open, () => ({ current: '', next: '' }));
  const change = useMutation({
    mutationFn: () =>
      client.post<void>('/AIOStreams/Profile/Password', {
        current: profile.hasPassword ? draft.current : undefined,
        next: draft.next,
      }),
    onSuccess: () => {
      toast.success(t`Password saved`);
      void queryClient.invalidateQueries({ queryKey: key });
      onClose();
    },
    onError: (error) => toast.error(error.message),
  });
  const min = profile.passwordMin;
  const short = draft.next.length > 0 && draft.next.length < min;
  return (
    <FormModal
      name="profile-password"
      open={open}
      title={profile.hasPassword ? t`Change password` : t`Set a password`}
      description={t`Your devices stay signed in.`}
      onClose={onClose}
      saving={change.isPending}
      canSave={
        draft.next.length >= min && (!profile.hasPassword || !!draft.current)
      }
      onSubmit={() => change.mutate()}
    >
      {profile.hasPassword && (
        <PasswordInput
          label={t`Current password`}
          autoComplete="current-password"
          value={draft.current}
          onValueChange={(v) => setDraft((d) => ({ ...d, current: v }))}
        />
      )}
      <PasswordInput
        label={t`New password`}
        autoComplete="new-password"
        value={draft.next}
        error={short ? t`At least ${min} characters` : undefined}
        onValueChange={(v) => setDraft((d) => ({ ...d, next: v }))}
      />
    </FormModal>
  );
}

const sizeOptions = (sizes: number[]) => [
  { value: ANY, label: t`No limit` },
  ...sizes.map((s) => ({ value: String(s), label: formatBytes(s) })),
];

const languageOptions = () =>
  FILTER_LANGUAGES.map((name) => ({ value: name, label: name }));

const resultLimitOptions = () => [
  { value: ANY, label: t`The owner's choice` },
  ...RESULT_LIMITS.map((n) => ({ value: String(n), label: String(n) })),
];

/** Their stream choices, as a few short answers. */
function Streams({ preferences }: { preferences: Preferences }) {
  const save = useSaveProfile();
  // Everything is sent each time, as the server keeps the whole set.
  const set = (change: Preferences) =>
    save.mutate({ preferences: { ...preferences, ...change } });
  const number = (v: string) => (v === ANY ? undefined : Number(v));
  const resolution = preferences.maxResolution ?? ANY;

  return (
    <AnswerGroup
      name="profile-streams"
      title={t`Your streams`}
      description={t`On top of what the owner set up, for you alone. Left alone, theirs stands.`}
    >
      <Answer label={t`Highest quality`}>
        <Pills
          label={t`Highest quality`}
          options={[ANY, ...RESOLUTIONS].map((r) => ({
            value: r,
            label: r === ANY ? t`Any` : r,
          }))}
          isOn={(r) => r === resolution}
          onPick={(r) =>
            set({ maxResolution: r === ANY ? undefined : (r as Resolution) })
          }
        />
        <Switch
          side="right"
          label={t`Skip HDR and Dolby Vision`}
          help={t`For a screen that shows them washed out.`}
          value={!!preferences.skipHdr}
          onValueChange={(v) => set({ skipHdr: v || undefined })}
        />
      </Answer>
      <Answer label={t`Size`}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Select
            label={t`Largest movie`}
            options={sizeOptions(MOVIE_SIZES)}
            value={String(preferences.maxMovieSize ?? ANY)}
            onValueChange={(v) => set({ maxMovieSize: number(v) })}
          />
          <Select
            label={t`Largest episode`}
            options={sizeOptions(EPISODE_SIZES)}
            value={String(preferences.maxEpisodeSize ?? ANY)}
            onValueChange={(v) => set({ maxEpisodeSize: number(v) })}
          />
          <Select
            label={t`Versions to show`}
            options={resultLimitOptions()}
            value={String(preferences.resultLimit ?? ANY)}
            onValueChange={(v) => set({ resultLimit: number(v) })}
          />
        </div>
      </Answer>
      <Answer label={t`Languages`}>
        <div className="max-w-md">
          <LanguageList
            label=""
            help={t`Streams in these come first, in this order.`}
            options={languageOptions()}
            value={preferences.languages ?? []}
            max={MAX_LANGUAGES}
            onChange={(next) =>
              set({ languages: next.length ? next : undefined })
            }
          />
        </div>
      </Answer>
    </AnswerGroup>
  );
}

/** The welcome's stream step, as cards. */
export function PreferencesCard({ preferences }: { preferences: Preferences }) {
  const save = useSaveProfile();
  // Everything is sent each time, as the server keeps the whole set.
  const set = (change: Preferences) =>
    save.mutate({ preferences: { ...preferences, ...change } });
  const number = (v: string) => (v === ANY ? undefined : Number(v));

  return (
    <SettingsCard
      name="profile-streams"
      title={t`Streams`}
      description={t`On top of what the owner set up, for you alone. Left alone, theirs stands.`}
    >
      <Select
        label={t`Highest resolution`}
        options={[
          { value: ANY, label: t`Any` },
          ...RESOLUTIONS.map((r) => ({ value: r, label: r })),
        ]}
        value={preferences.maxResolution ?? ANY}
        onValueChange={(v) =>
          set({ maxResolution: v === ANY ? undefined : (v as Resolution) })
        }
      />
      <Switch
        side="right"
        label={t`Skip HDR and Dolby Vision`}
        help={t`For a screen that shows them washed out.`}
        value={!!preferences.skipHdr}
        onValueChange={(v) => set({ skipHdr: v || undefined })}
      />
      <LanguageList
        label={t`Languages`}
        help={t`Streams in these come first, in this order.`}
        options={languageOptions()}
        value={preferences.languages ?? []}
        max={MAX_LANGUAGES}
        onChange={(next) => set({ languages: next.length ? next : undefined })}
      />
      <Select
        label={t`Largest movie`}
        options={sizeOptions(MOVIE_SIZES)}
        value={String(preferences.maxMovieSize ?? ANY)}
        onValueChange={(v) => set({ maxMovieSize: number(v) })}
      />
      <Select
        label={t`Largest episode`}
        options={sizeOptions(EPISODE_SIZES)}
        value={String(preferences.maxEpisodeSize ?? ANY)}
        onValueChange={(v) => set({ maxEpisodeSize: number(v) })}
      />
      <Select
        label={t`Versions to show`}
        options={resultLimitOptions()}
        value={String(preferences.resultLimit ?? ANY)}
        onValueChange={(v) => set({ resultLimit: number(v) })}
      />
    </SettingsCard>
  );
}

export type TrackerProvider = 'simkl' | 'anilist';

interface Trackers {
  available: boolean;
  shared: boolean;
  accounts: Record<TrackerProvider, string | null>;
}

export const TRACKERS: { id: TrackerProvider; name: string; icon: IconType }[] =
  [
    // eslint-disable-next-line lingui/no-unlocalized-strings -- brand names
    { id: 'simkl', name: 'Simkl', icon: SiSimkl },
    { id: 'anilist', name: 'AniList', icon: SiAnilist },
  ];

function useTrackersKey() {
  return [...useProfileKey(), 'trackers'] as const;
}

export function useTrackers() {
  const { client } = useSession();
  return useQuery({
    queryKey: useTrackersKey(),
    queryFn: () => client.get<Trackers>('/AIOStreams/Profile/Trackers'),
  });
}

/** The tracker accounts, with signing in to and out of them. */
export function useTrackerAccounts() {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const key = useTrackersKey();
  const trackers = useTrackers();
  const refetch = trackers.refetch;
  const [waiting, setWaiting] = React.useState<TrackerProvider | null>(null);
  const connect = useMutation({
    mutationFn: (provider: TrackerProvider) =>
      client.post<{ url: string }>(`/AIOStreams/Profile/Trackers/${provider}`),
  });
  const disconnect = useMutation({
    mutationFn: (provider: TrackerProvider) =>
      client.delete<void>(`/AIOStreams/Profile/Trackers/${provider}`),
    onError: (error) => toast.error(error.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  // The sign-in ends on our own page, which says so here and closes itself.
  React.useEffect(() => {
    const channel = new BroadcastChannel('aiostreams-trackers');
    const done = () => {
      setWaiting(null);
      void refetch();
    };
    channel.onmessage = done;
    // Closed partway through, so nothing comes.
    window.addEventListener('focus', done);
    return () => {
      channel.close();
      window.removeEventListener('focus', done);
    };
  }, [refetch]);

  const signIn = (provider: TrackerProvider) => {
    // Opened now, while the click still allows a new window.
    const popup = window.open('', 'aiostreams-tracker', 'width=520,height=720');
    setWaiting(provider);
    connect.mutate(provider, {
      onSuccess: ({ url }) => {
        if (popup) popup.location.href = url;
        else window.location.href = url;
      },
      onError: (error) => {
        popup?.close();
        setWaiting(null);
        toast.error(error.message);
      },
    });
  };

  return { data: trackers.data, waiting, signIn, disconnect };
}

const trackingHelp = (shared: boolean) =>
  shared
    ? t`You share the main history, so what you watch is tracked on its accounts.`
    : t`What you watch is marked on these, and what you mark there shows here.`;

/** The welcome's tracking step, as a card. */
export function TrackersCard() {
  const { data, waiting, signIn, disconnect } = useTrackerAccounts();
  if (!data?.available) return null;
  return (
    <SettingsCard
      name="profile-trackers"
      title={t`Tracking`}
      description={trackingHelp(data.shared)}
    >
      {TRACKERS.map(({ id, name, icon: Icon }) => {
        const account = data.accounts[id];
        return (
          <SettingsRow
            key={id}
            label={
              <span className="flex items-center gap-3">
                <Icon className="size-5 shrink-0 text-[--muted]" />
                {name}
              </span>
            }
            help={account ? t`Signed in as ${account}` : t`Not connected`}
          >
            {account ? (
              <Button
                intent="alert-subtle"
                className={button}
                loading={disconnect.isPending && disconnect.variables === id}
                onClick={() => disconnect.mutate(id)}
              >
                <Trans>Disconnect</Trans>
              </Button>
            ) : (
              <Button
                intent="gray-outline"
                className={button}
                disabled={data.shared}
                loading={waiting === id}
                onClick={() => signIn(id)}
              >
                <Trans>Connect</Trans>
              </Button>
            )}
          </SettingsRow>
        );
      })}
    </SettingsCard>
  );
}

function useStremioLinksKey() {
  return [...useProfileKey(), 'stremio'] as const;
}

/** The trackers what they watch is marked on, a row each to connect or leave. */
function Tracking() {
  const { data, waiting, signIn, disconnect } = useTrackerAccounts();
  if (!data?.available) return null;
  return (
    <AnswerGroup
      name="profile-trackers"
      title={t`Tracking`}
      description={trackingHelp(data.shared)}
    >
      <Answer label={t`Accounts`}>
        <ul className="divide-y divide-white/10">
          {TRACKERS.map(({ id, name, icon: Icon }) => {
            const account = data.accounts[id];
            return (
              <li
                key={id}
                className="flex items-center gap-3 py-2 first:pt-0 last:pb-0"
              >
                <Icon className="size-5 flex-none text-[--muted]" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{name}</span>
                  <span className="block truncate text-xs text-[--muted]">
                    {account ? t`Signed in as ${account}` : t`Not connected`}
                  </span>
                </span>
                {account ? (
                  <Button
                    intent="alert-subtle"
                    size="sm"
                    className="rounded-full"
                    loading={
                      disconnect.isPending && disconnect.variables === id
                    }
                    onClick={() => disconnect.mutate(id)}
                  >
                    <Trans>Disconnect</Trans>
                  </Button>
                ) : (
                  <Button
                    intent="gray-outline"
                    size="sm"
                    className="rounded-full"
                    disabled={data.shared}
                    loading={waiting === id}
                    onClick={() => signIn(id)}
                  >
                    <Trans>Connect</Trans>
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Answer>
    </AnswerGroup>
  );
}

/** Their libraries and home rows in their order, each hideable; one added to the addon later joins at the end. */
function LibraryOrder() {
  const views = useViews(true);
  const { prefs, update } = usePlaybackPrefs();
  const hidden = new Set(prefs.MyMediaExcludes ?? []);
  const toggle = (key: string) =>
    update({
      MyMediaExcludes: hidden.has(key)
        ? [...hidden].filter((k) => k !== key)
        : [...hidden, key],
    });
  // "Because you watched" rows change with the history, so they move as one.
  const entries = new Map<string, string>();
  for (const v of views.data?.Items ?? []) {
    const key = orderKeyOf(v);
    if (entries.has(key)) continue;
    entries.set(
      key,
      key === v.Id
        ? [v.Name, libraryLabel(v)].filter(Boolean).join(' · ')
        : t`Because you watched`
    );
  }
  if (entries.size < 2) return null;
  return (
    <AnswerGroup
      name="library-order"
      title={t`Your libraries`}
      description={t`The order of your libraries and home rows. A catalog added to your addon later goes at the end.`}
    >
      <Answer label={t`Order`}>
        <div className="max-w-xl">
          <LanguageList
            fixed
            label=""
            help={t`Drag one, or use its arrows. A hidden one is left out of your libraries and home.`}
            options={[...entries].map(([value, label]) => ({ value, label }))}
            value={[...entries.keys()]}
            muted={(key) => hidden.has(key)}
            actions={(key, name) => (
              <IconButton
                size="sm"
                intent="gray-subtle"
                className="size-8 rounded-full"
                icon={hidden.has(key) ? <LuEyeOff /> : <LuEye />}
                aria-label={hidden.has(key) ? t`Show ${name}` : t`Hide ${name}`}
                aria-pressed={hidden.has(key)}
                onClick={() => toggle(key)}
              />
            )}
            onChange={(next) => update({ OrderedViews: next })}
          />
        </div>
      </Answer>
    </AnswerGroup>
  );
}

/** Their Stremio links, one per device, and a button for another. */
function Stremio({ hasPassword }: { hasPassword: boolean }) {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const key = useStremioLinksKey();
  const [creating, setCreating] = React.useState(false);
  const links = useQuery({
    queryKey: key,
    queryFn: () => client.get<StremioLink[]>('/AIOStreams/Profile/Stremio'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      client.delete<void>(`/AIOStreams/Profile/Stremio/${id}`),
    onSuccess: () => toast.success(t`Link revoked`),
    onError: (error) => toast.error(error.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const count = links.data?.length ?? 0;

  return (
    <AnswerGroup
      name="profile-stremio"
      title={t`Stremio`}
      description={t`Each link installs your streams in Stremio. Anyone with one plays as you, so revoke a link you no longer use.`}
    >
      <Answer label={count ? t`Links` : t`No links yet`}>
        {count > 0 && (
          <ul className="divide-y divide-white/10">
            {links.data?.map((l) => {
              const label = l.label;
              const made = relativeTime(l.createdAt);
              const used = relativeTime(l.lastUsedAt);
              return (
                <li
                  key={l.id}
                  className="flex items-center gap-3 py-2 first:pt-0"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {label}
                    </span>
                    <span className="block text-xs text-[--muted]">
                      {used
                        ? t`Made ${made}, used ${used}`
                        : t`Made ${made}, never used`}
                    </span>
                  </span>
                  <IconButton
                    size="sm"
                    intent="alert-subtle"
                    className="size-8 rounded-full"
                    icon={<LuTrash2 />}
                    aria-label={t`Revoke ${label}`}
                    onClick={() => revoke.mutate(l.id)}
                  />
                </li>
              );
            })}
          </ul>
        )}
        <Button
          intent="gray-outline"
          size="sm"
          className="rounded-full"
          onClick={() => setCreating(true)}
        >
          {count ? t`Link another device` : t`Install in Stremio`}
        </Button>
      </Answer>
      <StremioLinkModal
        open={creating}
        hasPassword={hasPassword}
        onClose={() => setCreating(false)}
      />
    </AnswerGroup>
  );
}

function StremioLinkModal({
  open,
  hasPassword,
  onClose,
}: {
  open: boolean;
  hasPassword: boolean;
  onClose: () => void;
}) {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const key = useStremioLinksKey();
  const [draft, setDraft] = useDraft(open, () => ({
    label: '',
    password: '',
  }));
  const create = useMutation({
    mutationFn: () =>
      client.post<{ manifestUrl: string }>('/AIOStreams/Profile/Stremio', {
        label: draft.label.trim() || undefined,
        password: hasPassword ? draft.password : undefined,
      }),
    onError: (error) => toast.error(error.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  React.useEffect(() => {
    if (open) create.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const made = create.data?.manifestUrl;

  if (made) {
    return (
      <Modal
        data-ui="dialog"
        data-name="stremio-link"
        open={open}
        onOpenChange={(next) => !next && onClose()}
        title={t`Your Stremio link`}
        description={t`It won't be shown again. Copy it now, or open it in Stremio on this device.`}
      >
        <div className="space-y-4">
          <p className="break-all rounded-xl bg-black/40 p-3 font-mono text-xs leading-relaxed">
            {made}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              intent="gray-outline"
              className="rounded-full"
              leftIcon={<LuCopy />}
              onClick={() =>
                void copyToClipboard(made, {
                  onSuccess: () => toast.success(t`Link copied`),
                  onError: () => toast.error(t`Could not copy it`),
                })
              }
            >
              <Trans>Copy</Trans>
            </Button>
            <Button
              intent="white"
              className="rounded-full"
              rightIcon={<LuExternalLink />}
              onClick={() =>
                window.open(made.replace(/^https?:\/\//, 'stremio://'))
              }
            >
              <Trans>Open in Stremio</Trans>
            </Button>
          </div>
        </div>
      </Modal>
    );
  }
  return (
    <FormModal
      name="stremio-link"
      open={open}
      title={t`New Stremio link`}
      description={
        hasPassword
          ? t`Your password confirms it's you.`
          : t`Name it for the device it goes on.`
      }
      onClose={onClose}
      saving={create.isPending}
      canSave={!hasPassword || !!draft.password}
      onSubmit={() => create.mutate()}
    >
      <TextInput
        label={t`Name`}
        placeholder={t`Living room TV`}
        maxLength={40}
        value={draft.label}
        onValueChange={(v) => setDraft((d) => ({ ...d, label: v }))}
      />
      {hasPassword && (
        <PasswordInput
          label={t`Password`}
          autoComplete="current-password"
          value={draft.password}
          onValueChange={(v) => setDraft((d) => ({ ...d, password: v }))}
        />
      )}
    </FormModal>
  );
}
