/*
 * What a signed-in user may change about themselves in the configuration
 * they share: their own face, credentials, a short list of stream
 * preferences and the addons they linked. Everything else stays the owner's.
 *
 * Each user's preferences and linked addons live in one variant of their own,
 * `self-<id>`, applied after the owner's variants, so the owner's choices are
 * the defaults and the user's sit on top.
 */
import { z } from 'zod';
import {
  UserRepository,
  isProfileLockHash,
  USER_PASSWORD_MIN,
  type Profile,
  type UserData,
} from '../db/index.js';
import {
  constants,
  createLogger,
  getSimpleTextHash,
  isOwner,
  OWNER_ID,
  profilesOf,
} from '../utils/index.js';
import {
  isSelfVariant,
  SELF_VARIANT_MARKER as STATE_MARKER,
} from '../variants/language.js';

const logger = createLogger('jellyfin');

/**
 * `self` for the owner and `self-<id>` for another profile, hashed when the id
 * would not fit, so no two profiles can land on the same variant.
 */
export function selfVariantId(profile: Pick<Profile, 'id'>): string {
  if (isOwner(profile)) return 'self';
  const id =
    profile.id.length <= 27
      ? profile.id
      : getSimpleTextHash(profile.id).slice(0, 27);
  return `self-${id}`;
}

const SELF_RESOLUTIONS = ['2160p', '1440p', '1080p', '720p'] as const;
const LANGUAGE = z.enum(constants.LANGUAGES);

/** The stream preferences a user may set; absent leaves the owner's. */
export const SelfPreferencesSchema = z.object({
  maxResolution: z.enum(SELF_RESOLUTIONS).optional(),
  skipHdr: z.boolean().optional(),
  languages: z.array(LANGUAGE).max(5).optional(),
  /** Bytes. */
  maxMovieSize: z.number().int().positive().optional(),
  maxEpisodeSize: z.number().int().positive().optional(),
  resultLimit: z.number().int().min(1).max(100).optional(),
});

export type SelfPreferences = z.infer<typeof SelfPreferencesSchema>;

/** An addon linked by the user, by the manifest it installs from. */
export const SelfAddonSchema = z.object({
  /** Which integration linked it, so unlinking finds it again. */
  source: z.string().regex(/^[a-z0-9-]{1,32}$/),
  name: z.string().min(1).max(64),
  manifestUrl: z.string().url().max(2048),
  /** Whether it tracks plays, so it is picked as the user's tracker. */
  tracker: z.boolean(),
  /** Limits what is used from it; absent uses everything it serves. */
  resources: z.array(z.enum(constants.RESOURCES)).optional(),
});

export type SelfAddon = z.infer<typeof SelfAddonSchema>;

export interface SelfState {
  preferences: SelfPreferences;
  addons: SelfAddon[];
}

/** The script that applies a user's own state, with the state itself kept as its first line. */
function scriptFor(profile: Profile, state: SelfState): string {
  const lines = [STATE_MARKER + JSON.stringify(state)];
  const p = state.preferences;
  if (p.maxResolution) {
    const max = SELF_RESOLUTIONS.indexOf(p.maxResolution);
    for (const res of SELF_RESOLUTIONS.slice(0, max)) {
      lines.push(`add excludedResolutions ${JSON.stringify(res)}`);
    }
  }
  if (p.skipHdr) {
    for (const tag of ['DV', 'HDR', 'HDR10', 'HDR10+', 'HLG']) {
      lines.push(`add excludedVisualTags ${JSON.stringify(tag)}`);
    }
  }
  if (p.languages?.length) {
    lines.push(`set preferredLanguages = ${JSON.stringify(p.languages)}`);
  }
  if (p.maxMovieSize) {
    lines.push(`set size.global.movies = [0, ${p.maxMovieSize}]`);
  }
  if (p.maxEpisodeSize) {
    lines.push(`set size.global.series = [0, ${p.maxEpisodeSize}]`);
  }
  if (p.resultLimit) {
    lines.push(`set resultLimits.global = ${p.resultLimit}`);
  }
  // Instance ids are pinned so the user's tracker pick can name them.
  for (const addon of state.addons) {
    const preset = presetFor(addon, selfAddonInstanceId(profile, addon.source));
    lines.push(`add presets ${JSON.stringify(preset)}`);
  }
  return lines.join('\n');
}

/** Stable per source, so the tracker pick survives a relink. */
export function selfAddonInstanceId(
  profile: Pick<Profile, 'id'>,
  source: string
): string {
  return `${selfVariantId(profile)}~${source}`;
}

function presetFor(addon: SelfAddon, instanceId: string) {
  return {
    type: 'custom',
    instanceId,
    enabled: true,
    options: {
      name: addon.name,
      manifestUrl: addon.manifestUrl,
      ...(addon.resources && { resources: addon.resources }),
    },
  };
}

