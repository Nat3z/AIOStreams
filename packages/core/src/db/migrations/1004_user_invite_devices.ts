import type { Migration } from './types.js';

/** A hash of the secret the first browser to open a setup link keeps. */
const columns = (ine: string) => `
      ALTER TABLE user_invites ADD COLUMN ${ine}device TEXT;
`;

export const userInviteDevices: Migration = {
  id: 1004,
  name: 'user_invite_devices',
  up: {
    sqlite: columns(''),
    postgres: columns('IF NOT EXISTS '),
  },
};
