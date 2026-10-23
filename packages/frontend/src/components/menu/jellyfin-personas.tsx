import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DndContext } from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useUserData } from '@/context/userData';
import { useStatus } from '@/context/status';
import { watchStateTrackersQuery } from '@/lib/queries';
import {
  APIError,
  createUserInvite,
  listUserInvites,
  revokeUserInvite,
  uploadUserAvatar,
  type Credentials,
  type UserInvite,
  type WatchStateTrackerOption,
} from '@/lib/api';
import { cn } from '@aiostreams/ui/core/styling';
import { pill, VariantPills } from '../shared/variant-pills';
import { useSortableRows } from '../shared/sortable-rows';
import {
  ConfirmationDialog,
  useConfirmationDialog,
} from '@aiostreams/ui/shared/confirmation-dialog';
import { Button, IconButton } from '@aiostreams/ui/button';
import { TextInput } from '@aiostreams/ui/text-input';
import { Select } from '@aiostreams/ui/select';
import { Switch } from '@aiostreams/ui/switch';
import { Modal } from '@aiostreams/ui/modal';
import { copyToClipboard } from '@aiostreams/ui/utils/clipboard';
import { avatarImage } from '@aiostreams/ui/utils/avatar-image';
import { toast } from 'sonner';
import { FiEdit2, FiLink, FiPlus, FiTrash2, FiUpload } from 'react-icons/fi';
import type { UserData } from '@aiostreams/core';

type JellyfinSettings = NonNullable<UserData['jellyfin']>;
type Persona = NonNullable<JellyfinSettings['personas']>[number];
type Primary = NonNullable<JellyfinSettings['primary']>;
type VariantOptionList = React.ComponentProps<typeof VariantPills>['variants'];

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Fallback until the status call lands; the instance cap is the real bound. */
const DEFAULT_MAX_PERSONAS = 20;
const NO_TRACKER_OPTIONS: WatchStateTrackerOption[] = [];

const ADDRESS_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ADDRESS_LENGTH = 10;

/** Random, so an address gives away neither the configuration nor the user. */
function newAddress(): string {
  let code = '';
  while (code.length < ADDRESS_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      // 252 is the largest multiple of 36 under 256, so every character is as likely.
      if (byte < 252 && code.length < ADDRESS_LENGTH)
        code += ADDRESS_CHARS[byte % ADDRESS_CHARS.length];
    }
  }
  return code;
}

function PersonalAddress({
  url,
  pinSignIn,
  onRenew,
}: {
  url: string;
  pinSignIn: boolean;
  onRenew: () => void;
}) {
  const copy = () =>
    copyToClipboard(url, {
      onSuccess: () => toast.success('Address copied to clipboard'),
      onError: () => toast.error('Failed to copy address'),
    });
  return (
    <div className="space-y-2">
      <TextInput
        label="Their address"
        value={url}
        readOnly
        onFocus={(e) => e.currentTarget.select()}
        help={
          pinSignIn
            ? 'Signs in this user alone, with their PIN. Works once you save, and a new address turns this one off.'
            : 'Signs in this user alone. This instance asks for your password there, so approve their devices with Quick Connect instead. Works once you save, and a new address turns this one off.'
        }
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" intent="white" rounded onClick={() => void copy()}>
          Copy
        </Button>
        <Button size="sm" intent="gray-subtle" rounded onClick={onRenew}>
          New address
        </Button>
      </div>
    </div>
  );
}

/** Tracker addons repeat this rule to match a name to its id, so it must not change. */
function slugOf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28) || 'user'
  );
}

/**
 * The id keys the user's history, so it is minted once from the name and never
 * edited: the same name gets the same history back.
 */
function idFor(name: string, existing: Persona[]): string {
  const base = slugOf(name);
  let id = base;
  for (let i = 2; existing.some((p) => p.id === id); i++) id = `${base}-${i}`;
  return id;
}

const sameName = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

function variantsLabel(ids: string[] | undefined): string {
  return ids?.length ? `Variants ${ids.join(', ')}` : 'Base config';
}

function trackersLabel(ids: string[]): string {
  if (!ids.length) return 'no trackers';
  return ids.length === 1 ? '1 tracker' : `${ids.length} trackers`;
}

