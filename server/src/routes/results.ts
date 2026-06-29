import type { Context } from "hono";
import { query } from "../db.ts";

// GET /api/poll/:id → results JSON (consumed by the results page)
export async function getResults(c: Context) {
  const id = c.req.param("id");
  const r = await query(
    `SELECT posted_by, created_at, post_uri, question, answers, results
     FROM polls WHERE visible_id = $1`,
    [id],
  );
  if (r.rows.length === 0) return c.json({ error: `Poll ${id} not found` }, 404);
  return c.json(r.rows[0]);
}
