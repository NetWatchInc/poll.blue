import type { Context } from "hono";
import { z } from "zod";
import { query } from "../db.ts";
import { fetchDidDoc, handleFromDidDoc, pdsFromDidDoc } from "../identity.ts";
import { likeRepost } from "../bot.ts";

const schema = z.object({
  question: z.string().min(1).max(200),
  answers: z.array(z.string().min(1).max(50)).min(2).max(4),
  visible_id: z.string().min(1).max(16),
  post_uri: z.string().max(200).regex(/^at:\/\//, "must be an at:// URI"),
});

function parsePostUri(uri: string): { did: string; rkey: string } | null {
  const [did, collection, rkey] = uri.slice("at://".length).split("/");
  if (!did?.startsWith("did:") || collection !== "app.bsky.feed.post" || !rkey) return null;
  return { did, rkey };
}

// POST /api/poll/register — register a poll created client-side via OAuth.
// No credentials reach the server; instead we verify the post by reading the
// record straight from the author's PDS and confirming it links to this poll.
export async function register(c: Context) {
  const body = await c.req.json().catch(() => null);
  const parse = schema.safeParse(body);
  if (!parse.success) return c.json({ error: parse.error.format() }, 400);
  const { question, answers, visible_id, post_uri } = parse.data;

  const parsed = parsePostUri(post_uri);
  if (!parsed) return c.json({ error: "invalid post_uri" }, 400);
  const { did, rkey } = parsed;

  let doc, pds: string;
  try {
    doc = await fetchDidDoc(did);
    pds = pdsFromDidDoc(doc);
  } catch (e) {
    console.error("register: identity resolution failed:", e);
    return c.json({ error: "could not resolve author identity" }, 400);
  }

  let record: { cid?: string; value?: Record<string, unknown> };
  try {
    const url =
      `${pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}` +
      `&collection=app.bsky.feed.post&rkey=${encodeURIComponent(rkey)}`;
    const resp = await fetch(url);
    if (!resp.ok) return c.json({ error: "poll post not found on PDS" }, 400);
    record = (await resp.json()) as { cid?: string; value?: Record<string, unknown> };
  } catch (e) {
    console.error("register: failed to fetch poll post:", e);
    return c.json({ error: "failed to fetch poll post" }, 400);
  }

  const value = record.value;
  const cid = record.cid;
  if (!value || value.$type !== "app.bsky.feed.post" || !cid) {
    return c.json({ error: "post is not a feed post" }, 400);
  }
  if (!JSON.stringify(value).includes(`/p/${visible_id}/`)) {
    return c.json({ error: "post does not reference this poll" }, 400);
  }

  const handle = handleFromDidDoc(doc, did);
  const results = answers.map(() => 0).concat([0]);
  try {
    await query(
      `INSERT INTO polls (posted_by, post_uri, question, answers, results, visible_id, results_posted, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [handle, post_uri, question, JSON.stringify(answers), JSON.stringify(results), visible_id, false, "poll.blue"],
    );
  } catch (e) {
    const code = (e as { code?: string })?.code;
    console.error("register: DB insert failed:", e);
    if (code === "23505") return c.json({ error: "poll already registered" }, 409);
    return c.json({ error: "could not save poll (database error)" }, 500);
  }

  // Bot like + repost (fire-and-forget; no-op when the bot is disabled).
  likeRepost(post_uri, cid).catch(() => {});
  return c.json({ id: visible_id, post_uri });
}
