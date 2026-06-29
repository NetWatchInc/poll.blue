import { HandlerContext } from "$fresh/server.ts";
import * as log from "https://deno.land/std@0.183.0/log/mod.ts";
import { z } from "https://deno.land/x/zod@v3.16.1/mod.ts";
import { getDbClient } from "../../../app/db.ts";
import { getBotClient } from "../../../app/bot-client.ts";
import { fetchDidDoc, getPdsFromDidDoc } from "../../../app/identity_utils.ts";
import { json } from "../../../app/utils.ts";

// Registers a poll whose post was already created client-side via OAuth, so no
// credentials ever reach this server. Because we can't authenticate the
// request with a password, we instead VERIFY the post: we read the record
// straight from the author's PDS and confirm it is a real poll.blue poll. This
// prevents the bot from being tricked into liking/reposting arbitrary posts.
const registerSchema = z.object({
    question: z.string().min(1).max(200),
    answers: z.array(z.string().min(1).max(50)).min(2).max(4),
    visible_id: z.string().min(1).max(16),
    post_uri: z.string().max(200).regex(/^at:\/\//, "must be an at:// URI"),
});

// Parse an at:// post URI into its DID and rkey, ensuring it's a feed post.
function parsePostUri(uri: string): { did: string; rkey: string } | null {
    // at://did:plc:xxx/app.bsky.feed.post/rkey
    if (!uri.startsWith("at://")) {
        return null;
    }
    const rest = uri.slice("at://".length);
    const [did, collection, rkey] = rest.split("/");
    if (!did || !did.startsWith("did:") || collection !== "app.bsky.feed.post" || !rkey) {
        return null;
    }
    return { did, rkey };
}

export const handler = async (req: Request, _ctx: HandlerContext): Promise<Response> => {
    if (req.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
    }

    const body = await req.json().catch(() => null);
    const parse = registerSchema.safeParse(body);
    if (!parse.success) {
        return json({ error: parse.error.format() }, 400);
    }
    const { question, answers, visible_id: visibleId, post_uri: postUri } = parse.data;

    const parsed = parsePostUri(postUri);
    if (!parsed) {
        return json({ error: "invalid post_uri" }, 400);
    }
    const { did, rkey } = parsed;

    // Resolve the author's DID document once: it gives us both the PDS endpoint
    // (to read the record from the authoritative source, no appview lag) and
    // the handle (for display on the results page).
    let didDoc: { alsoKnownAs?: string[] };
    let pds: string;
    try {
        didDoc = await fetchDidDoc(did);
        pds = getPdsFromDidDoc(didDoc);
    } catch (e) {
        log.error(e);
        return json({ error: "could not resolve author identity" }, 400);
    }

    // Fetch the post record directly from the PDS.
    let record: { cid?: string; value?: Record<string, unknown> };
    try {
        const url =
            `${pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}` +
            `&collection=app.bsky.feed.post&rkey=${encodeURIComponent(rkey)}`;
        const resp = await fetch(url);
        if (!resp.ok) {
            return json({ error: "poll post not found on PDS" }, 400);
        }
        record = await resp.json();
    } catch (e) {
        log.error(e);
        return json({ error: "failed to fetch poll post" }, 400);
    }

    // Verify it's a real post that links back to this exact poll. The poll
    // option links (built in poll-utils) all contain `/p/{visibleId}/`.
    const value = record.value;
    const cid = record.cid;
    if (!value || value.$type !== "app.bsky.feed.post" || !cid) {
        return json({ error: "post is not a feed post" }, 400);
    }
    if (!JSON.stringify(value).includes(`/p/${visibleId}/`)) {
        return json({ error: "post does not reference this poll" }, 400);
    }

    const handle = (didDoc.alsoKnownAs ?? [])
        .find((aka) => aka.startsWith("at://"))
        ?.slice("at://".length) ?? did;

    // Persist the poll (results has a leading slot for abstentions, mirroring
    // the legacy /api/poll path).
    const results = answers.map(() => 0).concat([0]);
    try {
        await getDbClient().queryObject`INSERT INTO polls (
            posted_by, post_uri, question, answers, results, visible_id, results_posted, user_agent
        ) VALUES (
            ${handle}, ${postUri}, ${question}, ${JSON.stringify(answers)},
            ${JSON.stringify(results)}, ${visibleId}, ${false}, ${"poll.blue"}
        )`;
    } catch (e) {
        log.error(e);
        return json({ error: "failed to register poll (already registered?)" }, 409);
    }
    log.info(`registered poll ${visibleId} by @${handle} at ${postUri}`);

    // Bot like + repost (uses the bot's own credentials, not the user's).
    try {
        const ref = {
            parent: { uri: postUri, cid },
            root: { uri: postUri, cid },
        };
        await getBotClient()?.likePost(ref);
        await getBotClient()?.repost(ref);
    } catch (e) {
        log.error(e);
    }

    return json({ id: visibleId, post_uri: postUri });
};
