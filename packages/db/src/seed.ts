import { LOCAL_USER_ID } from '@vf/shared';
import type { Db } from './client';
import { userSettings, users } from './schema';

export async function seed(db: Db): Promise<void> {
  await db.insert(users).values({ id: LOCAL_USER_ID, name: 'Локальний користувач' }).onConflictDoNothing();
  await db.insert(userSettings).values({ userId: LOCAL_USER_ID }).onConflictDoNothing();
}
