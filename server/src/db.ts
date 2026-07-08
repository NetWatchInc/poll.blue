import { readFileSync } from "node:fs";
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

// Apply the (idempotent) schema on startup so a fresh or partially-migrated
// database self-heals — every statement in schema.sql is CREATE/ALTER ... IF NOT
// EXISTS, so this is safe to run on every boot. This is what adds columns like
// `blue_poll_uri` to an existing production DB that predates them. schema.sql
// ships alongside the compiled server (Dockerfile `COPY server/ ./`), one level
// up from this module.
export async function migrate(): Promise<void> {
  const sql = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  await pool.query(sql);
}

export interface DbPoll {
  id: number;
  post_uri: string | null;
  posted_by: string | null;
  created_at: string;
  question: string;
  answers: string[];
  results: number[];
  results_posted: boolean;
  blue_poll_uri: string | null;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}
