import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getConnInfo } from "@hono/node-server/conninfo";
import { pool, query } from "../db.ts";
import { isDev } from "../config.ts";
import { isPublicId, pollUriFromId } from "../poll-id.ts";
import { resolvePollShape } from "../poll-record.ts";

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

  // Unified poll (did~rkey): no registration row — count against the poll's
  // at-uri after lazily verifying the record resolves and is DB-tallied.
  if (isPublicId(id)) return voteUnified(c, id, voteNum);

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

// Vote on a unified (registration-free) private poll — one vote per IP, keyed by
// the poll's at-uri. There is no polls row and no denormalized results array;
// the tally is counted from `votes` on read. `vote: 0` removes your vote. The
// cookie is the browser's proof of ownership: only the browser whose vote
// actually counted holds one, so only it can change or remove that vote.
async function voteUnified(c: Context, id: string, voteNum: number) {
  const pollUri = pollUriFromId(id);
  if (!pollUri) return c.json({ error: "invalid poll id" }, 400);

  const cookieName = `pb_voted_${id}`;
  const hasVoted = getCookie(c, cookieName) !== undefined;
  const ipk = (() => { const ip = clientIp(c); return ip ? ipKey(ip) : null; })();

  // Unvote — only the browser that owns the vote (has the cookie) can remove it.
  if (voteNum === 0) {
    if (hasVoted && ipk != null) {
      await query(`DELETE FROM votes WHERE ip = $1 AND poll_uri = $2`, [ipk, pollUri]).catch((e) =>
        console.error("vote (unified): delete failed:", e)
      );
    }
    deleteCookie(c, cookieName, { path: "/" });
    return c.json({ ok: true, vote: 0 });
  }

  const shape = await resolvePollShape(pollUri);
  if (!shape) return c.json({ error: "poll not found" }, 404);
  if (!shape.centralized) return c.json({ error: "this poll is tallied on the network, not here" }, 400);
  if (Number.isNaN(voteNum) || voteNum < 1 || voteNum > shape.optionCount) {
    return c.json({ error: "invalid vote" }, 400);
  }

  try {
    if (hasVoted) {
      // This browser already voted → change its choice.
      await query(
        `INSERT INTO votes (ip, poll_uri, vote) VALUES ($1, $2, $3)
         ON CONFLICT (ip, poll_uri) WHERE poll_uri IS NOT NULL DO UPDATE SET vote = EXCLUDED.vote`,
        [ipk, pollUri, voteNum],
      );
    } else {
      // First vote from this browser — respects any existing vote on this IP.
      const ins = await query(
        `INSERT INTO votes (ip, poll_uri, vote) VALUES ($1, $2, $3)
         ON CONFLICT (ip, poll_uri) WHERE poll_uri IS NOT NULL DO NOTHING`,
        [ipk, pollUri, voteNum],
      );
      // Only claim ownership (set the cookie) if the vote actually counted.
      if (!ins.rowCount) return c.json({ ok: true, deduped: true });
    }
    setCookie(c, cookieName, String(voteNum), {
      path: "/",
      maxAge: 60 * 60 * 24 * 400,
      httpOnly: true,
      sameSite: "Lax",
    });
  } catch (e) {
    console.error("vote (unified): insert failed:", e);
  }
  return c.json({ ok: true, vote: voteNum });
}
