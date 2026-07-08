import type { Context } from "hono";
import { pool, query } from "../db.ts";
import { fetchDidDoc, pdsFromDidDoc } from "../identity.ts";
import { isDev } from "../config.ts";
import { decodePublicId, isPublicId, POLL_NSID, pollUriFromId } from "../poll-id.ts";

function parseAtUri(uri: string): { did: string; collection: string; rkey: string } | null {
  if (!uri.startsWith("at://")) return null;
  const [did, collection, rkey] = uri.slice("at://".length).split("/");
  if (!did?.startsWith("did:") || !collection || !rkey) return null;
  return { did, collection, rkey };
}

// Same-origin guard (mirrors the vote route): the site's own JS is the only
// legitimate caller.
function sameOrigin(c: Context): boolean {
  const origin = c.req.header("origin");
  if (!origin) return true;
  try {
    const host = (c.req.header("host") ?? "").split(":")[0];
    return new URL(origin).hostname === host;
  } catch {
    return false;
  }
}

// DELETE /api/poll/:id — delete a private (centralized) poll's votes.
//
// There is no server-side session, so we prove ownership pragmatically by reading
// the creator's PDS: the poll is a blue.poll.poll.poll record in the creator's
// repo (a `did~rkey` at-uri for unified polls, or `blue_poll_uri` for legacy
// ones). Only the repo owner can delete that record, so we require it to be
// ABSENT (the client deletes it first) before purging our vote rows. A stranger
// can't make it absent, and a poll with no such record simply can't be deleted here.
export async function deletePoll(c: Context) {
  if (!isDev && !sameOrigin(c)) return c.json({ error: "bad origin" }, 403);

  const id = c.req.param("id") ?? "";

  // Unified poll (did~rkey): no polls row — just purge its votes, once we've
  // confirmed the creator removed the poll record from their repo (ownership).
  if (isPublicId(id)) return deleteUnified(c, id);

  const r = await query<{ id: number; blue_poll_uri: string | null }>(
    `SELECT id, blue_poll_uri FROM polls WHERE visible_id = $1`,
    [id],
  );
  if (r.rows.length === 0) return c.json({ error: "poll not found" }, 404);
  const { id: pollId, blue_poll_uri } = r.rows[0];
  if (!blue_poll_uri) return c.json({ error: "this poll can't be managed" }, 403);

  const at = parseAtUri(blue_poll_uri);
  if (!at) return c.json({ error: "bad poll record uri" }, 400);

  // Confirm the creator has removed the poll record from their repo.
  let pds: string;
  try {
    pds = pdsFromDidDoc(await fetchDidDoc(at.did));
  } catch {
    return c.json({ error: "could not resolve creator identity" }, 400);
  }
  try {
    const url =
      `${pds}/xrpc/com.atproto.repo.getRecord` +
      `?repo=${encodeURIComponent(at.did)}&collection=${encodeURIComponent(at.collection)}&rkey=${encodeURIComponent(at.rkey)}`;
    const resp = await fetch(url);
    if (resp.ok) return c.json({ error: "delete the poll record from your repo first" }, 409);
    // 400/404 → record is gone → the owner authorized this delete.
  } catch {
    return c.json({ error: "could not verify the deletion" }, 502);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM votes WHERE poll_id = $1`, [pollId]);
    await client.query(`DELETE FROM polls WHERE id = $1`, [pollId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("delete: DB purge failed:", e);
    return c.json({ error: "could not delete the poll" }, 500);
  } finally {
    client.release();
  }
  return c.json({ ok: true });
}

// Delete a unified poll's votes. The poll itself is a repo record the creator
// owns; we confirm they've removed it (proof of ownership), then purge our
// votes for its at-uri. Purging a poll with no votes is a clean no-op.
async function deleteUnified(c: Context, id: string) {
  const dec = decodePublicId(id);
  const pollUri = pollUriFromId(id);
  if (!dec || !pollUri) return c.json({ error: "invalid poll id" }, 400);

  let pds: string;
  try {
    pds = pdsFromDidDoc(await fetchDidDoc(dec.did));
  } catch {
    return c.json({ error: "could not resolve creator identity" }, 400);
  }
  try {
    const url =
      `${pds}/xrpc/com.atproto.repo.getRecord` +
      `?repo=${encodeURIComponent(dec.did)}&collection=${encodeURIComponent(POLL_NSID)}&rkey=${encodeURIComponent(dec.rkey)}`;
    const resp = await fetch(url);
    if (resp.ok) return c.json({ error: "delete the poll record from your repo first" }, 409);
    // 400/404 → record gone → owner authorized this.
  } catch {
    return c.json({ error: "could not verify the deletion" }, 502);
  }

  try {
    await query(`DELETE FROM votes WHERE poll_uri = $1`, [pollUri]);
  } catch (e) {
    console.error("delete (unified): purge failed:", e);
    return c.json({ error: "could not delete the poll" }, 500);
  }
  return c.json({ ok: true });
}