function Avatar({ name, avatar }: { name: string; avatar?: string }) {
  if (avatar) {
    return (
      <img
        src={avatar}
        alt=""
        className="h-8 w-8 shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[--subtle] text-xs font-semibold uppercase text-[--muted]">
      {name.trim().charAt(0) || '?'}
    </span>
  );
}

interface UserRowProps {
  name: string;
  avatar?: string;
  summary: string;
  dragHandleProps?: { attributes: any; listeners: any } | null;
  onEdit: () => void;
  onInvite?: () => void;
  onDelete?: () => void;
}

function UserRow({
  name,
  avatar,
  summary,
  dragHandleProps,
  onEdit,
  onInvite,
  onDelete,
}: UserRowProps) {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      {dragHandleProps ? (
        <div
          className="w-6 shrink-0 touch-manipulation cursor-move self-stretch rounded-full bg-[--muted] md:bg-[--subtle] md:hover:bg-[--subtle-highlight]"
          aria-label={`Move ${name}`}
          {...dragHandleProps.attributes}
          {...dragHandleProps.listeners}
        />
      ) : (
        <div className="w-6 shrink-0" />
      )}
      <Avatar name={name} avatar={avatar} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-white">{name}</p>
        <p className="truncate text-xs text-[--muted]">{summary}</p>
      </div>
      {onInvite && (
        <IconButton
          size="sm"
          intent="gray-subtle"
          icon={<FiLink />}
          aria-label={`Setup link for ${name}`}
          onClick={onInvite}
        />
      )}
      <IconButton
        size="sm"
        intent="gray-subtle"
        icon={<FiEdit2 />}
        aria-label={`Edit ${name}`}
        onClick={onEdit}
      />
      {onDelete && (
        <IconButton
          size="sm"
          intent="alert-subtle"
          icon={<FiTrash2 />}
          aria-label={`Remove ${name}`}
          onClick={onDelete}
        />
      )}
    </div>
  );
}

function SortableUserRow({
  id,
  ...row
}: Omit<UserRowProps, 'dragHandleProps'> & { id: string }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
    >
      <UserRow {...row} dragHandleProps={{ attributes, listeners }} />
    </li>
  );
}

function VariantsField({
  variants,
  value,
  onChange,
}: {
  variants: VariantOptionList;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">Variants</p>
      <p className="text-xs text-[--muted]">
        Applied while this user is signed in, in the order picked.
      </p>
      <VariantPills variants={variants} value={value} onChange={onChange} />
    </div>
  );
}

interface TrackerChoice extends WatchStateTrackerOption {
  takenBy?: string;
}

