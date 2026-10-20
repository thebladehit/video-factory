import { createDb } from './client';
import { seed } from './seed';

const { db, close } = createDb(process.env.DATABASE_URL!);
await seed(db);
await close();
console.log('Seed виконано');
