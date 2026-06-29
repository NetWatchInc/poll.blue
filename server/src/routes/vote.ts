import type { Context } from "hono";
import { pool, query } from "../db.ts";
import { isDev } from "../config.ts";

// Map a dotted IPv4 to a value that fits the votes.ip `integer` column. `| 0`
// reinterprets the 32-bit value as a signed int32 (bijective) — fixes the old
// overflow for IPs >= 128.0.0.0 while staying one-vote-per-IP.
function ipToInt(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) return 0;
  let n = 0;
  for (const p of parts) n = n * 256 + (parseInt(p, 10) || 0);
  return n | 0;
}

function getIp(c: Context): string | undefined {
  if (isDev) {
    // dev: random IP so repeated local clicks aren't all deduped to one vote
    return Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)).join(".");
  }
  const xff = c.req.header("x-forwarded-for");
  if (!xff) return undefined;
  const ip = xff.split(",")[0].trim();
  return ip.startsWith("0.") ? undefined : ip;
}

// GET /p/:id/:vote → record a vote, then redirect to the results page.
export async function vote(c: Context) {
  const id = c.req.param("id") ?? "";
  const voteParam = c.req.param("vote") ?? "";
  const redirect = () => c.redirect(`/p/${id}?v=${encodeURIComponent(voteParam)}`, 303);

  const pr = await query<{ id: number; answers: string[] }>(
    `SELECT id, answers FROM polls WHERE visible_id = $1`,
    [id],
  );
  if (pr.rows.length === 0) return c.text("Poll not found", 404);
  const { id: pollId, answers } = pr.rows[0];

  const voteNum = parseInt(voteParam, 10);
  if (Number.isNaN(voteNum) || voteNum < 0 || voteNum > answers.length) {
    return c.text("Invalid vote", 400);
  }
  if (voteNum === 0) return redirect(); // "show results" — not a vote

  const ip = getIp(c);
  if (!ip) return redirect();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO votes (ip, poll_id, vote) VALUES ($1, $2, $3)`, [
      ipToInt(ip),
      pollId,
      voteNum,
    ]);
    await client.query(
      `UPDATE polls
       SET results = jsonb_set(results, ARRAY[$1]::text[],
         (COALESCE(results->($1::integer), '0')::int + 1)::text::jsonb)
       WHERE id = $2::integer`,
      [voteNum, pollId],
    );
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => {}); // duplicate (ip, poll) — ignore
  } finally {
    client.release();
  }
  return redirect();
}
