import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { getConnInfo } from "@hono/node-server/conninfo";
import { pool, query } from "../db.ts";
import { isDev } from "../config.ts";

// Hash any IP (v4 or v6) to a signed int32 so it fits votes.ip and dedups
// uniformly.
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
  return getConnInfo(c).remote.address;
}

// Reject obvious cross-site POSTs. Browsers always send Origin on a JSON POST;
// compare hostnames (ports differ in dev behind the Vite proxy).
function sameOrigin(c: Context): boolean {
  const origin = c.req.header("origin");
  if (!origin) return true; // non-browser/no-Origin still hits the dedup below
  try {
    const host = (c.req.header("host") ?? "").split(":")[0];
    return new URL(origin).hostname === host;
  } catch {
    return false;
  }
}

// POST /api/poll/:id/vote  { vote: number }
// Only ever called by the results page's JS — bots that just fetch the option
// link (firehose, unfurlers, crawlers) never reach this.
export async function vote(c: Context) {
  if (!isDev && !sameOrigin(c)) return c.json({ error: "bad origin" }, 403);

  const id = c.req.param("id") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as { vote?: unknown };
  const voteNum = parseInt(String(body?.vote), 10);

  const pr = await query<{ id: number; answers: string[] }>(
    `SELECT id, answers FROM polls WHERE visible_id = $1`,
    [id],
  );
  if (pr.rows.length === 0) return c.json({ error: "poll not found" }, 404);
  const { id: pollId, answers } = pr.rows[0];

  if (Number.isNaN(voteNum) || voteNum < 1 || voteNum > answers.length) {
    return c.json({ error: "invalid vote" }, 400);
  }

  const cookieName = `pb_voted_${id}`;
  if (getCookie(c, cookieName) !== undefined) {
    return c.json({ ok: true, deduped: true }); // this browser already voted
  }

  const ip = clientIp(c);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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
  return c.json({ ok: true, vote: voteNum });
}
