import { useEffect, useState } from "preact/hooks";
import { useStore } from "@nanostores/preact";
import { $account, $authReady, getAgent, initSession, signIn } from "../lib/session";
import { makeRpc } from "../lib/oauth";
import { generateId, generatePollText, postUriToBskyLink } from "../lib/poll";

const EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"];

export default function CreatePoll() {
  const account = useStore($account);
  const ready = useStore($authReady);

  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", "", "", ""]);
  const [replyTo, setReplyTo] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [signInHandle, setSignInHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ postUri: string; visibleId: string } | null>(null);

  useEffect(() => {
    initSession();
  }, []);

  const activeOptions = options.map((o) => o.trim()).filter(Boolean);
  const canPost = question.trim().length > 0 && activeOptions.length >= 2;

  async function doSignIn() {
    setError("");
    const h = signInHandle.trim().replace(/^@/, "");
    if (!h) return setError("Enter your Bluesky handle.");
    setBusy(true);
    try {
      await signIn(h);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  // deno-lint-ignore no-explicit-any
  async function resolveReply(rpc: any, link: string) {
    let did: string | undefined, rkey: string | undefined;
    if (link.startsWith("at://")) {
      const seg = link.split("/").slice(-3);
      did = seg[0];
      rkey = seg[2];
    } else {
      const m = /https:\/\/(?:staging\.)?bsky\.app\/profile\/([^/]+)\/post\/([^/]+)/.exec(link);
      if (m) {
        const r = await rpc.get("com.atproto.identity.resolveHandle", { params: { handle: m[1] } });
        if (!r.ok) return undefined;
        did = r.data.did;
        rkey = m[2];
      }
    }
    if (!did || !rkey) return undefined;
    const rec = await rpc.get("com.atproto.repo.getRecord", {
      params: { repo: did, collection: "app.bsky.feed.post", rkey },
    });
    if (!rec.ok) return undefined;
    const post = { uri: rec.data.uri, cid: rec.data.cid };
    return { root: rec.data.value?.reply?.root ?? post, parent: post };
  }

  async function post() {
    if (!canPost) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const agent = await getAgent();
      if (!agent) throw new Error("Your session expired — sign in again.");
      const visibleId = generateId(6);
      const { text, links, pollFacets } = generatePollText({
        visibleId,
        question: question.trim(),
        answers: activeOptions,
        origin: location.origin,
      });
      const rpc = makeRpc(agent);
      const reply = replyTo.trim() ? await resolveReply(rpc, replyTo.trim()) : undefined;
      const created = await rpc.post("com.atproto.repo.createRecord", {
        input: {
          repo: agent.sub,
          collection: "app.bsky.feed.post",
          record: {
            $type: "app.bsky.feed.post",
            text,
            facets: [...links, ...pollFacets],
            reply,
            createdAt: new Date().toISOString(),
          },
        },
      });
      if (!created.ok) throw new Error(created.data?.error ?? "Failed to create the post.");

      const resp = await fetch("/api/poll/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question.trim(), answers: activeOptions, visible_id: visibleId, post_uri: created.data.uri }),
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(typeof j.error === "string" ? j.error : "Failed to register the poll.");
      }
      setResult({ postUri: created.data.uri, visibleId });
    } catch (e) {
      setError((e as Error).message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  /* ---------- render ---------- */
  if (!ready) {
    return (
      <div class="card grid place-items-center p-16 text-[var(--color-ink-soft)]">
        <div class="flex items-center gap-3">
          <span class="h-2.5 w-2.5 animate-ping rounded-full" style="background: var(--color-brand)"></span>
          Starting up…
        </div>
      </div>
    );
  }

  if (result) {
    return (
      <div class="card rise p-8 text-center sm:p-10">
        <div class="mx-auto grid h-14 w-14 place-items-center rounded-full text-white" style="background: linear-gradient(160deg, var(--color-brand), var(--color-brand-deep))">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </div>
        <h2 class="mt-5 text-3xl">Poll posted!</h2>
        <p class="mt-2 text-[var(--color-ink-soft)]">It's live on your account. Share it and watch the votes land.</p>
        <div class="mt-7 flex flex-wrap justify-center gap-3">
          <a class="btn btn-primary" href={`/p/${result.visibleId}`}>View results</a>
          <a class="btn btn-ghost" href={postUriToBskyLink(result.postUri)} target="_blank" rel="noreferrer">Open on Bluesky</a>
          <button class="btn btn-ghost" onClick={() => { setResult(null); setQuestion(""); setOptions(["", "", "", ""]); setReplyTo(""); }}>
            New poll
          </button>
        </div>
      </div>
    );
  }

  if (!account) {
    return (
      <div class="card rise p-8 sm:p-10">
        <span class="pill">Sign in to continue</span>
        <h2 class="mt-4 text-3xl">Sign in through the Atmosphere</h2>
        <p class="mt-2 max-w-md text-[var(--color-ink-soft)]">
          No need to create another account - simply log in using your Bluesky handle.
        </p>
        <div class="mt-6 flex flex-col gap-3 sm:flex-row">
          <input
            class="field flex-1"
            type="text"
            placeholder="you.bsky.social"
            value={signInHandle}
            autocomplete="username"
            onInput={(e) => setSignInHandle((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === "Enter") doSignIn(); }}
          />
          <button class="btn btn-primary" disabled={busy || !signInHandle.trim()} onClick={doSignIn}>
            {busy ? "Redirecting…" : "Continue"}
          </button>
        </div>
        {error && <p class="mt-4 text-sm font-medium text-red-600">{error}</p>}
      </div>
    );
  }

  return (
    <div class="rise grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
      <div class="card p-7 sm:p-8">
        <span class="pill">Compose</span>

        <label class="mt-6 block text-sm font-semibold text-[var(--color-ink-soft)]" for="q">Question</label>
        <input
          id="q"
          class="field mt-2"
          type="text"
          maxLength={200}
          placeholder="Red Button or Blue Button?"
          value={question}
          onInput={(e) => setQuestion((e.target as HTMLInputElement).value)}
        />

        <p class="mt-6 text-sm font-semibold text-[var(--color-ink-soft)]">Options <span class="font-normal">(2–4)</span></p>
        <div class="mt-2 space-y-2.5">
          {options.map((opt, i) => (
            <div class="flex items-center gap-3">
              <span class="select-none text-lg">{EMOJI[i]}</span>
              <input
                class="field"
                type="text"
                maxLength={50}
                placeholder={`Option ${i + 1}`}
                value={opt}
                onInput={(e) => setOptions(options.map((o, j) => (i === j ? (e.target as HTMLInputElement).value : o)))}
              />
            </div>
          ))}
        </div>

        <button class="mt-5 text-sm font-semibold text-[var(--color-ink-soft)] hover:text-[var(--color-brand-deep)]" onClick={() => setShowAdvanced(!showAdvanced)}>
          {showAdvanced ? "− Hide" : "+ Reply to a post"} (optional)
        </button>
        {showAdvanced && (
          <input
            class="field mt-3"
            type="text"
            maxLength={300}
            placeholder="https://bsky.app/profile/…/post/…  or  at://…"
            value={replyTo}
            onInput={(e) => setReplyTo((e.target as HTMLInputElement).value)}
          />
        )}

        <div class="mt-7 flex items-center gap-4">
          <button class="btn btn-primary" disabled={!canPost || busy} onClick={post}>
            {busy ? "Posting…" : "Post poll"}
          </button>
          {!canPost && <span class="text-sm text-[var(--color-ink-faint)]">Add a question and at least two options.</span>}
        </div>
        {error && <p class="mt-4 text-sm font-medium text-red-600">{error}</p>}
      </div>

      {/* Live preview */}
      <div class="lg:sticky lg:top-6 lg:self-start">
        <p class="mb-2 ml-1 text-sm font-semibold text-[var(--color-ink-faint)]">Preview</p>
        <div class="card p-6">
          <div class="flex items-center gap-3">
            {account.avatar
              ? <img src={account.avatar} alt="" width={36} height={36} class="h-9 w-9 rounded-full object-cover" />
              : <div class="h-9 w-9 rounded-full" style="background: linear-gradient(135deg, #1185fe, #073a86)"></div>}
            <div class="leading-tight">
              <p class="font-semibold">{account.displayName ?? account.handle}</p>
              <p class="text-xs text-[var(--color-ink-faint)]">@{account.handle}</p>
            </div>
          </div>
          <p class="mt-4 min-h-7 text-lg font-semibold">{question || <span class="text-[var(--color-ink-faint)]">Your question…</span>}</p>
          <div class="mt-3 space-y-2">
            {(activeOptions.length ? activeOptions : ["Option 1", "Option 2"]).map((o, i) => (
              <div class="flex items-center gap-2 rounded-xl border px-3 py-2 text-[0.95rem]" style="border-color: var(--color-line)">
                <span>{EMOJI[i]}</span>
                <span class={activeOptions.length ? "" : "text-[var(--color-ink-faint)]"}>{o}</span>
              </div>
            ))}
          </div>
          <p class="mt-3 text-sm text-[var(--color-ink-faint)]">📊 Show results</p>
        </div>
      </div>
    </div>
  );
}
