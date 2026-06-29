import pg from "pg";
import { config } from "./config.ts";

// `ssl.rejectUnauthorized: false` matches the previous
// "--unsafely-ignore-certificate-errors" behaviour for the managed DB's cert.
function makePool(): pg.Pool {
  if (config.DATABASE_URL) {
    return new pg.Pool({
      connectionString: config.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,
    });
  }
  if (!config.PG_HOST || !config.PG_DATABASE || !config.PG_USERNAME) {
    throw new Error(
      "Database not configured: set DATABASE_URL, or PG_HOST + PG_DATABASE + PG_USERNAME.",
    );
  }
  return new pg.Pool({
    host: config.PG_HOST,
    port: config.PG_PORT,
    database: config.PG_DATABASE,
    user: config.PG_USERNAME,
    password: config.PG_PASSWORD,
    ssl: config.PG_SSL === "require" ? { rejectUnauthorized: false } : false,
    max: 10,
  });
}

export const pool = makePool();

export interface DbPoll {
  id: number;
  post_uri: string | null;
  posted_by: string | null;
  created_at: string;
  question: string;
  answers: string[];
  results: number[];
  results_posted: boolean;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}