/** `undefined` is Automatic; an empty list syncs with no trackers. */
function TrackersField({
  choices,
  value,
  onChange,
  automatic,
  note,
  loading,
  maxTrackers,
}: {
  choices: TrackerChoice[];
  value: string[] | undefined;
  onChange: (value: string[] | undefined) => void;
  automatic: string;
  note?: string;
  loading: boolean;
  maxTrackers?: number;
}) {
  const toggle = (id: string) => {
    const current = value ?? [];
    onChange(
      current.includes(id) ? current.filter((v) => v !== id) : [...current, id]
    );
  };
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">Trackers</p>
      <p className="text-xs text-[--muted]">
        {!value
          ? automatic
          : value.length
            ? 'Syncs only with the tracker addons picked.'
            : 'Syncs with no trackers.'}
      </p>
      {loading ? (
        <p className="text-xs text-[--muted]">Loading tracker addons…</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className={pill(value === undefined)}
          >
            Automatic
          </button>
          <button
            type="button"
            onClick={() => onChange([])}
            className={pill(!!value && !value.length)}
          >
            None
          </button>
          {choices.map((choice) => {
            const selected = !!value?.includes(choice.presetId);
            return (
              <button
                key={choice.presetId}
                type="button"
                disabled={!selected && !!choice.takenBy}
                onClick={() => toggle(choice.presetId)}
                className={cn(
                  pill(selected),
                  'disabled:cursor-not-allowed disabled:opacity-50'
                )}
                title={
                  choice.takenBy
                    ? `${choice.takenBy} syncs with this tracker`
                    : undefined
                }
              >
                {choice.addon}
                {choice.takenBy && (
                  <span className="ml-1 opacity-60">{choice.takenBy}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {note && <p className="text-xs text-[--muted]">{note}</p>}
      {maxTrackers !== undefined && value && value.length > maxTrackers && (
        <p className="text-xs text-[--orange]">
          This instance syncs each user with at most {maxTrackers} trackers, so
          only {maxTrackers} of these are used.
        </p>
      )}
      <p className="text-xs text-[--muted]">
        A tracker syncs with one history at a time, unless it keeps each user
        apart, and moving it to another user brings along what it already
        recorded.{' '}
        {!loading && !choices.length
          ? 'No tracker addons in your saved configuration yet; add one and save.'
          : 'Added a tracker addon? Save, and it shows here.'}
      </p>
    </div>
  );
}

/** Jellyfin clients show these as users of the server. */
const PIN_SHAPE = /^\d{4,12}$/;
/** Must match the server's floor for signing in with a PIN alone. */
const PIN_ONLY_LENGTH = 6;
const PIN_ONLY_SHAPE = new RegExp(`^\\d{${PIN_ONLY_LENGTH},12}$`);

/** A saved PIN or password comes back as its hash, never as typed. */
function isSavedPin(lock: string | undefined): lock is string {
  return !!lock && lock.startsWith('$2');
}

/** Must match the server's floor for a user's own password. */
const PASSWORD_MIN = 8;

/** A PIN or password: shown as set once saved, and changed or removed from there. */
function SecretField({
  label,
  value,
  onChange,
  help,
  placeholder,
  numeric,
}: {
  label: string;
  value: string | undefined;
  onChange(value: string | undefined): void;
  help: string;
  placeholder: string;
  numeric?: boolean;
}) {
  const [saved] = useState(isSavedPin(value) ? value : undefined);
  const [mode, setMode] = useState<'saved' | 'edit' | 'removed'>(
    saved ? 'saved' : 'edit'
  );

  if (mode !== 'edit') {
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-[--muted]">
            {mode === 'saved' ? 'Set. ' + help : 'Removed when you save.'}
          </p>
        </div>
        <div className="flex flex-none gap-2">
          {mode === 'saved' ? (
            <>
              <Button
                size="sm"
                intent="gray-outline"
                rounded
                onClick={() => setMode('edit')}
              >
                Change
              </Button>
              <Button
                size="sm"
                intent="alert-subtle"
                rounded
                onClick={() => {
                  setMode('removed');
                  onChange(undefined);
                }}
              >
                Remove
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              intent="gray-outline"
              rounded
              onClick={() => {
                setMode('saved');
                onChange(saved);
              }}
            >
              Undo
            </Button>
          )}
        </div>
      </div>
    );
  }
  return (
    <TextInput
      label={label}
      type="password"
      inputMode={numeric ? 'numeric' : undefined}
      autoComplete="new-password"
      placeholder={saved ? 'Unchanged' : 'None'}
      help={`${placeholder} ${help}`}
      value={isSavedPin(value) ? '' : (value ?? '')}
      onValueChange={(typed) => {
        const next = numeric ? typed.replace(/\D/g, '').slice(0, 12) : typed;
        onChange(next || saved);
      }}
    />
  );
}

function PinField({
  value,
  onChange,
  help = 'Signing in as this user needs it, typed after the password as password/PIN. Anyone who can edit this configuration can still change or remove it.',
}: {
  value: string | undefined;
  onChange(value: string | undefined): void;
  help?: string;
}) {
  return (
    <SecretField
      label="PIN"
      numeric
      placeholder="Optional, 4 to 12 digits."
      value={value}
      onChange={onChange}
      help={help}
    />
  );
}

function PasswordField({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange(value: string | undefined): void;
}) {
  return (
    <SecretField
      label="Password"
      placeholder={`Optional, at least ${PASSWORD_MIN} characters.`}
      value={value}
      onChange={onChange}
      help="Their own, for the web app and Jellyfin apps, so they never need the configuration's. They can change it from their profile."
    />
  );
}

/** A typed password too short to save, as saved ones are hashes. */
const shortPassword = (password: string | undefined) =>
  !!password && !password.startsWith('$2') && password.length < PASSWORD_MIN;

const errorText = (error: unknown, fallback: string) =>
  error instanceof APIError && error.detail
    ? error.detail
    : error instanceof Error
      ? error.message
      : fallback;

function inviteState(invite: UserInvite | undefined): string {
  if (!invite) return 'No link sent yet.';
  if (invite.usedAt) return 'Set up. A new link lets them pick a new password.';
  if (invite.expiresAt <= Date.now()) return 'The last link expired.';
  return `A link is out, until ${new Date(invite.expiresAt).toLocaleDateString()}.`;
}

/**
 * A link that signs someone in as their user until they have picked a
 * password, which is also how a forgotten one is reset.
 */
function SetupLinkModal({
  credentials,
  persona,
  invite,
  onClose,
}: {
  credentials: Credentials;
  persona: Persona;
  invite: UserInvite | undefined;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState<string | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: ['user-invites', credentials.uuid],
    });
  const create = useMutation({
    mutationFn: () => createUserInvite(credentials, persona.id),
    onSuccess: ({ url }) => {
      setUrl(url);
      void refresh();
    },
    onError: (error) =>
      toast.error(errorText(error, 'Failed to make the link')),
  });
  const revoke = useMutation({
    mutationFn: () => revokeUserInvite(credentials, persona.id),
    onSuccess: () => {
      setUrl(null);
      toast.info('Link turned off.');
      void refresh();
    },
    onError: (error) => toast.error(errorText(error, 'Failed to turn it off')),
  });
  const pending = !!invite && !invite.usedAt && invite.expiresAt > Date.now();
  const copy = (value: string) =>
    copyToClipboard(value, {
      onSuccess: () => toast.success('Link copied to clipboard'),
      onError: () => toast.error('Failed to copy link'),
    });

  return (
    <Modal open onOpenChange={onClose} title={`Set up ${persona.name}`}>
      <div className="space-y-4">
        <p className="text-sm text-[--muted]">
          Send this to {persona.name}. It signs them in once, without a
          password, and walks them through their name, picture, preferences and
          a password of their own. It works for 7 days, until they finish.
        </p>
        <p className="text-sm">{inviteState(invite)}</p>
        {url && (
          <TextInput
            label="Setup link"
            value={url}
            readOnly
            onFocus={(e) => e.currentTarget.select()}
            help="Shown once. Making another turns this one off."
          />
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {pending && (
            <Button
              size="sm"
              intent="alert-subtle"
              rounded
              loading={revoke.isPending}
              onClick={() => revoke.mutate()}
            >
              Turn off
            </Button>
          )}
          {url ? (
            <Button
              size="sm"
              intent="white"
              rounded
              onClick={() => void copy(url)}
            >
              Copy
            </Button>
          ) : (
            <Button
              size="sm"
              intent="white"
              rounded
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              {invite ? 'New link' : 'Make link'}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** A picture's address, or one uploaded here, which needs a saved configuration. */
function AvatarField({
  credentials,
  value,
  onChange,
}: {
  credentials: Credentials | null;
  value: string | undefined;
  onChange: (avatar: string | undefined) => void;
}) {
  const input = React.useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async (file: File) =>
      uploadUserAvatar(credentials!, await avatarImage(file)),
    onSuccess: ({ url }) => onChange(url),
    onError: (error) => toast.error(errorText(error, 'Failed to upload')),
  });
  return (
    <div className="flex items-end gap-2">
      <TextInput
        label="Avatar"
        help="Optional. Shown on the sign-in picker. Paste an image address or upload one."
        placeholder="https://"
        value={value ?? ''}
        onValueChange={(v) => onChange(v || undefined)}
        fieldClass="flex-1"
      />
      {credentials && (
        <>
          <Button
            type="button"
            intent="gray-outline"
            leftIcon={<FiUpload />}
            loading={upload.isPending}
            onClick={() => input.current?.click()}
          >
            Upload
          </Button>
          <input
            ref={input}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) upload.mutate(file);
            }}
          />
        </>
      )}
    </div>
  );
}

export function JellyfinPersonas() {
  const { userData, setUserData, uuid, password } = useUserData();
  const credentials = React.useMemo(
    () => (uuid ? { uuid, password } : null),
    [uuid, password]
  );
  const trackerQuery = useQuery(watchStateTrackersQuery(credentials));
  const inviteQuery = useQuery({
    queryKey: ['user-invites', uuid],
    queryFn: () => listUserInvites(credentials!),
    enabled: !!credentials,
  });
  const [inviting, setInviting] = useState<Persona | null>(null);
  const trackerSync =
    !trackerQuery.data || trackerQuery.data.push || trackerQuery.data.pull;
  const trackerOptions = trackerQuery.data?.available ?? NO_TRACKER_OPTIONS;
  const trackersLoading = !!credentials && trackerQuery.isPending;
  const { status } = useStatus();
  const maxPersonas =
    status?.settings?.jellyfin?.maxPersonas ?? DEFAULT_MAX_PERSONAS;
  const maxTrackers = status?.settings?.jellyfin?.maxTrackers;
  const pinSignIn = status?.settings?.jellyfin?.pinSignIn ?? false;
  const baseUrl = status?.settings?.baseUrl || window.location.origin;
  const personas = userData.jellyfin?.personas ?? [];
  const primary = userData.jellyfin?.primary;
  const primaryName = primary?.name || userData.addonName || 'Primary user';
  const variants: VariantOptionList = (userData.variants ?? [])
    .filter((v) => v.enabled !== false)
    .map((v) => ({
      id: v.id,
      name: v.name,
      enabled: v.enabled,
      when: v.when ? String(v.when) : undefined,
    }));
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Persona | null>(null);
  const [primaryDraft, setPrimaryDraft] = useState<Primary | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<number | null>(null);

  const shared = new Set(
    trackerOptions.filter((o) => o.viewers).map((o) => o.presetId)
  );

  /** Other users' trackers; `automatic` adds an automatic primary user's. */
  const takenFor = (index: number | null, automatic: boolean) => {
    const taken = new Map<string, string>();
    if (index !== null) {
      const held = primary?.trackers
        ? primary.trackers
        : automatic
          ? trackerOptions.filter((o) => o.user === '').map((o) => o.presetId)
          : [];
      for (const id of held) if (!shared.has(id)) taken.set(id, primaryName);
    }
    personas.forEach((persona, i) => {
      if (i === index || persona.history === 'shared') return;
      for (const id of persona.trackers ?? [])
        if (!shared.has(id) && !taken.has(id)) taken.set(id, persona.name);
    });
    return taken;
  };

  const choicesFor = (user: string, taken: Map<string, string>) => {
    const own = trackerOptions.filter((o) => o.user === user);
    // A user not saved yet can pick what the primary user can.
    const options = own.length
      ? own
      : trackerOptions.filter((o) => o.user === '');
    return options.map((o) => ({ ...o, takenBy: taken.get(o.presetId) }));
  };

  const addonName = (presetId: string) =>
    trackerOptions.find((o) => o.presetId === presetId)?.addon ?? presetId;

  const patch = (values: Partial<JellyfinSettings>) =>
    setUserData((prev) => ({
      ...prev,
      jellyfin: { ...prev.jellyfin, ...values },
    }));

  const rows = useSortableRows(personas, (next) => patch({ personas: next }));

  const close = () => {
    setEditing(null);
    setDraft(null);
  };

  const openAdd = () => {
    if (personas.length >= maxPersonas) {
      toast.error(`At most ${maxPersonas} users.`);
      return;
    }
    setDraft({ id: '', name: '', history: 'own' });
    setEditing(personas.length);
  };

  const commit = () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      toast.error('A user needs a name.');
      return;
    }
    if (UUID_SHAPE.test(name)) {
      toast.error('A name cannot look like a configuration id.');
      return;
    }
    if (
      sameName(name, primaryName) ||
      personas.some((p, i) => sameName(p.name, name) && i !== editing)
    ) {
      toast.error('Another user already has this name.');
      return;
    }
    const known = new Set(variants.map((v) => v.id));
    if ((draft.variants ?? []).some((id) => !known.has(id))) {
      toast.error('A linked variant no longer exists or is disabled.');
      return;
    }
    if (draft.lock && !isSavedPin(draft.lock) && !PIN_SHAPE.test(draft.lock)) {
      toast.error('A PIN is 4 to 12 digits.');
      return;
    }
    if (shortPassword(draft.password)) {
      toast.error(`A password is at least ${PASSWORD_MIN} characters.`);
      return;
    }
    if (
      pinSignIn &&
      draft.lock &&
      !isSavedPin(draft.lock) &&
      !PIN_ONLY_SHAPE.test(draft.lock)
    ) {
      toast.warning(
        `A PIN under ${PIN_ONLY_LENGTH} digits cannot sign in without your password.`
      );
    }
    const trackers = draft.history === 'shared' ? undefined : draft.trackers;
    const taken = takenFor(editing, false);
    const clash = trackers?.find((id) => taken.has(id));
    if (clash) {
      toast.error(
        `${taken.get(clash)} already syncs with ${addonName(clash)}.`
      );
      return;
    }
    const next = [...personas];
    const value: Persona = {
      ...draft,
      id: draft.id || idFor(name, personas),
      name,
      avatar: draft.avatar?.trim() || undefined,
      variants: draft.variants?.length ? draft.variants : undefined,
      trackers,
      hidden: draft.hidden || undefined,
      address: draft.hidden ? (draft.address ?? newAddress()) : undefined,
      lock: draft.lock || undefined,
      password: draft.password || undefined,
    };
    if (editing !== null && editing < personas.length) next[editing] = value;
    else next.push(value);
    patch({ personas: next });
    close();
  };

  const commitPrimary = () => {
    if (!primaryDraft) return;
    if (
      primaryDraft.lock &&
      !isSavedPin(primaryDraft.lock) &&
      !PIN_SHAPE.test(primaryDraft.lock)
    ) {
      toast.error('A PIN is 4 to 12 digits.');
      return;
    }
    if (shortPassword(primaryDraft.password)) {
      toast.error(`A password is at least ${PASSWORD_MIN} characters.`);
      return;
    }
    const name = primaryDraft.name?.trim() || '';
    if (name && personas.some((p) => sameName(p.name, name))) {
      toast.error('Another user already has this name.');
      return;
    }
    const taken = takenFor(null, false);
    const clash = primaryDraft.trackers?.find((id) => taken.has(id));
    if (clash) {
      toast.error(
        `${taken.get(clash)} already syncs with ${addonName(clash)}.`
      );
      return;
    }
    if (
      !primaryDraft.trackers &&
      personas.some(
        (p) =>
          p.history !== 'shared' && p.trackers?.some((id) => !shared.has(id))
      )
    ) {
      toast.warning(
        'Trackers picked for other users stay unused while the primary user syncs with every tracker.'
      );
    }
    const value: Primary = {
      name: name || undefined,
      avatar: primaryDraft.avatar?.trim() || undefined,
      variants: primaryDraft.variants?.length
        ? primaryDraft.variants
        : undefined,
      trackers: primaryDraft.trackers,
      hidden: primaryDraft.hidden || undefined,
      lock: primaryDraft.lock || undefined,
      password: primaryDraft.password || undefined,
    };
    patch({ primary: Object.values(value).some(Boolean) ? value : undefined });
    setPrimaryDraft(null);
  };

  const remove = (index: number) => {
    if (personas.length > 1) rows.removeAt(index);
    else patch({ personas: undefined });
    toast.info('Removed. A user with the same name gets its history back.');
  };

  const removalTarget =
    pendingRemoval !== null ? personas[pendingRemoval] : undefined;
  const removeDialog = useConfirmationDialog({
    title: 'Remove user',
    description: removalTarget
      ? `${removalTarget.name} will stop appearing on the sign-in picker once you save. ${
          removalTarget.history === 'shared'
            ? 'It shares the primary user’s history, so nothing is lost.'
            : 'Its watch history is kept, and a user added again under the same name gets it back.'
        }`
      : undefined,
    actionText: 'Remove',
    onConfirm: () => {
      if (pendingRemoval !== null) remove(pendingRemoval);
      setPendingRemoval(null);
    },
  });

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-400">
        Shown as users of the server. A user with a password of their own signs
        in with it; the rest use this configuration&apos;s password, and a user
        with a PIN also needs that, typed after the password as password/PIN.
        The primary user is this configuration itself; each other user can keep
        a history and trackers of its own. Drag a user to change where it sits
        on the sign-in picker; the primary user is always listed first.
        {pinSignIn &&
          ` On the sign-in picker address, a user with a PIN of ${PIN_ONLY_LENGTH} or more digits can sign in with that PIN alone, so each person needs only their own PIN.`}
      </p>

      <DndContext {...rows.dndProps}>
        <ul className="divide-y divide-gray-800 rounded-md border border-gray-800">
          <li>
            <UserRow
              name={primaryName}
              avatar={primary?.avatar}
              summary={[
                'Primary user',
                variantsLabel(primary?.variants),
                primary?.trackers
                  ? trackersLabel(primary.trackers)
                  : 'all trackers',
                primary?.hidden ? 'hidden from the picker' : null,
                primary?.lock ? 'PIN' : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              onEdit={() => setPrimaryDraft({ ...primary })}
            />
          </li>
          <SortableContext
            items={rows.sortableIds}
            strategy={verticalListSortingStrategy}
          >
            {personas.map((persona, index) => (
              <SortableUserRow
                key={rows.keyAt(index)}
                id={rows.keyAt(index)}
                name={persona.name}
                avatar={persona.avatar}
                summary={[
                  variantsLabel(persona.variants),
                  persona.history === 'shared'
                    ? "shares the primary user's history"
                    : 'own history',
                  persona.history !== 'shared' && persona.trackers
                    ? trackersLabel(persona.trackers)
                    : null,
                  persona.history !== 'shared' &&
                  persona.id !== slugOf(persona.name)
                    ? `tracker id ${persona.id}`
                    : null,
                  persona.hidden ? 'kept separate' : null,
                  persona.lock ? 'PIN' : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                onEdit={() => {
                  setDraft({
                    ...persona,
                    address: persona.hidden
                      ? (persona.address ?? newAddress())
                      : undefined,
                  });
                  setEditing(index);
                }}
                onInvite={credentials ? () => setInviting(persona) : undefined}
                onDelete={() => {
                  setPendingRemoval(index);
                  removeDialog.open();
                }}
              />
            ))}
          </SortableContext>
        </ul>
      </DndContext>

      <div className="flex flex-wrap items-center gap-3">
        {maxPersonas > 0 ? (
          <Button
            size="sm"
            intent="white"
            rounded
            leftIcon={<FiPlus />}
            onClick={openAdd}
            disabled={personas.length >= maxPersonas}
          >
            Add user
          </Button>
        ) : (
          <span className="text-xs text-[--muted]">
            This instance does not allow extra users.
          </span>
        )}
        {personas.length > 0 && (
          <span className="text-xs text-[--muted]">
            {personas.length} of {maxPersonas}
          </span>
        )}
      </div>

      {primaryDraft && (
        <Modal
          open
          onOpenChange={() => setPrimaryDraft(null)}
          title="Primary user"
        >
          <div className="space-y-4">
            <TextInput
              label="Name"
              help="Shown in apps. Defaults to your addon name."
              placeholder={userData.addonName || 'Primary user'}
              value={primaryDraft.name ?? ''}
              onValueChange={(value) =>
                setPrimaryDraft({ ...primaryDraft, name: value || undefined })
              }
            />
            <VariantsField
              variants={variants}
              value={primaryDraft.variants ?? []}
              onChange={(value) =>
                setPrimaryDraft({
                  ...primaryDraft,
                  variants: value.length ? value : undefined,
                })
              }
            />
            {trackerSync && (
              <TrackersField
                choices={choicesFor('', takenFor(null, true))}
                value={primaryDraft.trackers}
                onChange={(trackers) =>
                  setPrimaryDraft({ ...primaryDraft, trackers })
                }
                automatic="Syncs with every tracker addon."
                loading={trackersLoading}
                maxTrackers={maxTrackers}
              />
            )}
            <AvatarField
              credentials={credentials}
              value={primaryDraft.avatar}
              onChange={(avatar) =>
                setPrimaryDraft({ ...primaryDraft, avatar })
              }
            />
            <Switch
              label="Hide from the sign-in picker"
              help="Still signs in by name. Other users can't switch to it."
              side="right"
              value={primaryDraft.hidden ?? false}
              onValueChange={(value) =>
                setPrimaryDraft({ ...primaryDraft, hidden: value || undefined })
              }
            />
            <PasswordField
              value={primaryDraft.password}
              onChange={(password) =>
                setPrimaryDraft({ ...primaryDraft, password })
              }
            />
            <PinField
              value={primaryDraft.lock}
              onChange={(lock) => setPrimaryDraft({ ...primaryDraft, lock })}
              help="Needed every time someone signs in as the primary user, even with your configuration password (typed after it as password/PIN), and asked whenever someone switches to it in the web app, so other users can't reach your history. Anyone who can edit this configuration can still change or remove it."
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                intent="primary-subtle"
                onClick={() => setPrimaryDraft(null)}
              >
                Cancel
              </Button>
              <Button size="sm" intent="primary" onClick={commitPrimary}>
                Save
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {draft && (
        <Modal open onOpenChange={close} title="User">
          <div className="space-y-4">
            <TextInput
              label="Name"
              help="Shown in apps, and typed to sign in."
              value={draft.name}
              onValueChange={(value) => setDraft({ ...draft, name: value })}
            />

            <Select
              label="History"
              help="Own: a separate Continue Watching. Shared: the primary user's."
              moreHelp="Sharing the primary user's history means sharing its trackers too. With its own history, a user syncs with the trackers chosen for it."
              value={draft.history}
              onValueChange={(value) =>
                setDraft({
                  ...draft,
                  history: value as Persona['history'],
                  trackers: value === 'shared' ? undefined : draft.trackers,
                })
              }
              options={[
                { label: 'Own', value: 'own' },
                { label: 'Shared with the primary user', value: 'shared' },
              ]}
            />

            <VariantsField
              variants={variants}
              value={draft.variants ?? []}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  variants: value.length ? value : undefined,
                })
              }
            />

            {trackerSync && draft.history !== 'shared' && (
              <TrackersField
                choices={choicesFor(draft.id, takenFor(editing, true))}
                value={draft.trackers}
                onChange={(trackers) => setDraft({ ...draft, trackers })}
                automatic="Syncs with a tracker addon its variants add, and with any that keeps each user apart."
                note={
                  primary?.trackers
                    ? undefined
                    : 'The primary user syncs with every tracker. Choose its trackers to free the rest.'
                }
                loading={trackersLoading}
                maxTrackers={maxTrackers}
              />
            )}

            <AvatarField
              credentials={credentials}
              value={draft.avatar}
              onChange={(avatar) => setDraft({ ...draft, avatar })}
            />

            <Switch
              label="Keep separate from other users"
              help="Left off the sign-in picker and other users' lists, and sees no one else. Signs in on an address of its own."
              side="right"
              value={draft.hidden ?? false}
              onValueChange={(value) =>
                setDraft({
                  ...draft,
                  hidden: value || undefined,
                  address: value ? newAddress() : undefined,
                })
              }
            />
            {draft.hidden && draft.address && (
              <PersonalAddress
                url={`${baseUrl}/jellyfin/p/${draft.address}`}
                pinSignIn={pinSignIn}
                onRenew={() => setDraft({ ...draft, address: newAddress() })}
              />
            )}

            <PasswordField
              value={draft.password}
              onChange={(password) => setDraft({ ...draft, password })}
            />
            <PinField
              value={draft.lock}
              onChange={(lock) => setDraft({ ...draft, lock })}
              help={
                pinSignIn
                  ? `Signing in as this user needs it, typed after the password as password/PIN. On the sign-in picker or the user's own address, a PIN of ${PIN_ONLY_LENGTH} or more digits also works on its own, without your configuration password. Anyone who can edit this configuration can still change or remove it.`
                  : undefined
              }
            />

            <div className="flex items-center justify-end gap-2">
              <Button size="sm" intent="primary-subtle" onClick={close}>
                Cancel
              </Button>
              <Button size="sm" intent="primary" onClick={commit}>
                Save
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {inviting && credentials && (
        <SetupLinkModal
          credentials={credentials}
          persona={inviting}
          invite={inviteQuery.data?.find((i) => i.persona === inviting.id)}
          onClose={() => setInviting(null)}
        />
      )}

      <ConfirmationDialog {...removeDialog} />
    </div>
  );
}
