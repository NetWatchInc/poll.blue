import { useEffect, useRef, useState } from "preact/hooks";
import { postUriToBskyLink, generateId, generatePollText } from "../app/poll-utils.ts";
import { getPds } from "../app/identity_utils.ts";
import type { BrowserOAuthClient } from "@atproto/oauth-client-browser";
import type { Agent } from "@atproto/api";

const HANDLE_RESOLVER = "https://bsky.social";

interface Session {
  did: string;
  handle: string;
}

export default function PostPoll() {
  // Poll content (shared by both posting paths).
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", "", "", ""]);
  const [replyTo, setReplyTo] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  // OAuth state.
  const clientRef = useRef<BrowserOAuthClient | null>(null);
  const agentRef = useRef<Agent | null>(null);
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

  // Initialize the OAuth client once, on the client only. Loaded dynamically so
  // the browser-only library never runs during server-side rendering.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { BrowserOAuthClient } = await import("@atproto/oauth-client-browser");
        const { Agent } = await import("@atproto/api");
        const isLocalhost = ["localhost", "127.0.0.1"].includes(location.hostname);
        const client = isLocalhost
          ? new BrowserOAuthClient({
            handleResolver: HANDLE_RESOLVER,
            clientMetadata: undefined,
          })
          : await BrowserOAuthClient.load({
            clientId: `https://${location.host}/client-metadata.json`,
            handleResolver: HANDLE_RESOLVER,
          });
        if (cancelled) return;
        clientRef.current = client;
        const result = await client.init();
        if (cancelled) return;
        if (result?.session) {
          const agent = new Agent(result.session);
          agentRef.current = agent;
          await setSignedIn(agent, result.session.sub);
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

  async function setSignedIn(agent: Agent, did: string) {
    let resolvedHandle = did;
    try {
      const prof = await agent.getProfile({ actor: did });
      resolvedHandle = prof.data.handle ?? did;
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
      // Redirects away; the returned promise only settles on failure.
      await clientRef.current?.signIn(input);
    } catch (e) {
      setError("sign in failed: " + (e as Error).message);
    }
  }

  async function signOut() {
    try {
      // deno-lint-ignore no-explicit-any
      await (clientRef.current as any)?.revoke?.(session?.did);
    } catch {
      // ignore
    }
    agentRef.current = null;
    setSession(null);
  }

  // Resolve a reply-to link (bsky.app URL or at:// URI) to a post ref, using
  // the signed-in agent. Mirrors Bot.linkToReplyRef in app/bot.ts.
  async function resolveReply(agent: Agent, link: string) {
    let did: string | undefined;
    let rkey: string | undefined;
    if (link.startsWith("at://")) {
      const seg = link.split("/").slice(-3);
      did = seg[0];
      rkey = seg[2];
    } else {
      const m = /https:\/\/(?:staging\.)?bsky\.app\/profile\/([^/]+)\/post\/([^/]+)/.exec(link);
      if (m) {
        const r = await agent.com.atproto.identity.resolveHandle({ handle: m[1] });
        did = r.data.did;
        rkey = m[2];
      }
    }
    if (!did || !rkey) return undefined;
    const rec = await agent.com.atproto.repo.getRecord({
      repo: did,
      collection: "app.bsky.feed.post",
      rkey,
    });
    const post = { uri: rec.data.uri, cid: rec.data.cid! };
    // deno-lint-ignore no-explicit-any
    const root = (rec.data.value as any)?.reply?.root ?? post;
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
      const reply = replyTo ? await resolveReply(agent, replyTo) : undefined;
      const created = await agent.com.atproto.repo.createRecord({
        repo: agent.assertDid,
        collection: "app.bsky.feed.post",
        record: {
          $type: "app.bsky.feed.post",
          text,
          facets: [...links, ...pollFacets],
          reply,
          createdAt,
        },
      });
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
