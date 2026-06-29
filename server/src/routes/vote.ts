import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { getConnInfo } from "@hono/node-server/conninfo";
import { pool, query } from "../db.ts";

// Hash any IP (v4 or v6) to a signed int32 so it fits the votes.ip column and
// dedups uniformly. (The old dotted-quad math overflowed for IPs >= 128.x and
// collapsed every IPv6 address to 0.)
function ipKey(ip: string): number {
  let h = 0;
  for (let i = 0; i < ip.length; i++) h = (h * 31 + ip.charCodeAt(i)) | 0;
  return h;
}

function clientIp(c: Context): string | undefined {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const ip = xff.split(",")[0].trim();
    if (ip && !ip.startsWith("0.")) return ip;
  }
  // local dev / no proxy: fall back to the connection's remote address
  return getConnInfo(c).remote.address;
}

// Link prefetchers, unfurlers and "open in background" shouldn't cast a vote.
function isPrefetch(c: Context): boolean {
  const p = (
    c.req.header("sec-purpose") ??
    c.req.header("purpose") ??
    c.req.header("x-purpose") ??
    c.req.header("x-moz") ??
    ""
  ).toLowerCase();
  return p.includes("prefetch") || p.includes("prerender") || p.includes("preview");
}

// GET /p/:id/:vote → record a vote (once per browser / IP), then redirect to
// the results page.
export async function vote(c: Context) {
  const id = c.req.param("id") ?? "";
  const voteParam = c.req.param("vote") ?? "";
  c.header("Cache-Control", "no-store"); // never let a vote URL be cached
  const redirect = () => c.redirect(`/p/${id}?v=${encodeURIComponent(voteParam)}`, 303);

  // Don't count prefetch/unfurl hits; no-store so the real click re-requests.
  if (isPrefetch(c)) return c.body(null, 204);

  const cookieName = `pb_voted_${id}`;
  const alreadyVoted = getCookie(c, cookieName) !== undefined;

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
  if (alreadyVoted) return redirect(); // this browser already voted on this poll

  const ip = clientIp(c);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // unique(ip, poll_id) blocks a second vote from the same IP
    await client.query(`INSERT INTO votes (ip, poll_id, vote) VALUES ($1, $2, $3)`, [
      ip ? ipKey(ip) : null,
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
    // mark this browser as having voted (survives IP changes / clears the
    // common double-count path without a DB hit)
    setCookie(c, cookieName, String(voteNum), {
      path: "/",
      maxAge: 60 * 60 * 24 * 400,
      httpOnly: true,
      sameSite: "Lax",
    });
  } catch {
    await client.query("ROLLBACK").catch(() => {}); // duplicate (ip, poll) — ignore
  } finally {
    client.release();
  }
  return redirect();
}