function readState(userData: UserData, id: string): SelfState {
  const script = userData.variants?.find((v) => v.id === id)?.script ?? '';
  const first = script.split('\n', 1)[0] ?? '';
  if (first.startsWith(STATE_MARKER)) {
    try {
      const raw = JSON.parse(first.slice(STATE_MARKER.length));
      return {
        preferences: SelfPreferencesSchema.parse(raw.preferences ?? {}),
        addons: z.array(SelfAddonSchema).parse(raw.addons ?? []),
      };
    } catch (error) {
      logger.warn({ variant: id }, 'unreadable self-service state, reset');
    }
  }
  return { preferences: {}, addons: [] };
}

/** The profile as stored, the owner included, or null when it no longer exists. */
function storedProfile(userData: UserData, profileId: string): Profile | null {
  userData.profiles ??= [];
  const found = userData.profiles.find((p) => p.id === profileId);
  if (found) return found;
  if (profileId !== OWNER_ID) return null;
  // The owner is first, even before it has anything stored.
  const owner: Profile = { id: OWNER_ID };
  userData.profiles.unshift(owner);
  return owner;
}

/** Drops the own variants of profiles removed from the configuration. */
export function pruneSelfVariants(userData: UserData): void {
  const live = new Set(profilesOf(userData).map((p) => selfVariantId(p)));
  userData.variants = userData.variants?.filter(
    (v) => !isSelfVariant(v) || live.has(v.id)
  );
}

export function selfStateOf(
  userData: UserData,
  profile: Pick<Profile, 'id'>
): SelfState {
  return readState(userData, selfVariantId(profile));
}

export interface SelfProfilePatch {
  name?: string;
  avatar?: string | null;
  /** A new PIN, or null to remove it. */
  pin?: string | null;
  password?: string;
  preferences?: SelfPreferences;
  /** Replaces the addons linked from `source`. */
  addons?: { source: string; addons: SelfAddon[] };
}

/** Runs tasks sharing a key one after another, within this process. */
export function serialQueue(): <T>(
  key: string,
  task: () => Promise<T>
) => Promise<T> {
  const queues = new Map<string, Promise<unknown>>();
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
  };
}

// One edit at a time per configuration, so two users saving together both land.
const serialised = serialQueue();

/**
 * Applies a user's change to their own part of the configuration and saves it.
 * `configPassword` is the configuration's, which the user's session carries.
 */
export function updateSelf(
  uuid: string,
  configPassword: string,
  profileId: string,
  patch: SelfProfilePatch
): Promise<void> {
  return serialised(uuid, async () => {
    const { userData, revision } = await UserRepository.getRawUserWithRevision(
      uuid,
      configPassword
    );
    const user = storedProfile(userData, profileId);
    if (!user)
      throw new constants.APIError(constants.ErrorCode.USER_INVALID_DETAILS);

    if (patch.name !== undefined) user.name = patch.name;
    if (patch.avatar !== undefined) user.avatar = patch.avatar ?? undefined;
    if (patch.pin !== undefined) user.lock = patch.pin ?? undefined;
    if (patch.password !== undefined) {
      if (
        patch.password.length < USER_PASSWORD_MIN ||
        isProfileLockHash(patch.password)
      ) {
        throw new constants.APIError(
          constants.ErrorCode.BAD_REQUEST,
          undefined,
          `A password must be at least ${USER_PASSWORD_MIN} characters.`
        );
      }
      user.password = patch.password;
    }

    if (patch.preferences || patch.addons) {
      const id = selfVariantId(user);
      const state = readState(userData, id);
      if (patch.preferences) state.preferences = patch.preferences;
      if (patch.addons) {
        state.addons = [
          ...state.addons.filter((a) => a.source !== patch.addons!.source),
          ...patch.addons.addons,
        ];
      }
      writeSelfVariant(userData, user, id, state);
    }

    await UserRepository.updateUser(uuid, configPassword, userData, revision);
  });
}

function writeSelfVariant(
  userData: UserData,
  user: Profile,
  id: string,
  state: SelfState
): void {
  const empty =
    !state.addons.length &&
    !Object.values(state.preferences).some((v) => v !== undefined);
  const others = (userData.variants ?? []).filter((v) => v.id !== id);
  const chosen = (user.variants ?? []).filter((v) => v !== id);
  if (empty) {
    userData.variants = others;
    user.variants = chosen;
  } else {
    const script = scriptFor(user, state);
    userData.variants = [
      ...others,
      { id, name: `${user.name ?? 'Owner'} (own)`, script },
    ];
    // Last, so the user's own choices win over the owner's variants.
    user.variants = [...chosen, id];
  }

  // A linked tracker is the user's own history, so it is theirs alone.
  const trackerIds = state.addons
    .filter((a) => a.tracker)
    .map((a) => selfAddonInstanceId(user, a.source));
  const ownPrefix = `${id}~`;
  const kept = (user.trackers ?? []).filter((t) => !t.startsWith(ownPrefix));
  const trackers = [...kept, ...trackerIds];
  user.trackers = trackers.length || user.trackers ? trackers : undefined;
}
