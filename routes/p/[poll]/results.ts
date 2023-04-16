import { HandlerContext } from "$fresh/server.ts";
import { getClient } from '../../../db.ts';

export interface Results {
    post_uri: string;
    posted_by: string;
    created_at: string;
    question: string;
    answers: string[];
    results: number[]
}

export const handler = async (_req: Request, ctx: HandlerContext): Promise<Response> => {
    const client = getClient();
    const visibleId = ctx.params.poll;
    const queryResult = await client.queryObject`SELECT posted_by, created_at, post_uri, question, answers, results FROM polls WHERE visible_id = ${visibleId}`;
    if (queryResult.rows.length === 0) {
        return new Response(JSON.stringify({ error: `Poll ${visibleId} not found` }), { status: 404 });
    }
    const { posted_by, created_at, post_uri, question, answers, results } = (queryResult.rows[0] as Results);
    return new Response(JSON.stringify({
        "posted_by": posted_by,
        "created_at": created_at,
        "post_uri": post_uri,
        "question": question,
        "answers": answers,
        "results": results
    }));
};
