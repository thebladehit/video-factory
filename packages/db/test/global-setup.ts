import { config } from 'dotenv';
import { resolve } from 'node:path';
import { createDb, runMigrations, seed } from '../src/index';

// Один раз на весь прогін: мігрована й засіяна тестова БД для всіх int-тестів
export default async function setup() {
  config({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  await runMigrations(url);
  const { db, close } = createDb(url);
  await seed(db);
  await close();
}
