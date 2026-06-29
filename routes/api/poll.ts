import { HandlerContext } from "$fresh/server.ts";
import { getDbClient } from '../../app/db.ts';
import { getBotClient } from '../../app/bot-client.ts';
import * as log from "https://deno.land/std@0.183.0/log/mod.ts";
import { generateId, generatePollText } from "../../app/poll-utils.ts";
import { default as Agent } from "https://esm.sh/v115/@atproto/api@0.2.3"
import { z } from "https://deno.land/x/zod@v3.16.1/mod.ts";
import { getConfig } from "../../app/config.ts";
import { json } from "../../app/utils.ts";
import { getPds } from "../../app/identity_utils.ts";

const postPollSchema = z.object({
    question: z.string().min(1).max(200),
    answers: z.array(z.string().min(1).max(50)).min(2).max(4),
    handle: z.string().max(100),
    password: z.string(),
    user_agent: z.string().max(100),
    reply_to: z.string().max(200).optional(),
    // The PDS endpoint to log into. Optional: if omitted, it is resolved
    // server-side from the handle so login works for any atproto account.
    service: z.string().url().max(200).optional(),
});

export const handler = async (req: Request, _ctx: HandlerContext): Promise<Response> => {
    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
    }
    const botClient = getBotClient();
    if (!botClient) {
        return json({ error: "Bot client not configured" }, 500);
    }
    const client = getDbClient();
    const body: any = (await req.json());
    const pollParse = postPollSchema.safeParse(body);
    if (!pollParse.success) {
        return new Response(JSON.stringify({
            "error": pollParse.error.format()
        }), { status: 400 });
    }
    const { question, answers, handle, password, user_agent: userAgent, reply_to: replyTo } = pollParse.data;
    const enumeration = "number";
    const visibleId = generateId(6);
    const results = answers.map(() => 0).concat([0]);
    const createdAt = (new Date()).toISOString();
    // Prefer a client-supplied PDS, but resolve it from the handle when absent
    // (or when the client could not). Falls back to bsky.social as a last resort.
    let service = pollParse.data.service;
    if (!service) {
        try {
            service = await getPds(handle);
        } catch (e) {
            log.error(e);
        }
    }
    const agent = new Agent({ service: service || "https://bsky.social" });
    try {
        await agent.login({
            identifier: handle,
            password: password,
        });
    } catch (e) {
        log.error(e);
        return new Response(JSON.stringify({
            "error": "invalid bsky credentials",
        }), { status: 400 });
    }
    let pollPost;
    try {
        pollPost = await generatePollText({
            visibleId,
            poll: { question, answers, enumeration },
            author: handle,
            pollStyle: 'plain'
        });
    } catch {
        return new Response(JSON.stringify({
            "error": "poll too long",
        }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    let postUri = null;
    let createdPost: { uri: string, cid: string } | undefined;
    const replyRef = replyTo ? await botClient?.linkToReplyRef(replyTo) : undefined;
    try {
        createdPost = await agent?.api.app.bsky.feed.post.create(
            { repo: agent.session?.did },
            {
                text: pollPost.text,
                facets: [...pollPost.links, ...pollPost.pollFacets],
                reply: replyRef,
                createdAt
            });
        postUri = createdPost?.uri;
    } catch (e) {
        log.error(e);
        return new Response(JSON.stringify({
            "error": "failed to post poll to bsky",
        }), { status: 500 });
    }
    try {
        await client.queryObject`INSERT INTO polls (
            posted_by,
            post_uri,
            question,
            answers,
            results,
            visible_id,
            results_posted,
            user_agent) VALUES (
                ${agent.session!.handle},
                ${postUri},
                ${question},
                ${JSON.stringify(answers)},
                ${JSON.stringify(results)},
                ${visibleId},
                ${false},
                ${userAgent})`;
    } catch (e) {
        log.error(e);
        return new Response(JSON.stringify({
            "error": "failed to insert poll into db"
        }), { status: 500 });
    }
    likeAndRepost: try {
        if (!createdPost) {
            break likeAndRepost;
        }
        const replyRef = {
            parent: { cid: createdPost.cid, uri: createdPost.uri, },
            root: { cid: createdPost.cid, uri: createdPost.uri, }
        };
        await botClient?.likePost(replyRef);
        await botClient?.repost(replyRef);
    } catch (e) {
        log.error(e);
    }
    return new Response(JSON.stringify({
        "id": visibleId,
        "post_uri": postUri,
    }));
};
