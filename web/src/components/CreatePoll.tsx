import { useEffect, useState } from "preact/hooks";
import { useStore } from "@nanostores/preact";
import { $account, $authReady, getAgent, initSession, signIn } from "../lib/session";
import { makeRpc } from "../lib/oauth";
import { composedText, generatePollText, graphemeLen, postUriToBskyLink } from "../lib/poll";
import { type Audience, clearPendingVote, createPrivatePoll, createPublicPoll, getPendingVote, listRecords, POLL_SPEC } from "../lib/atpoll";
import { detectFacets } from "../lib/richtext";
import Composer from "./Composer";
import FlipCard from "./FlipCard";

const EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const MAX_OPTIONS = 10;
const MAX_IMAGES = 4;
const MAX_GRAPHEMES = 300;

const DURATIONS: { key: string; label: string; ms: number }[] = [
  { key: "none", label: "No end date", ms: 0 },
  { key: "1h", label: "1 hour", ms: 3600e3 },
  { key: "6h", label: "6 hours", ms: 6 * 3600e3 },
  { key: "24h", label: "1 day", ms: 24 * 3600e3 },
  { key: "3d", label: "3 days", ms: 3 * 86400e3 },
  { key: "7d", label: "1 week", ms: 7 * 86400e3 },
];

interface Img { file: File; alt: string; url: string }

// The one choice that actually matters to a normal user: how much do you trust
// the count? "Verified" votes are signed records on the network — independently
// provable, one per account (and public). "Anonymous" votes need no sign-in and
// are counted best-effort by poll.blue. Everything technical (on-network records
// vs centralized tally, per-account dedup, sealing) follows from that. Verified is
// the new on-network path and is still alpha.
type VoteModel = "verified" | "anonymous";
// `tip` is the short balloon-help summary; the full technical breakdown lives on
// the card's flip side ("What this writes").
const VOTE_MODELS: { key: VoteModel; icon: string; title: string; alpha: boolean; blurb: string; tip: string }[] = [
  { key: "verified", icon: "🛡️", title: "Verified", alpha: true,
    blurb: "Each vote is a signed record on the voter's own account — independently provable, one per account. Votes are public.",
    tip: "Poll and every vote are records on the AT Protocol network; the tally is just a count of vote backlinks, so anyone can recount it. Votes are public." },
  { key: "anonymous", icon: "🕶️", title: "Anonymous", alpha: false,
    blurb: "One tap to vote — no sign-in, no record of who voted. Counted best-effort by poll.blue.",
    tip: "The poll is a record on-network, but votes are tallied in poll.blue's database keyed to the poll's at-uri — one per person by IP, and no record of who voted for what." },
];

// Plain-language tradeoffs, shown on demand under the two choices.
const VOTE_MODEL_DETAILS: { key: VoteModel; pros: string[] }[] = [
  { key: "verified", pros: [
    "Provable: anyone can recount it — no need to trust poll.blue",
    "One vote per account (voters sign in with Bluesky)",
    "The catch: votes are public — everyone sees how each person voted",
    "Optional secret ballot hides results until the poll closes",
  ] },
  { key: "anonymous", pros: [
    "No account or sign-in needed — just tap to vote",
    "No public record of who voted for what",
    "Best-effort count by poll.blue (one per person, by IP)",
    "The catch: you can't independently verify the tally",
  ] },
];

function AlphaTag() {
  return (
    <span class="rounded-full bg-amber-100 px-1.5 py-0.5 text-[0.58rem] font-extrabold uppercase tracking-wider text-amber-700">Alpha</span>
  );
}

// Remember the creator's last verified/anonymous choice across sessions, and
// default to ANONYMOUS so anyone who's been posting anonymous polls is never
// silently switched onto verified, on-network voting without choosing it. (Key
// name kept + old "public"/"private" values still read, for back-compat.)
const VOTE_MODEL_KEY = "pb_privacy";
function readStoredRecording(): "network" | "legacy" {
  try {
    const v = localStorage.getItem(VOTE_MODEL_KEY);
    if (v === "verified" || v === "public") return "network";
    if (v === "anonymous" || v === "private") return "legacy";
  } catch { /* ignore */ }
  return "legacy";
}

