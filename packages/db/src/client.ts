import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;

export function createDb(url: string) {
  const client = postgres(url, { max: 10, onnotice: () => {}, connect_timeout: 5 });
  const db = drizzle(client, { schema });
  return {
    db,
    close: () => client.end({ timeout: 5 }),
    ping: async () => {
      await db.execute(sql`select 1`);
    },
  };
}
