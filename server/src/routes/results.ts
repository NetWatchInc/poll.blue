import type { Context } from "hono";
import { query } from "../db.ts";
import { isPublicId, pollUriFromId } from "../poll-id.ts";

// GET /api/poll/:id → results JSON (consumed by the results page)
export async function getResults(c: Context) {
  const id = c.req.param("id") ?? "";

  // Unified poll (did~rkey): the question/options come from the repo record
  // (fetched client-side); we only own the vote counts. Return a sparse
  // {option → count} map and let the client shape it against the record.
  if (isPublicId(id)) {
    const pollUri = pollUriFromId(id);
    if (!pollUri) return c.json({ error: "invalid id" }, 400);
    const r = await query<{ vote: number; n: number }>(
      `SELECT vote, count(*)::int AS n FROM votes WHERE poll_uri = $1 GROUP BY vote`,
      [pollUri],
    );
    const tallies: Record<string, number> = {};
    for (const row of r.rows) tallies[String(row.vote)] = row.n;
    return c.json({ central: true, tallies });
  }

  const r = await query(
    `SELECT posted_by, created_at, post_uri, question, answers, results
     FROM polls WHERE visible_id = $1`,
    [id],
  );
  if (r.rows.length === 0) return c.json({ error: `Poll ${id} not found` }, 404);
  return c.json(r.rows[0]);
}
