// atcute OAuth (browser) wiring. Lightweight, ESM-native — works cleanly under
// Vite/Astro where @atproto/oauth-client-browser would not bundle/load.
import {
  configureOAuth,
  createAuthorizationUrl,
  finalizeAuthorization,
  getSession,
  listStoredSessions,
  OAuthUserAgent,
} from "@atcute/oauth-browser-client";
import {
  CompositeDidDocumentResolver,
  LocalActorResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
  XrpcHandleResolver,
} from "@atcute/identity-resolver";
import { Client } from "@atcute/client";

const HANDLE_RESOLVER = "https://bsky.social";
export const SCOPE = "atproto transition:generic";

let configured = false;
let resolver: LocalActorResolver;

/** True only when the OAuth loopback dev flow can't work (served over http on a
 *  non-loopback-IP host — e.g. "localhost", which atproto rejects in favour of
 *  127.0.0.1). Used to show a friendly hint instead of failing cryptically. */
export function devHostIsWrong(): boolean {
  return location.protocol === "http:" && location.hostname !== "127.0.0.1";
}

/** Cheap + idempotent: builds resolvers and sets module config. No network, no
 *  redirects. Safe to call on mount (to handle a callback) or on sign-in. */
export function ensureConfigured(): void {
  if (configured) return;
  resolver = new LocalActorResolver({
    handleResolver: new XrpcHandleResolver({ serviceUrl: HANDLE_RESOLVER }),
    didDocumentResolver: new CompositeDidDocumentResolver({
      methods: {
        plc: new PlcDidDocumentResolver(),
        web: new WebDidDocumentResolver(),
      },
    }),
  });

  const isProd = location.protocol === "https:";
  const redirectUri = `${location.origin}/create`;
  const clientId = isProd
    // production: hosted client metadata document.
    ? `${location.origin}/client-metadata.json`
    // dev: atproto loopback client (redirect_uri + scope encoded in client_id).
    : `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPE)}`;

  configureOAuth({
    metadata: { client_id: clientId, redirect_uri: redirectUri },
    identityResolver: resolver,
  });
  configured = true;
}

/** Complete an OAuth redirect if present, else restore a stored session.
 *  atproto returns the response in the URL fragment (#code=…&state=…&iss=…) or,
 *  on some servers, the query (?code=…) — so we check both. */
export async function restoreOrFinalize(): Promise<OAuthUserAgent | null> {
  const fromHash = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  const fromQuery = location.search.startsWith("?") ? location.search.slice(1) : "";
  const params = new URLSearchParams(fromHash || fromQuery);
  if (params.has("code") || params.has("error")) {
    try {
      const { session } = await finalizeAuthorization(params);
      history.replaceState(null, "", location.pathname); // drop code/state from the URL
      return new OAuthUserAgent(session);
    } catch {
      // Code may already be consumed — fall through to restoring a stored session.
      history.replaceState(null, "", location.pathname);
    }
  }
  const dids = listStoredSessions();
  if (dids.length > 0) {
    const session = await getSession(dids[0], { allowStale: true });
    return new OAuthUserAgent(session);
  }
  return null;
}

/** Re-hydrate an OAuth agent for a known DID (used for posting). */
export async function getStoredAgent(did: string): Promise<OAuthUserAgent | null> {
  try {
    // deno-lint-ignore no-explicit-any
    const session = await getSession(did as any, { allowStale: true });
    return new OAuthUserAgent(session);
  } catch {
    return null;
  }
}

export async function startSignIn(handle: string): Promise<void> {
  const url = await createAuthorizationUrl({
    // identifier is a branded handle/DID type; our validated string is fine.
    target: { type: "account", identifier: handle as `${string}.${string}` },
    scope: SCOPE,
  });
  // Let atcute persist PKCE/state before navigating away.
  await new Promise((r) => setTimeout(r, 200));
  location.assign(url.toString());
}

export async function resolveHandle(did: string): Promise<string> {
  try {
    // deno-lint-ignore no-explicit-any
    const r = await resolver.resolve(did as any);
    return r.handle ?? did;
  } catch {
    return did;
  }
}

// Loosely typed: we call by NSID string and post custom blue.poll facets, so
// the strict lexicon types aren't worth pulling in.
// deno-lint-ignore no-explicit-any
export function makeRpc(agent: OAuthUserAgent): any {
  return new Client({ handler: agent });
}