export default function CreatePoll() {
  const account = useStore($account);
  const ready = useStore($authReady);

  const [body, setBody] = useState("");
  const [options, setOptions] = useState(["", "", ""]);
  const [images, setImages] = useState<Img[]>([]);
  const [replyTo, setReplyTo] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [recording, setRecording] = useState<"network" | "legacy">(readStoredRecording);
  const [results, setResults] = useState<"live" | "sealed">("live");
  const [duration, setDuration] = useState("none");
  const [gate, setGate] = useState<"none" | "followers" | "list">("none");
  const [myLists, setMyLists] = useState<{ uri: string; name: string }[]>([]);
  const [listUri, setListUri] = useState("");

  const [signInHandle, setSignInHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ postUri: string; visibleId: string } | null>(null);

  const updateOption = (i: number, val: string) => setOptions(options.map((o, j) => (i === j ? val : o)));
  const addOption = () => { if (options.length < MAX_OPTIONS) setOptions([...options, ""]); };
  const removeOption = (i: number) => { if (options.length > 2) setOptions(options.filter((_, j) => j !== i)); };
  const chooseResults = (r: "live" | "sealed") => { setResults(r); if (r === "sealed" && duration === "none") setDuration("24h"); };
  const sealedMode = recording === "network" && results === "sealed";

  // "Public vs private" is derived from the recording mode; choosing it just sets
  // the underlying knobs, so post() and the record shapes are unchanged. Secret
  // ballot is a refinement of public voting (results sealed until close).
  const voteModel: VoteModel = recording === "network" ? "verified" : "anonymous";
  function chooseVoteModel(m: VoteModel) {
    try { localStorage.setItem(VOTE_MODEL_KEY, m); } catch { /* ignore */ }
    if (m === "verified") setRecording("network");
    else { setRecording("legacy"); setResults("live"); setGate("none"); }
  }
  // Arrow-key navigation for the verified/anonymous radiogroup (a11y).
  function voteModelKeyNav(e: KeyboardEvent) {
    if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(e.key)) return;
    e.preventDefault();
    const order: VoteModel[] = ["verified", "anonymous"];
    const dir = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
    const next = order[(order.indexOf(voteModel) + dir + order.length) % order.length];
    chooseVoteModel(next);
    const btns = (e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="radio"]');
    btns[order.indexOf(next)]?.focus();
  }

  function addImages(files: FileList | null) {
    if (!files) return;
    const room = MAX_IMAGES - images.length;
    const next = Array.from(files).slice(0, room).map((file) => ({ file, alt: "", url: URL.createObjectURL(file) }));
    setImages([...images, ...next]);
  }
  const removeImage = (i: number) => { URL.revokeObjectURL(images[i].url); setImages(images.filter((_, j) => j !== i)); };
  const updateAlt = (i: number, alt: string) => setImages(images.map((im, j) => (i === j ? { ...im, alt } : im)));

  useEffect(() => { initSession(); }, []);

  // Return-from-OAuth: complete a pending vote (see the results page sign-in flow).
  useEffect(() => {
    if (!ready || !account) return;
    const pending = getPendingVote();
    if (pending) { clearPendingVote(); location.assign(`/p/${pending.id}/${pending.option}`); }
  }, [ready, account]);

  // The signed-in user's lists (for the "only a list" gate).
  useEffect(() => {
    if (!account) return;
    listRecords(account.did, "app.bsky.graph.list")
      .then((recs) => setMyLists(recs.map((r) => ({ uri: r.uri, name: String((r.value as { name?: string }).name ?? "Untitled list") }))))
      .catch(() => setMyLists([]));
  }, [account?.did]);

  const activeOptions = options.map((o) => o.trim()).filter(Boolean);
  const bodyText = body.trim();
  const postLen = graphemeLen(composedText(bodyText, activeOptions.length ? activeOptions : []));
  const over = postLen > MAX_GRAPHEMES;
  const canPost = bodyText.length > 0 && activeOptions.length >= 2 && !over;

  async function doSignIn() {
    setError("");
    const h = signInHandle.trim().replace(/^@/, "");
    if (!h) return setError("Enter your Bluesky handle.");
    setBusy(true);
    try { await signIn(h); } catch (e) { setError((e as Error).message); setBusy(false); }
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
    const rec = await rpc.get("com.atproto.repo.getRecord", { params: { repo: did, collection: "app.bsky.feed.post", rkey } });
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
      const rpc = makeRpc(agent);
      const reply = replyTo.trim() ? await resolveReply(rpc, replyTo.trim()) : undefined;
      const bodyFacets = await detectFacets(bodyText);

      // Upload any images → an app.bsky.embed.images embed.
      let embed: Record<string, unknown> | undefined;
      if (images.length) {
        const uploaded = [];
        for (const im of images) {
          const up = await rpc.post("com.atproto.repo.uploadBlob", { input: im.file });
          if (!up.ok) throw new Error(up.data?.error ?? "Image upload failed.");
          uploaded.push({ image: up.data.blob, alt: im.alt });
        }
        embed = { $type: "app.bsky.embed.images", images: uploaded };
      }

      const createPost = async (visibleId: string) => {
        const { text, links, pollFacets } = generatePollText({
          visibleId,
          body: { text: bodyText, facets: bodyFacets },
          answers: activeOptions,
          origin: location.origin,
        });
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
              ...(embed ? { embed } : {}),
            },
          },
        });
        if (!created.ok) throw new Error(created.data?.error ?? "Failed to create the post.");
        return { uri: created.data.uri as string, cid: created.data.cid as string };
      };

      if (recording === "network") {
        const dur = DURATIONS.find((dd) => dd.key === duration);
        const endsAt = dur && dur.ms > 0 ? new Date(Date.now() + dur.ms).toISOString() : undefined;
        if (sealedMode && !endsAt) throw new Error("Sealed polls need an end time.");
        let audience: Audience | undefined;
        if (gate === "followers") audience = { gate: "followers" };
        else if (gate === "list") {
          if (!listUri) throw new Error("Pick a list to gate this poll.");
          audience = { gate: "list", list: listUri };
        }
        let sealed: { round: number; chain: string } | undefined;
        if (sealedMode) {
          const { sealParamsFor } = await import("../lib/timelock");
          sealed = await sealParamsFor(new Date(endsAt!).getTime());
        }
        const { id, postUri } = await createPublicPoll(
          rpc, agent.sub,
          { question: bodyText, answers: activeOptions, endsAt, audience, mode: sealedMode ? "sealed" : "public", sealed },
          createPost,
        );
        setResult({ postUri, visibleId: id });
      } else {
        // Private poll: one blue.poll.poll.poll record (mode centralized) + the
        // post, addressed by did~rkey. No registration — votes are tallied in
        // poll.blue's DB by the record's at-uri. The record write must succeed,
        // since the poll is addressed by it.
        const { id, postUri } = await createPrivatePoll(
          rpc, agent.sub,
          { question: bodyText, answers: activeOptions },
          createPost,
        );
        setResult({ postUri, visibleId: id });
      }
    } catch (e) {
      setError((e as Error).message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setResult(null); setBody(""); setOptions(["", "", ""]); setReplyTo("");
    images.forEach((im) => URL.revokeObjectURL(im.url));
    setImages([]); setResults("live"); setDuration("none"); setGate("none"); setListUri("");
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
        <p class="mt-2 text-[var(--color-ink-soft)]">Your poll is live in the Atmosphere! Watch the votes land here.</p>
        <div class="mt-7 flex flex-wrap justify-center gap-3">
          <a class="btn btn-primary" href={`/p/${result.visibleId}`}>View results</a>
          <a class="btn btn-ghost" href={postUriToBskyLink(result.postUri)} target="_blank" rel="noreferrer">Open on Bluesky</a>
          <button class="btn btn-ghost" onClick={reset}>New poll</button>
        </div>
      </div>
    );
  }

  if (!account) {
    return (
      <div class="card rise p-8 sm:p-10">
        <span class="pill">Sign in to continue</span>
        <h2 class="mt-4 text-3xl">Sign in through the Atmosphere</h2>
        <p class="mt-2 max-w-md text-[var(--color-ink-soft)]">No need to create another account - simply log in using your Bluesky handle.</p>
        <div class="mt-6 flex flex-col gap-3 sm:flex-row">
          <input class="field flex-1" type="text" placeholder="oakley.bsky.social" value={signInHandle} autocomplete="username"
            onInput={(e) => setSignInHandle((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === "Enter") doSignIn(); }} />
          <button class="btn btn-primary" disabled={busy || !signInHandle.trim()} onClick={doSignIn}>{busy ? "Redirecting…" : "Continue"}</button>
        </div>
        {error && <p class="mt-4 text-sm font-medium text-red-600">{error}</p>}
      </div>
    );
  }

  return (
    <div class="rise grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
      {/* ---- Composer (main) ---- */}
      <div class="card flex flex-col p-6 sm:p-7">
        <div class="flex items-center gap-3">
          {account.avatar
            ? <img src={account.avatar} alt="" width={40} height={40} class="h-10 w-10 rounded-full object-cover" />
            : <div class="h-10 w-10 rounded-full" style="background: linear-gradient(135deg, #1185fe, #073a86)"></div>}
          <div class="leading-tight">
            <p class="font-semibold">{account.displayName ?? account.handle}</p>
            <p class="text-xs text-[var(--color-ink-faint)]">@{account.handle}</p>
          </div>
        </div>

        {/* One post canvas: the question and the poll options live together, so
            the options read as continuation lines of the very same post. */}
        <div class="mt-4 post-canvas flex flex-1 flex-col">
          <Composer bare value={body} onChange={setBody} placeholder="Are they called skeets, posts, skoot, bleets, or something else?" />

          <div class="mt-3 space-y-2.5">
            {options.map((opt, i) => (
              // A <label> so a click anywhere on the row (number, padding) lands
              // the cursor in the text field.
              <label class="option-row group flex items-center gap-3.5 rounded-2xl px-3.5 py-3">
                <span class="poll-num grid h-9 w-9 shrink-0 select-none place-items-center rounded-full font-display text-base font-extrabold leading-none">{i + 1}</span>
                <input
                  class="min-w-0 flex-1 bg-transparent text-base font-semibold outline-none placeholder:font-normal placeholder:text-[var(--color-ink-faint)]"
                  type="text"
                  maxLength={50}
                  placeholder={`Option ${i + 1}`}
                  value={opt}
                  onInput={(e) => updateOption(i, (e.target as HTMLInputElement).value)}
                />
                {options.length > 2 && (
                  <button type="button" onClick={() => removeOption(i)} aria-label={`Remove option ${i + 1}`}
                    class="hit grid h-7 w-7 shrink-0 place-items-center rounded-full text-[var(--color-ink-faint)] opacity-0 transition-all hover:bg-red-50 hover:text-red-600 group-hover:opacity-100">✕</button>
                )}
              </label>
            ))}
          </div>
          {options.length < MAX_OPTIONS && (
            <button type="button" onClick={addOption}
              class="mt-2.5 flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[var(--color-line)] py-3 text-sm font-bold text-[var(--color-brand-deep)] transition-colors hover:border-[var(--color-brand)] hover:bg-[var(--color-brand-tint)]">
              <span class="poll-num grid h-6 w-6 place-items-center rounded-full text-base font-extrabold leading-none">+</span>
              Add option
            </button>
          )}
          <p class="mt-3 px-1 text-sm font-semibold text-[var(--color-brand-deep)]">📊 Show results</p>

          {/* Photos render as part of the post preview, right in the canvas. */}
          {images.length > 0 && (
            <div class="mt-3 flex flex-wrap gap-2.5 px-1">
              {images.map((im, i) => (
                <div class="w-[4.5rem]">
                  <div class="relative">
                    <img src={im.url} alt="" class="h-[4.5rem] w-[4.5rem] rounded-lg object-cover" style="box-shadow: var(--shadow-cloud)" />
                    <button type="button" onClick={() => removeImage(i)} aria-label="Remove image"
                      class="hit absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-white text-xs text-red-600 shadow">✕</button>
                  </div>
                  <input class="mt-1 w-full rounded bg-[var(--color-paper-2)] px-1.5 py-0.5 text-[0.65rem] outline-none placeholder:text-[var(--color-ink-faint)]"
                    placeholder="alt" value={im.alt} onInput={(e) => updateAlt(i, (e.target as HTMLInputElement).value)} />
                </div>
              ))}
            </div>
          )}

          {/* Composer toolbar — media lives inside the canvas, not on its own row. */}
          <div class="mt-3 flex items-center gap-2 border-t pt-2.5" style="border-color: rgba(120,160,210,0.3)">
            {images.length < MAX_IMAGES && (
              <label class="grid h-9 w-9 cursor-pointer place-items-center rounded-lg text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-paper-2)] hover:text-[var(--color-brand-deep)]" title="Add a photo" aria-label="Add a photo">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="3" y="5" width="18" height="14" rx="2.5" stroke="currentColor" stroke-width="1.8" />
                  <circle cx="8.5" cy="10" r="1.6" stroke="currentColor" stroke-width="1.8" />
                  <path d="M4 17l4.5-4.5 4 4L16 13l4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <input type="file" accept="image/*" multiple class="hidden" onChange={(e) => { addImages((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ""; }} />
              </label>
            )}
            <span class="text-xs text-[var(--color-ink-faint)]">
              {images.length > 0 ? `${images.length}/${MAX_IMAGES} photo${images.length > 1 ? "s" : ""}` : "Add a photo (optional)"}
            </span>
          </div>
        </div>

        {/* The important warning at post time is *visibility*: will voters' votes
            be public or private? The whole molded placard is a toggle. */}
        <button type="button" aria-pressed={voteModel === "verified"}
          onClick={() => chooseVoteModel(voteModel === "verified" ? "anonymous" : "verified")}
          class={`mode-plate mode-toggle mt-6 flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 px-3.5 py-2.5 text-left text-sm ${voteModel === "verified" ? "mode-plate--public" : "mode-plate--private"}`}>
          <span class="mode-emblem" aria-hidden="true">{voteModel === "verified" ? "👁️" : "🕶️"}</span>
          <span class="font-extrabold uppercase tracking-wide">{voteModel === "verified" ? "Public votes" : "Private votes"}</span>
          <span class="opacity-80">— {voteModel === "verified" ? "everyone can see how each person voted" : "no one can see who voted for what"}.</span>
          <span class="ml-auto inline-flex items-center gap-1.5 whitespace-nowrap font-bold">
            <span aria-hidden="true">⇄</span> tap to switch
          </span>
        </button>

        <div class="mt-5 flex items-center gap-4">
          <button class="btn btn-primary !px-8 !py-3.5 text-base" disabled={!canPost || busy} onClick={post}>
            {busy ? "Posting…" : "Post poll"}
            {!busy && (
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M4 12h14M12 5l7 7-7 7" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            )}
          </button>
          <span class={`rounded-full px-3 py-1 text-sm font-bold ${over ? "bg-red-50 text-red-600" : "text-[var(--color-ink-faint)]"}`}>{postLen}/{MAX_GRAPHEMES}</span>
          {!canPost && !over && <span class="text-sm text-[var(--color-ink-faint)]">Add a question and 2+ options.</span>}
        </div>
        {error && <p class="mt-4 text-sm font-medium text-red-600">{error}</p>}
      </div>

      {/* ---- Settings (sidebar) ---- */}
      <FlipCard
        frontClass="card p-6 sm:p-7"
        backClass="card p-6 sm:p-7"
        infoLabel="What this writes"
        front={() => (
          <>
            <span class="pill">Poll setup</span>

            <p id="votemodel-label" class="mt-5 text-sm font-semibold text-[var(--color-ink-soft)]">How are votes counted?</p>
            <div class="mt-2 grid gap-2" role="radiogroup" aria-labelledby="votemodel-label" onKeyDown={voteModelKeyNav}>
              {VOTE_MODELS.map((t) => {
                const active = voteModel === t.key;
                return (
                  <button type="button" role="radio" aria-checked={active} tabIndex={active ? 0 : -1}
                    data-tip={t.tip} data-tip-side="bottom"
                    onClick={() => chooseVoteModel(t.key)} class="rounded-xl border p-3 text-left transition-colors"
                    style={`border-color:${active ? "var(--color-brand)" : "var(--color-line)"}; background:${active ? "var(--color-brand-tint)" : "transparent"}`}>
                    <span class="flex items-center gap-2 text-sm font-semibold">
                      <span class="grid h-3.5 w-3.5 place-items-center rounded-full border" style={`border-color:${active ? "var(--color-brand)" : "var(--color-ink-faint)"}`}>
                        {active && <span class="h-1.5 w-1.5 rounded-full" style="background: var(--color-brand)"></span>}
                      </span>
                      <span class="text-base leading-none">{t.icon}</span>
                      {t.title}
                      {t.alpha && <AlphaTag />}
                    </span>
                    <span class="mt-1 block text-xs leading-snug text-[var(--color-ink-soft)]">{t.blurb}</span>
                  </button>
                );
              })}
            </div>

            <button class="mt-2 text-xs font-semibold text-[var(--color-brand-deep)] hover:underline" onClick={() => setShowCompare(!showCompare)}>
              {showCompare ? "Hide the tradeoffs" : "How do these differ?"}
            </button>
            {showCompare && (
              <div class="mt-2 grid gap-2.5">
                {VOTE_MODEL_DETAILS.map((d) => (
                  <div class="rounded-xl border p-3" style="border-color: var(--color-line); background: var(--color-paper-2)">
                    <p class="text-xs font-bold uppercase tracking-wide text-[var(--color-ink-soft)]">
                      {VOTE_MODELS.find((o) => o.key === d.key)!.title}
                    </p>
                    <ul class="mt-1.5 space-y-1">
                      {d.pros.map((p) => (
                        <li class="flex gap-1.5 text-xs leading-snug text-[var(--color-ink-soft)]">
                          <span class="text-[var(--color-brand)]">·</span>{p}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}

            {voteModel === "verified" && (
              <p class="mt-3 flex items-start gap-1.5 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-snug text-amber-800">
                <span aria-hidden="true">⚗️</span>
                <span>Verified (on-network) polling is in <strong>alpha</strong> — it writes new records to your Bluesky account and the format may still change.</span>
              </p>
            )}

            {voteModel === "verified" && (
              <>
                <label class="mt-5 flex cursor-pointer items-start gap-2.5">
                  <input type="checkbox" class="mt-0.5" checked={sealedMode} onChange={(e) => chooseResults((e.target as HTMLInputElement).checked ? "sealed" : "live")} />
                  <span class="text-sm">
                    <span class="font-semibold text-[var(--color-ink-soft)]">🔒 Secret ballot</span>
                    <span class="mt-0.5 block text-xs leading-snug text-[var(--color-ink-faint)]">Keep the running tally hidden until the poll closes, then reveal it. Votes are timelock-encrypted.</span>
                  </span>
                </label>

                <p class="mt-5 text-sm font-semibold text-[var(--color-ink-soft)]">
                  Closes {sealedMode && <span class="font-normal text-[var(--color-ink-faint)]">(required)</span>}
                </p>
                <select class="field mt-2" value={duration} onChange={(e) => setDuration((e.target as HTMLSelectElement).value)}>
                  {DURATIONS.filter((d) => !sealedMode || d.key !== "none").map((d) => <option value={d.key}>{d.label}</option>)}
                </select>
              </>
            )}

            <button class="mt-5 text-sm font-semibold text-[var(--color-ink-soft)] hover:text-[var(--color-brand-deep)]" onClick={() => setShowAdvanced(!showAdvanced)}>
              {showAdvanced ? "− Fewer options" : "+ More options"}
            </button>
            {showAdvanced && (
              <div class="mt-3 space-y-5">
                {recording === "network" && (
                  <div>
                    <p class="text-sm font-semibold text-[var(--color-ink-soft)]">Limit who can vote</p>
                    <select class="field mt-2" value={gate} onChange={(e) => setGate((e.target as HTMLSelectElement).value as typeof gate)}>
                      <option value="none">Anyone can vote</option>
                      <option value="followers">Only my followers</option>
                      <option value="list">Only people on a list</option>
                    </select>
                    {gate === "list" && (
                      myLists.length > 0 ? (
                        <select class="field mt-2" value={listUri} onChange={(e) => setListUri((e.target as HTMLSelectElement).value)}>
                          <option value="">Choose one of your lists…</option>
                          {myLists.map((l) => <option value={l.uri}>{l.name}</option>)}
                        </select>
                      ) : (
                        <p class="mt-2 text-sm text-[var(--color-ink-faint)]">No lists on your account yet — make one on Bluesky.</p>
                      )
                    )}
                  </div>
                )}
                <div>
                  <p class="text-sm font-semibold text-[var(--color-ink-soft)]">Reply to a post <span class="font-normal text-[var(--color-ink-faint)]">(optional)</span></p>
                  <input class="field mt-2" type="text" maxLength={300} placeholder="https://bsky.app/profile/…/post/…  or  at://…" value={replyTo}
                    onInput={(e) => setReplyTo((e.target as HTMLInputElement).value)} />
                </div>
              </div>
            )}

          </>
        )}
        back={() => (
          <>
            <h2 class="text-2xl">How it works</h2>
            <p class="mt-2 text-sm text-[var(--color-ink-soft)]">Both vote models, in full — your current pick is highlighted.</p>

            <div class="tech-details !border-t-0 mt-4 space-y-3">
              <div class="rounded-xl border p-3.5" style={`border-color:${voteModel === "verified" ? "var(--color-brand)" : "var(--color-line)"}; background:${voteModel === "verified" ? "var(--color-brand-tint)" : "transparent"}`}>
                <h3 class="flex items-center gap-2 text-sm font-bold">
                  <span class="text-base leading-none">🛡️</span> Verified <AlphaTag />
                  {voteModel === "verified" && <span class="ml-auto rounded-full bg-[var(--color-brand)] px-1.5 py-0.5 text-[0.55rem] font-extrabold uppercase tracking-wide text-white">Picked</span>}
                </h3>
                <ul class="mt-2 space-y-1.5 text-xs leading-relaxed text-[var(--color-ink-soft)]">
                  <li>Writes a <code>blue.poll.poll.poll</code> record + one <code>blue.poll.poll.option</code> per option to your repo, plus the <code>app.bsky.feed.post</code>. Addressed by <code>did~rkey</code>.</li>
                  <li>Each vote is a <code>blue.poll.poll.vote</code> record in the <em>voter's own</em> repo, pointing at the chosen option's at-uri.</li>
                  <li>The tally is a live count of those vote backlinks (via Constellation) — no server holds the number, so anyone can recount it independently.</li>
                  <li><strong>Secret ballot</strong> adds drand timelock encryption: choices are unreadable — even to poll.blue — until the close time, then revealed and tallied.</li>
                </ul>
              </div>

              <div class="rounded-xl border p-3.5" style={`border-color:${voteModel === "anonymous" ? "var(--color-brand)" : "var(--color-line)"}; background:${voteModel === "anonymous" ? "var(--color-brand-tint)" : "transparent"}`}>
                <h3 class="flex items-center gap-2 text-sm font-bold">
                  <span class="text-base leading-none">🕶️</span> Anonymous
                  {voteModel === "anonymous" && <span class="ml-auto rounded-full bg-[var(--color-brand)] px-1.5 py-0.5 text-[0.55rem] font-extrabold uppercase tracking-wide text-white">Picked</span>}
                </h3>
                <ul class="mt-2 space-y-1.5 text-xs leading-relaxed text-[var(--color-ink-soft)]">
                  <li>Writes one <code>blue.poll.poll.poll</code> record (mode <code>centralized</code>) to your repo, plus the <code>app.bsky.feed.post</code>. Addressed by <code>did~rkey</code> like a verified poll — but with no per-option records.</li>
                  <li>Voting is an anonymous link tap; poll.blue counts it in its database, keyed to the poll's at-uri, deduped one-per-person by IP (best-effort). No per-voter record exists.</li>
                  <li>No on-network vote records and no Constellation — the count lives only in poll.blue, so it can't be independently verified.</li>
                </ul>
              </div>

              <p class="text-xs text-[var(--color-ink-faint)]">Every <code>blue.poll.*</code> record is stamped <code>spec: {POLL_SPEC}</code>. Manage or delete polls from <a class="text-[var(--color-brand-deep)] hover:underline" href="/mine">My Polls</a>.</p>
            </div>
          </>
        )}
      />
    </div>
  );
}
