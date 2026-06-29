import { useEffect, useRef, useState } from "preact/hooks";
import { generateId, generatePollText, postUriToBskyLink } from "../app/poll-utils.ts";
import { getPds } from "../app/identity_utils.ts";
import type { OAuthUserAgent } from "@atcute/oauth-browser-client";

const HANDLE_RESOLVER = "https://bsky.social";
const SCOPE = "atproto transition:generic";

interface Session {
  did: string;
  handle: string;
}

// The atcute module functions we need after configuring OAuth once.
// deno-lint-ignore no-explicit-any
type OAuthMod = any;
// deno-lint-ignore no-explicit-any
type ClientMod = any;
// deno-lint-ignore no-explicit-any
type Resolver = any;

export default function PostPoll() {
  // Poll content (shared by both posting paths).
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", "", "", ""]);
  const [replyTo, setReplyTo] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  // OAuth state.
  const oauthRef = useRef<OAuthMod | null>(null);
  const clientModRef = useRef<ClientMod | null>(null);
  const resolverRef = useRef<Resolver | null>(null);
  const agentRef = useRef<OAuthUserAgent | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [handle, setHandle] = useState("");

  // App-password fallback state.
  const [showPasswordFallback, setShowPasswordFallback] = useState(false);
  const [password, setPassword] = useState("");

  // Result/UI state.
  const [postUri, setPostUri] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Configure OAuth once, on the client only. atcute is loaded dynamically so
  // the browser-only library never runs during server-side rendering.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Loopback OAuth clients must use the 127.0.0.1 IP, not the localhost
        // hostname, and the session store is per-origin — so do everything on
        // 127.0.0.1.
        if (location.hostname === "localhost") {
          location.replace(location.href.replace("localhost", "127.0.0.1"));
          return;
        }

        const oauth = await import("@atcute/oauth-browser-client");
        const clientMod = await import("@atcute/client");
        const idr = await import("@atcute/identity-resolver");
        if (cancelled) return;

        const identityResolver = new idr.LocalActorResolver({
          handleResolver: new idr.XrpcHandleResolver({ serviceUrl: HANDLE_RESOLVER }),
          didDocumentResolver: new idr.CompositeDidDocumentResolver({
            methods: {
              plc: new idr.PlcDidDocumentResolver(),
              web: new idr.WebDidDocumentResolver(),
            },
          }),
        });

        const isDev = location.hostname === "127.0.0.1";
        const redirectUri = `${location.origin}/`;
        // Production: client_id is the hosted metadata URL. Dev: the atproto
        // "loopback" client, with redirect_uri + scope encoded into client_id.
        const clientId = isDev
          ? `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPE)}`
          : `https://${location.host}/client-metadata.json`;

        oauth.configureOAuth({
          metadata: { client_id: clientId, redirect_uri: redirectUri },
          identityResolver,
        });

        oauthRef.current = oauth;
        clientModRef.current = clientMod;
        resolverRef.current = identityResolver;

        // Complete an in-progress sign-in (OAuth redirect back to us), else
        // restore a previously stored session.
        const params = new URLSearchParams(location.search);
        if (params.has("code") || params.has("error") || params.has("state")) {
          history.replaceState(null, "", location.pathname);
          const { session: s } = await oauth.finalizeAuthorization(params);
          if (cancelled) return;
          await adoptSession(new oauth.OAuthUserAgent(s));
        } else {
          const dids = oauth.listStoredSessions();
          if (dids.length > 0) {
            const s = await oauth.getSession(dids[0], { allowStale: true });
            if (cancelled) return;
            await adoptSession(new oauth.OAuthUserAgent(s));
          }
        }
      } catch (e) {
        if (!cancelled) setError("could not start OAuth: " + (e as Error).message);
      } finally {
        if (!cancelled) setInitializing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function adoptSession(agent: OAuthUserAgent) {
    agentRef.current = agent;
    const did = agent.sub as string;
    let resolvedHandle = did;
    try {
      const resolved = await resolverRef.current.resolve(did);
      resolvedHandle = resolved.handle ?? did;
    } catch {
      // Non-critical: fall back to showing the DID.
    }
    setSession({ did, handle: resolvedHandle });
  }

  async function signIn() {
    setError("");
    const input = handle.trim().replace(/^@/, "");
    if (!input) {
      setError("enter your handle to sign in");
      return;
    }
    try {
      const url = await oauthRef.current.createAuthorizationUrl({
        // identifier is a branded handle/DID type; our input is fine at runtime.
        // deno-lint-ignore no-explicit-any
        target: { type: "account", identifier: input as any },
        scope: SCOPE,
      });
      // Let atcute persist the PKCE/state to storage before we navigate away.
      await new Promise((r) => setTimeout(r, 250));
      location.assign(url.toString());
    } catch (e) {
      setError("sign in failed: " + (e as Error).message);
    }
  }

  async function signOut() {
    try {
      await agentRef.current?.signOut();
    } catch {
      // ignore
    }
    agentRef.current = null;
    setSession(null);
  }

  // A new XRPC client bound to the signed-in user's PDS. Cast to a loose type:
  // we call by NSID string and use custom poll facets, so the strict lexicon
  // types aren't worth pulling in here.
  // deno-lint-ignore no-explicit-any
  function rpc(): any {
    return new clientModRef.current.Client({ handler: agentRef.current });
  }

  // Resolve a reply-to link (bsky.app URL or at:// URI) to a post ref via the
  // signed-in agent. Mirrors Bot.linkToReplyRef in app/bot.ts.
  // deno-lint-ignore no-explicit-any
  async function resolveReply(api: any, link: string) {
    let did: string | undefined;
    let rkey: string | undefined;
    if (link.startsWith("at://")) {
      const seg = link.split("/").slice(-3);
      did = seg[0];
      rkey = seg[2];
    } else {
      const m = /https:\/\/(?:staging\.)?bsky\.app\/profile\/([^/]+)\/post\/([^/]+)/.exec(link);
      if (m) {
        const r = await api.get("com.atproto.identity.resolveHandle", { params: { handle: m[1] } });
        if (!r.ok) return undefined;
        did = r.data.did;
        rkey = m[2];
      }
    }
    if (!did || !rkey) return undefined;
    const rec = await api.get("com.atproto.repo.getRecord", {
      params: { repo: did, collection: "app.bsky.feed.post", rkey },
    });
    if (!rec.ok) return undefined;
    const post = { uri: rec.data.uri, cid: rec.data.cid };
    const root = rec.data.value?.reply?.root ?? post;
    return { root, parent: post };
  }

  function activeOptions() {
    return options.filter((opt) => opt !== "");
  }

  // Primary path: create the post in the browser via OAuth, then register it.
  async function postPollOAuth(evt: Event) {
    evt.preventDefault();
    const agent = agentRef.current;
    if (!agent || !session) return;
    setBusy(true);
    setError("");
    setPostUri("");
    try {
      const answers = activeOptions();
      const visibleId = generateId(6);
      const { text, links, pollFacets } = generatePollText({
        visibleId,
        poll: { question, answers, enumeration: "number" },
        author: session.handle,
        pollStyle: "plain",
      });
      const createdAt = new Date().toISOString();
      const api = rpc();
      const reply = replyTo ? await resolveReply(api, replyTo) : undefined;
      const created = await api.post("com.atproto.repo.createRecord", {
        input: {
          repo: agent.sub,
          collection: "app.bsky.feed.post",
          record: {
            $type: "app.bsky.feed.post",
            text,
            facets: [...links, ...pollFacets],
            reply,
            createdAt,
          },
        },
      });
      if (!created.ok) {
        throw new Error(created.data?.error ?? "failed to create post");
      }
      const resp = await fetch("/api/poll/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          answers,
          visible_id: visibleId,
          post_uri: created.data.uri,
        }),
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(typeof j.error === "string" ? j.error : "failed to register poll");
      }
      setPostUri(created.data.uri);
    } catch (e) {
      setError((e as Error).message || "failed to post poll");
    } finally {
      setBusy(false);
    }
  }

  // Fallback path: send handle + app password to the server (legacy).
  async function postPollPassword(evt: Event) {
    evt.preventDefault();
    setBusy(true);
    setError("");
    setPostUri("");
    try {
      let service: string | undefined;
      try {
        service = await getPds(handle);
      } catch (_) {
        service = undefined; // server will resolve
      }
      const response = await fetch("/api/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          handle: handle.trim().replace(/^@/, ""),
          password,
          question,
          answers: activeOptions(),
          user_agent: "poll.blue",
          reply_to: replyTo || undefined,
          service,
        }),
      });
      if (response.status === 200) {
        setPostUri((await response.json()).post_uri);
      } else {
        const j = await response.json().catch(() => ({}));
        throw new Error(typeof j.error === "string" ? j.error : "failed to post poll");
      }
    } catch (e) {
      setError((e as Error).message || "failed to post poll");
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "appearance-none border rounded mb-2 w-full py-2 px-3 text-gray-400 leading-tight focus:outline-none focus:shadow-outline";
  const labelClass = "block text-gray-400 text-sm font-bold mb-2";
  const canPost = question !== "" && activeOptions().length >= 2;

  return (
    <form class="px-8 pt-6 pb-8 mb-4" onSubmit={(evt) => evt.preventDefault()}>
      {/* Question */}
      <div class="mb-4">
        <label class={labelClass} for="question">Question</label>
        <input
          class={inputClass}
          id="question"
          type="text"
          value={question}
          maxLength={200}
          onInput={({ target }) => setQuestion((target as HTMLInputElement).value)}
        />
      </div>

      {/* Options */}
      {options.map((option, i) => (
        <div class="mb-4">
          <label class={labelClass} for={"option" + i}>Option {i + 1}</label>
          <input
            class={inputClass}
            id={"option" + i}
            type="text"
            value={option}
            maxLength={50}
            onInput={({ target }) =>
              setOptions(options.map((o, j) => (i === j ? (target as HTMLInputElement).value : o)))}
          />
        </div>
      ))}

      {/* Live preview */}
      {activeOptions().length >= 2 && (
        <div class="p-4 my-4 text-xl bg-gray-400 rounded" style="overflow-wrap: break-word">
          <p class="mb-4">{question}</p>
          <ol>
            {activeOptions().map((opt, idx) => (
              <li>{["1️⃣", "2️⃣", "3️⃣", "4️⃣"][idx]} {opt}</li>
            ))}
          </ol>
          <p class="mt-6">📊 Show results</p>
        </div>
      )}

      {/* Advanced options (reply-to + app-password fallback) */}
      <div class="mb-4">
        <p class="text-gray-400 text-sm font-bold mb-2">
          <a href="#" onClick={(e) => { e.preventDefault(); setShowAdvanced(!showAdvanced); }}>
            Advanced options (Toggle)
          </a>
        </p>
        <div class={showAdvanced ? "" : "hidden"}>
          <label class={labelClass} for="reply_to">Reply to (bsky app URL or at:// URI)</label>
          <input
            class={inputClass}
            id="reply_to"
            type="text"
            value={replyTo}
            maxLength={200}
            onInput={({ target }) => setReplyTo((target as HTMLInputElement).value)}
            placeholder="https://bsky.app/profile/jay.bsky.team/post/3juflvnb3d62u"
          />

          {!session && (
            <div class="mt-4">
              <p class="text-gray-400 text-sm font-bold mb-2">
                <a
                  href="#"
                  onClick={(e) => { e.preventDefault(); setShowPasswordFallback(!showPasswordFallback); }}
                >
                  Post with an app password instead (Toggle)
                </a>
              </p>
              <div class={showPasswordFallback ? "" : "hidden"}>
                <p class="text-gray-500 text-xs mb-2">
                  Only use this if your PDS doesn't support OAuth. Use an app
                  password (Settings → App passwords), not your main password.
                  Sign in with Bluesky above is preferred.
                </p>
                <label class={labelClass} for="password">App password</label>
                <input
                  class={inputClass}
                  id="password"
                  type="password"
                  value={password}
                  maxLength={50}
                  onInput={({ target }) => setPassword((target as HTMLInputElement).value)}
                />
                <button
                  class="bg-gray-600 hover:bg-gray-700 text-white font-bold py-2 px-4 rounded disabled:opacity-50"
                  type="button"
                  disabled={busy || !canPost || handle === "" || password === ""}
                  onClick={postPollPassword}
                >
                  {busy ? "Posting…" : "Post with app password"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Auth + primary action */}
      <div class="my-4">
        {initializing
          ? <p class="text-gray-400">Loading…</p>
          : session
          ? (
            <div>
              <p class="text-gray-400 mb-3">
                Signed in as <span class="text-white">@{session.handle}</span>{" "}
                (<a href="#" class="text-blue-500 hover:underline" onClick={(e) => { e.preventDefault(); signOut(); }}>sign out</a>)
              </p>
              <button
                class="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline disabled:opacity-50"
                type="button"
                disabled={busy || !canPost}
                onClick={postPollOAuth}
              >
                {busy ? "Posting…" : "Post poll"}
              </button>
            </div>
          )
          : (
            <div>
              <label class={labelClass} for="handle">Handle</label>
              <input
                class={inputClass}
                id="handle"
                type="text"
                value={handle}
                maxLength={253}
                onInput={({ target }) => setHandle((target as HTMLInputElement).value)}
                placeholder="something.bsky.social"
              />
              <button
                class="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline disabled:opacity-50"
                type="button"
                disabled={handle === ""}
                onClick={signIn}
              >
                Sign in with Bluesky
              </button>
            </div>
          )}
      </div>

      {/* Result / error */}
      {postUri && (
        <div class="my-6 p-4 mx-auto max-w-screen-md bg-green-500 rounded">
          <p class="text-center text-xl">
            <a class="hover:underline text-blue-800" href={postUriToBskyLink(postUri)}>
              Poll posted!
            </a>
          </p>
        </div>
      )}
      {error !== "" && (
        <div class="my-6 p-4 mx-auto max-w-screen-md bg-red-500 rounded">
          <p class="text-center text-xl">Error: {error}</p>
        </div>
      )}
    </form>
  );
}
