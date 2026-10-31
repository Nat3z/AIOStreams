import { z } from 'zod';
import { seconds } from './helpers.js';
import type { RuntimeConfigSection } from '../types.js';

/** Links that let someone without an account watch one title on a user's configuration. */
export const guestPassesSchema = {
  enabled: {
    schema: z.boolean(),
    default: false,
    label: 'Guest passes',
    description:
      "Lets users share one movie or show with someone who has no account, by a link that expires. A guest's streams always go through the configuration's proxy, so this server carries their bandwidth and the debrid service only ever sees the proxy's address. A configuration without a proxy can't make one.",
    env: 'GUEST_PASSES',
    requiresRestart: false,
    secret: false,
  },
  maxActive: {
    schema: z.number().int().min(1),
    default: 5,
    label: 'Passes per configuration',
    description: 'Unexpired passes a configuration holds at once.',
    env: 'GUEST_PASS_MAX_ACTIVE',
    requiresRestart: false,
    secret: false,
    ui: { min: 1 },
  },
  maxLifetimeSeconds: {
    schema: seconds,
    default: 7 * 24 * 3600,
    label: 'Longest lifetime',
    description:
      'The longest a pass may last. A stream already playing when it expires plays on; nothing new starts.',
    env: 'GUEST_PASS_MAX_LIFETIME',
    requiresRestart: false,
    secret: false,
    ui: { kind: 'duration' },
  },
  maxStreams: {
    schema: z.number().int().min(1).max(10),
    default: 5,
    label: 'Devices per pass',
    description:
      'The most devices one pass plays on at once. Each pass sets its own number, up to this.',
    env: 'GUEST_PASS_MAX_STREAMS',
    requiresRestart: false,
    secret: false,
    ui: { min: 1, max: 10 },
  },
} as const satisfies RuntimeConfigSection;
