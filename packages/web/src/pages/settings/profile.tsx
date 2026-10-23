import React from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LuCopy, LuExternalLink, LuTrash2 } from 'react-icons/lu';
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
import { relativeTime } from '../../lib/format';
import { UserAvatar } from '../../components/user-avatar';
import { SettingsCard, SettingsRow } from '../../components/settings-card';
import { LanguageList, followsYou } from './common';

/*
 * The signed-in user's own part of the shared configuration: who they are,
 * how they sign in, a few stream preferences on top of the owner's, and
 * the links that install their streams in Stremio.
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

function useProfile() {
  const { client } = useSession();
  return useQuery({
    queryKey: useProfileKey(),
    queryFn: () => client.get<Profile>('/AIOStreams/Profile'),
  });
}

/** Saves a change, shown at once and put back if the server refuses it. */
function useSaveProfile() {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const key = useProfileKey();
  return useMutation({
    mutationFn: (change: ProfileChange) =>
      client.post<void>('/AIOStreams/Profile', change),
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
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: key.slice(0, 3) }),
  });
}

export function ProfileSection() {
  const profile = useProfile();
  if (!profile.data) {
    return profile.isError ? (
      <p className="text-sm text-[--muted]">{profile.error.message}</p>
    ) : (
      <div className="space-y-6">
        <Skeleton className="h-36 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }
  return (
    <>
      <IdentityCard profile={profile.data} />
      <PreferencesCard preferences={profile.data.preferences} />
      <StremioCard hasPassword={profile.data.hasPassword} />
    </>
  );
}

function IdentityCard({ profile }: { profile: Profile }) {
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

  return (
    <>
      <SettingsCard name="profile" title={t`You`} description={followsYou()}>
        <SettingsRow
          label={
            <span className="flex items-center gap-3">
              <UserAvatar
                name={name}
                src={profile.avatar}
                className="size-12"
              />
              <span className="block text-base">{name}</span>
            </span>
          }
        >
          <Button
            intent="gray-outline"
            className={button}
            onClick={() => setEditing('face')}
          >
            <Trans>Edit</Trans>
          </Button>
        </SettingsRow>
        <SettingsRow
          label={t`Password`}
          help={
            profile.hasPassword
              ? t`Signs you in on the web app and in Jellyfin apps.`
              : t`You sign in with the shared one. Set your own so only you can.`
          }
        >
          <Button
            intent="gray-outline"
            className={button}
            onClick={() => setEditing('password')}
          >
            {profile.hasPassword ? <Trans>Change</Trans> : <Trans>Set</Trans>}
          </Button>
        </SettingsRow>
        <SettingsRow
          label={t`PIN`}
          help={t`Asked when someone switches to you on a shared device.`}
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            {profile.hasPin && (
              <Button
                intent="alert-subtle"
                className={button}
                onClick={() => removePin.open()}
              >
                <Trans>Remove</Trans>
              </Button>
            )}
            <Button
              intent="gray-outline"
              className={button}
              onClick={() => setEditing('pin')}
            >
              {profile.hasPin ? <Trans>Change</Trans> : <Trans>Set</Trans>}
            </Button>
          </div>
        </SettingsRow>
        {profile.configure && <ConfigureRow />}
      </SettingsCard>
      <FaceModal open={editing === 'face'} profile={profile} onClose={close} />
      <PinModal open={editing === 'pin'} onClose={close} />
      <PasswordModal
        open={editing === 'password'}
        profile={profile}
        onClose={close}
      />
      <ConfirmationDialog {...removePin} />
    </>
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
    avatar: profile.avatar ?? '',
  }));
  const name = draft.name.trim();
  const avatar = draft.avatar.trim();
  const validAvatar = !avatar || URL.canParse(avatar);
  return (
    <FormModal
      name="profile-face"
      open={open}
      title={t`Name and picture`}
      onClose={onClose}
      saving={save.isPending}
      canSave={!!name && validAvatar}
      onSubmit={() =>
        save.mutate({ name, avatar: avatar || null }, { onSuccess: onClose })
      }
    >
      <div className="flex items-center gap-4">
        <UserAvatar
          name={name}
          src={validAvatar ? avatar : null}
          className="size-16 text-xl"
        />
        <TextInput
          label={t`Name`}
          value={draft.name}
          maxLength={32}
          onValueChange={(v) => setDraft((d) => ({ ...d, name: v }))}
          fieldClass="flex-1"
        />
      </div>
      <TextInput
        label={t`Picture`}
        help={t`The address of an image. Empty shows your initial.`}
        placeholder="https://"
        value={draft.avatar}
        error={validAvatar ? undefined : t`That isn't an address`}
        onValueChange={(v) => setDraft((d) => ({ ...d, avatar: v }))}
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

function PreferencesCard({ preferences }: { preferences: Preferences }) {
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
        options={[
          { value: ANY, label: t`The owner's choice` },
          ...RESULT_LIMITS.map((n) => ({ value: String(n), label: String(n) })),
        ]}
        value={String(preferences.resultLimit ?? ANY)}
        onValueChange={(v) => set({ resultLimit: number(v) })}
      />
    </SettingsCard>
  );
}

function useStremioLinksKey() {
  return [...useProfileKey(), 'stremio'] as const;
}

function StremioCard({ hasPassword }: { hasPassword: boolean }) {
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

  return (
    <>
      <SettingsCard
        name="profile-stremio"
        title={t`Stremio`}
        description={t`Each link installs your streams in Stremio. Anyone with one plays as you, so revoke a link you no longer use.`}
      >
        {links.data?.map((l) => {
          const label = l.label;
          const made = relativeTime(l.createdAt);
          const used = relativeTime(l.lastUsedAt);
          return (
            <SettingsRow
              key={l.id}
              label={label}
              help={
                used
                  ? t`Made ${made}, used ${used}`
                  : t`Made ${made}, never used`
              }
            >
              <IconButton
                size="sm"
                intent="alert-subtle"
                className="size-9 rounded-full"
                icon={<LuTrash2 />}
                aria-label={t`Revoke ${label}`}
                onClick={() => revoke.mutate(l.id)}
              />
            </SettingsRow>
          );
        })}
        <SettingsRow
          label={links.data?.length ? t`Another device` : t`Install in Stremio`}
          help={t`Made once, shown once.`}
        >
          <Button
            intent="gray-outline"
            className={button}
            onClick={() => setCreating(true)}
          >
            <Trans>New link</Trans>
          </Button>
        </SettingsRow>
      </SettingsCard>
      <StremioLinkModal
        open={creating}
        hasPassword={hasPassword}
        onClose={() => setCreating(false)}
      />
    </>
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
