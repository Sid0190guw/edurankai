import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set in .env');

// One connection per process. Neon handles pooling on their side.
const client = postgres(connectionString, { prepare: false });

export const db = drizzle(client, { schema });
export { schema };
