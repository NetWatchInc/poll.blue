import pg from "pg";
import { config } from "./config.ts";

// A single shared pool. `ssl.rejectUnauthorized: false` matches the previous
// "--unsafely-ignore-certificate-errors" behaviour for the managed DB's cert.
export const pool = new pg.Pool({
  host: config.PG_HOST,
  port: config.PG_PORT,
  database: config.PG_DATABASE,
  user: config.PG_USERNAME,
  password: config.PG_PASSWORD,
  ssl: config.PG_SSL === "require" ? { rejectUnauthorized: false } : false,
  max: 10,
});

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
