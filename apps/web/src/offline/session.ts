// The signed-in user's profile, remembered on this device so the counter can
// carry on billing after a reload while the server is unreachable. Profile
// only: never a token or password. The refresh cookie is still what proves
// the session; it is checked as soon as the server answers, and a rejection
// logs the user out as usual. Forgotten on logout or an ended session.

import type { UserDto } from '@pharmacy/shared';
import { localDb, STORES } from './db';

const KEY = 'session-user';

type Record = { key: typeof KEY; user: UserDto; savedAt: string };

export const rememberedUser = {
  async get(): Promise<UserDto | null> {
    return (await localDb.get<Record>(STORES.meta, KEY))?.user ?? null;
  },
  save: (user: UserDto) =>
    localDb
      .put(STORES.meta, { key: KEY, user, savedAt: new Date().toISOString() } satisfies Record)
      .catch(() => undefined),
  forget: () => localDb.delete(STORES.meta, KEY).catch(() => undefined),
};
