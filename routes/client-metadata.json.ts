import { HandlerContext } from "$fresh/server.ts";
import { getConfig } from "../app/config.ts";
import { json } from "../app/utils.ts";

// atproto OAuth client metadata. The document's URL is the client_id, so this
// must be served at https://{HOSTNAME}/client-metadata.json in production.
// (Local dev uses the loopback client and does not fetch this file.)
export const handler = (_req: Request, _ctx: HandlerContext): Response => {
    const host = getConfig("HOSTNAME");
    const clientId = `https://${host}/client-metadata.json`;
    return json({
        client_id: clientId,
        client_name: "poll.blue",
        client_uri: `https://${host}`,
        // The home page hosts the post island, which consumes the OAuth
        // redirect via client.init() on mount.
        redirect_uris: [`https://${host}/`],
        // `transition:generic` grants the record read/write access needed to
        // create the poll post (and like) on the user's behalf.
        scope: "atproto transition:generic",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "web",
        dpop_bound_access_tokens: true,
    });
};
