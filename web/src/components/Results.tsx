import { useEffect, useRef, useState } from "preact/hooks";
import { useStore } from "@nanostores/preact";
import { postUriToBskyLink } from "../lib/poll";
import { $account, $authReady, getAgent, initSession, signIn } from "../lib/session";
import { makeRpc } from "../lib/oauth";
import FlipCard from "./FlipCard";
import {
  type Audience,
  castVote,
  clearPendingVote,
  decodePublicId,
  deleteVote,
  getPollRecord,
  isEligible,
  isPublicId,
  pollOptionTexts,
  pollOptionUris,
  type Profile,
  resolveProfiles,
  sealedVoteCount,
  setPendingVote,
  tallyGatedPoll,
  tallyPublicPoll,
  tallySealedPoll,
  voteRecordUri,
} from "../lib/atpoll";

interface PollResults {
  posted_by?: string;
  created_at?: string;
  post_uri?: string;
  question: string;
  answers: string[];
  results: number[]; // [abstentions, ...votesPerOption]
  // public-poll extras:
  isPublic?: boolean;
  pollUri?: string;
  pollCid?: string;
  endsAt?: string;
  optionUris?: Array<string | undefined>;
  audience?: Audience;
  cast?: number; // total votes before gating (gated), or sealed participation count
  voters?: string[][]; // sample of voter DIDs per option (index 0 = option 1)
  mode?: string; // "public" | "sealed"
  sealed?: { round?: number; chain?: string };
}

type Status = "loading" | "ok" | "notfound" | "error";

const REFRESH_MS = 5000;
const SKIP_CONFIRM_KEY = "pb_skip_vote_confirm";

// A sealed vote can't be decrypted (even by you) until close, so remember your
// own choice on this device to show which option you sealed.
function readSealedLocal(id: string): number {
  try { return parseInt(localStorage.getItem(`pb_sealed_${id}`) || "0", 10) || 0; } catch { return 0; }
}
function writeSealedLocal(id: string, n: number) {
  try { localStorage.setItem(`pb_sealed_${id}`, String(n)); } catch { /* ignore */ }
}

function readParams() {
  const url = new URL(location.href);
  const m = location.pathname.match(/^\/p\/([^/]+)(?:\/(\d+))?/);
  const id = m?.[1] ?? url.searchParams.get("id") ?? "";
  const voteIntent = m?.[2] ? Number(m[2]) : Number(url.searchParams.get("v") ?? "0");
  return { id, voteIntent };
}

async function resolveDisplayHandle(did: string): Promise<string> {
  try {
    const r = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
    );
    if (r.ok) return ((await r.json()) as { handle?: string }).handle ?? "";
  } catch { /* cosmetic */ }
  return "";
}

function fmtRemaining(ms: number): string {
  if (ms <= 0) return "closed";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s % 60}s`;
}

// Overlay the signed-in voter's current choice onto the authoritative tally, so
// their vote shows instantly (and stays put across live refreshes) even before
// Constellation reindexes. Idempotent once the network catches up.
function withMyVote(d: PollResults, myVote: number, did?: string): { results: number[]; voters: string[][] } {
  const results = d.results.slice();
  const voters = (d.voters ?? []).map((l) => l.slice());
  if (!d.isPublic || !did || !myVote) return { results, voters };
  let cur = -1;
  voters.forEach((l, i) => { if (l.includes(did)) cur = i + 1; });
  if (cur === myVote) return { results, voters };
  if (cur > 0) {
    voters[cur - 1] = voters[cur - 1].filter((x) => x !== did);
    results[cur] = Math.max(0, (results[cur] ?? 0) - 1);
  }
  if (voters[myVote - 1] && !voters[myVote - 1].includes(did)) voters[myVote - 1] = [did, ...voters[myVote - 1]];
  results[myVote] = (results[myVote] ?? 0) + 1;
  return { results, voters };
}

export default function Results() {
  const account = useStore($account);
  const ready = useStore($authReady);
  const [{ id, voteIntent }] = useState(readParams);
  const publicPoll = isPublicId(id);

  const [state, setState] = useState<Status>("loading");
  const [data, setData] = useState<PollResults | null>(null);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [voted, setVoted] = useState(0); // private polls only
  const [myVote, setMyVote] = useState(0); // public polls
  const [needLogin, setNeedLogin] = useState(false);
  const [voteCast, setVoteCast] = useState(false);
  const [castError, setCastError] = useState("");
  const [handle, setHandle] = useState("");
  const [creatorHandle, setCreatorHandle] = useState(""); // resolved from the creator DID (public polls)
  const [signinBusy, setSigninBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [confirmOption, setConfirmOption] = useState(0);
  const [dontAsk, setDontAsk] = useState(false);
  const [myEligible, setMyEligible] = useState<boolean | null>(null);
  const [castFlash, setCastFlash] = useState(false);
  const [skipConfirm, setSkipConfirm] = useState(() => {
    try { return localStorage.getItem(SKIP_CONFIRM_KEY) === "1"; } catch { return false; }
  });

  const interactedRef = useRef(false);
  const intentHandledRef = useRef(false);

  useEffect(() => {
    initSession();
  }, []);

  // Gated polls must enumerate + filter voters; ungated use the fast count path.
  function computeTally(optionUris: Array<string | undefined>, audience?: Audience, creatorDid?: string) {
    return audience && creatorDid
      ? tallyGatedPoll(id, optionUris, audience, creatorDid)
      : tallyPublicPoll(id, optionUris);
  }
  const castTotal = (tallies: { count: number; cast?: number }[]) =>
    tallies.some((t) => t.cast != null) ? tallies.reduce((a, t) => a + (t.cast ?? t.count), 0) : undefined;

  // Initial load: fetch the poll + first tally. No auth needed for either path.
  useEffect(() => {
    if (!id) return setState("notfound");
    (async () => {
      try {
        if (publicPoll) {
          const dec = decodePublicId(id);
          if (!dec) return setState("notfound");
          const rec = await getPollRecord(dec.did, dec.rkey);
          if (!rec?.value) return setState("notfound");
          // A centralized (anonymous) poll record is just a management handle;
          // its tally lives in the poll.blue DB under visibleId. Route there.
          if (rec.value.mode === "centralized" && rec.value.visibleId) {
            location.replace(`/p/${rec.value.visibleId}`);
            return;
          }
          const answers = pollOptionTexts(rec);
          const base = {
            isPublic: true,
            question: rec.value.question,
            answers,
            created_at: rec.value.createdAt,
            endsAt: rec.value.endsAt,
            post_uri: rec.value.post?.uri,
            posted_by: dec.did,
            pollUri: rec.uri,
            pollCid: rec.cid,
          };
          setState("ok");
          // Resolve the creator's handle into its own state so a bare DID never
          // renders (and so it can't be dropped by racing the tally's setData).
          resolveDisplayHandle(dec.did).then((h) => h && setCreatorHandle(h));

          if (rec.value.mode === "sealed") {
            const audience = rec.value.audience;
            const closedNow = !!(rec.value.endsAt && Date.now() >= new Date(rec.value.endsAt).getTime());
            if (closedNow) {
              const tallies = await tallySealedPoll(rec.uri, answers.length, audience, dec.did);
              setData({ ...base, mode: "sealed", sealed: rec.value.sealed, audience, results: [0, ...tallies.map((t) => t.count)], voters: tallies.map((t) => t.voters), cast: castTotal(tallies) });
              resolveProfiles(tallies.flatMap((t) => t.voters)).then((p) => setProfiles((prev) => ({ ...prev, ...p })));
            } else {
              const cast = await sealedVoteCount(rec.uri);
              setData({ ...base, mode: "sealed", sealed: rec.value.sealed, audience, results: [0, ...answers.map(() => 0)], cast });
              const mine = readSealedLocal(id);
              if (mine) setMyVote(mine);
            }
          } else {
            const optionUris = pollOptionUris(rec);
            const audience = rec.value.audience;
            const tallies = await computeTally(optionUris, audience, dec.did);
            setData({
              ...base,
              mode: rec.value.mode ?? "public",
              optionUris,
              audience,
              results: [0, ...tallies.map((t) => t.count)],
              voters: tallies.map((t) => t.voters),
              cast: castTotal(tallies),
            });
            resolveProfiles(tallies.flatMap((t) => t.voters)).then((p) => setProfiles((prev) => ({ ...prev, ...p })));
          }
        } else {
          if (voteIntent > 0) {
            setVoted(voteIntent);
            await fetch(`/api/poll/${encodeURIComponent(id)}/vote`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ vote: voteIntent }),
            }).catch(() => {});
          }
          const resp = await fetch(`/api/poll/${encodeURIComponent(id)}`);
          if (resp.status === 404) return setState("notfound");
          if (!resp.ok) return setState("error");
          setData(await resp.json());
          setState("ok");
        }
      } catch {
        setState("error");
      }
    })();
  }, []);

  // Live tally: re-poll Constellation on an interval and when the tab refocuses.
  useEffect(() => {
    if (!publicPoll || !data) return;
    const sealed = data.mode === "sealed";
    const pollUri = data.pollUri;
    const endsAtMs = data.endsAt ? new Date(data.endsAt).getTime() : 0;
    const optionUris = data.optionUris ?? data.answers.map(() => undefined);
    const audience = data.audience;
    const creatorDid = decodePublicId(id)?.did;
    const tick = async () => {
      try {
        if (sealed) {
          // Only participation is knowable while open; the tally reveals at close.
          if (pollUri && !(endsAtMs && Date.now() >= endsAtMs)) {
            const cast = await sealedVoteCount(pollUri);
            setData((d) => (d ? { ...d, cast } : d));
          }
          return;
        }
        const tallies = await computeTally(optionUris, audience, creatorDid);
        setData((d) => (d ? { ...d, results: [0, ...tallies.map((t) => t.count)], voters: tallies.map((t) => t.voters), cast: castTotal(tallies) } : d));
        resolveProfiles(tallies.flatMap((t) => t.voters)).then((p) => setProfiles((prev) => ({ ...prev, ...p })));
        if (account && !interactedRef.current) {
          const idx = tallies.findIndex((t) => t.voters.includes(account.did));
          setMyVote(idx >= 0 ? idx + 1 : 0);
        }
      } catch { /* keep last good tally */ }
    };
    const iv = setInterval(tick, REFRESH_MS);
    const onVis = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
  }, [publicPoll, data?.answers.length, account?.did, data?.mode]);

  // When a sealed poll crosses its close time while open in the browser, reveal.
  const sealedRevealedRef = useRef(false);
  useEffect(() => {
    if (data?.mode !== "sealed" || !data.pollUri || sealedRevealedRef.current) return;
    if (!(data.endsAt && now >= new Date(data.endsAt).getTime())) return;
    sealedRevealedRef.current = true;
    (async () => {
      try {
        const tallies = await tallySealedPoll(data.pollUri!, data.answers.length, data.audience, decodePublicId(id)?.did);
        setData((d) => (d ? { ...d, results: [0, ...tallies.map((t) => t.count)], voters: tallies.map((t) => t.voters), cast: castTotal(tallies) } : d));
        resolveProfiles(tallies.flatMap((t) => t.voters)).then((p) => setProfiles((prev) => ({ ...prev, ...p })));
      } catch { sealedRevealedRef.current = false; }
    })();
  }, [now, data?.mode, data?.endsAt]);

  // Countdown ticker (only when the poll has an end date).
  useEffect(() => {
    if (!data?.endsAt) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [data?.endsAt]);

  // Is the signed-in voter eligible under the gate? (drives the "won't count" hint)
  useEffect(() => {
    if (!publicPoll || !data?.audience || !account) { setMyEligible(null); return; }
    const creatorDid = decodePublicId(id)?.did;
    if (!creatorDid) return;
    isEligible(data.audience, creatorDid, account.did).then(setMyEligible).catch(() => setMyEligible(null));
  }, [account?.did, data?.audience]);

  // Complete a vote arriving via /p/{id}/{n} (a tapped option link).
  useEffect(() => {
    if (!publicPoll || voteIntent <= 0 || !ready || !data || intentHandledRef.current) return;
    intentHandledRef.current = true;
    requestVote(voteIntent);
  }, [ready, data, publicPoll]);

  const isClosed = (d?: PollResults | null) => !!(d?.endsAt && Date.now() >= new Date(d.endsAt).getTime());

  // Human-readable description of who a gated poll is limited to.
  function gateAudienceLabel(a: Audience): string {
    return a.gate === "followers"
      ? (creatorHandle ? `@${creatorHandle}'s followers` : "the creator's followers")
      : "members of this poll's list";
  }

  // Gate a vote: closed? logged in? eligible? confirmation needed?
  function requestVote(n: number) {
    if (!publicPoll || n <= 0 || !data) return;
    if (isClosed(data)) return setCastError("This poll has closed.");
    if (!ready) return;
    setCastError("");
    // Tapping the option you already picked unchecks it — i.e. removes your vote.
    if (n === myVote) return void removeVote();
    if (!account) {
      setPendingVote(id, n);
      setNeedLogin(true);
      return;
    }
    // Ineligible voters are blocked outright (not just uncounted).
    if (data.audience && myEligible === false) {
      return setCastError(`Only ${gateAudienceLabel(data.audience)} can vote in this poll.`);
    }
    if (skipConfirm) performVote(n);
    else setConfirmOption(n);
  }

  // Actually write the vote record.
  async function performVote(n: number) {
    if (!data) return;
    interactedRef.current = true;
    if (!data.audience) setMyVote(n); // optimistic for the common ungated case
    try {
      const agent = await getAgent();
      if (!agent) return setNeedLogin(true);
      // Gated poll: verify eligibility against the network before writing, so an
      // ineligible voter is blocked even if the background check hadn't resolved.
      if (data.audience) {
        const creatorDid = decodePublicId(id)?.did;
        const ok = creatorDid ? await isEligible(data.audience, creatorDid, agent.sub).catch(() => true) : true;
        if (!ok) {
          setMyEligible(false);
          setMyVote(0);
          return setCastError(`Only ${gateAudienceLabel(data.audience)} can vote in this poll — nothing was recorded.`);
        }
        setMyVote(n); // eligible → reflect it now
      }
      const sealedRound = data.mode === "sealed" ? data.sealed?.round : undefined;
      await castVote(makeRpc(agent), agent.sub, {
        pollUri: data.pollUri!,
        pollCid: data.pollCid!,
        id,
        option: n,
        optionUri: data.optionUris?.[n - 1],
        sealedRound,
      });
      if (data.mode === "sealed") writeSealedLocal(id, n);
      if (account) {
        setProfiles((prev) => ({
          ...prev,
          [account.did]: { did: account.did, handle: account.handle, displayName: account.displayName, avatar: account.avatar },
        }));
      }
      clearPendingVote();
      setNeedLogin(false);
      setVoteCast(true);
      setCastFlash(true);
      setTimeout(() => setCastFlash(false), 550);
    } catch (e) {
      setCastError((e as Error).message || "Could not record your vote.");
    }
  }

  // Unvote: delete the voter's vote record for this poll.
  async function removeVote() {
    if (!data || !myVote) return;
    const prev = myVote;
    interactedRef.current = true;
    setMyVote(0);
    setVoteCast(false);
    setCastError("");
    try {
      const agent = await getAgent();
      if (!agent) { setMyVote(prev); return setNeedLogin(true); }
      await deleteVote(makeRpc(agent), agent.sub, data.pollUri!);
      if (data.mode === "sealed") writeSealedLocal(id, 0);
      clearPendingVote();
    } catch (e) {
      setMyVote(prev);
      setCastError((e as Error).message || "Could not remove your vote.");
    }
  }

  function confirmVote() {
    const n = confirmOption;
    if (dontAsk) {
      try { localStorage.setItem(SKIP_CONFIRM_KEY, "1"); } catch { /* ignore */ }
      setSkipConfirm(true);
    }
    setConfirmOption(0);
    if (n > 0) performVote(n);
  }

  async function doSignInToVote() {
    const h = handle.trim().replace(/^@/, "");
    if (!h) return;
    setSigninBusy(true);
    try {
      await signIn(h);
    } catch (e) {
      setCastError((e as Error).message);
      setSigninBusy(false);
    }
  }

  if (state === "loading") {
    return (
      <div class="card grid place-items-center p-16 text-[var(--color-ink-soft)]">
        <div class="flex items-center gap-3">
          <span class="h-2.5 w-2.5 animate-ping rounded-full" style="background: var(--color-brand)"></span>
          Loading results…
        </div>
      </div>
    );
  }

  if (state === "notfound" || state === "error") {
    return (
      <div class="card p-10 text-center">
        <h2 class="text-3xl">{state === "notfound" ? "Poll not found" : "Couldn't load results"}</h2>
        <p class="mt-2 text-[var(--color-ink-soft)]">
          {state === "notfound" ? "This poll doesn't exist or has expired." : "Please try again in a moment."}
        </p>
        <a class="btn btn-primary mt-6" href="/create">Create a poll</a>
      </div>
    );
  }

  const d = data!;
  // Public polls carry the creator's DID in posted_by; show the resolved handle
  // instead (private/legacy polls already store a handle server-side).
  const creator = d.isPublic ? creatorHandle : (d.posted_by ?? "");
  const view = withMyVote(d, myVote, account?.did);
  const votes = view.results.slice(1);
  const total = votes.reduce((a, b) => a + b, 0);
  const interactions = view.results.reduce((a, b) => a + b, 0);
  const leader = total > 0 ? Math.max(...votes) : -1;
  const created = d.created_at ? new Date(d.created_at) : null;
  const highlight = d.isPublic ? myVote : voted;
  const closed = !!(d.endsAt && now >= new Date(d.endsAt).getTime());
  const remaining = d.endsAt ? new Date(d.endsAt).getTime() - now : 0;
  const sealed = d.mode === "sealed";
  const sealedOpen = sealed && !closed;
  const ineligible = !!d.audience && myEligible === false;
  const canVote = d.isPublic && !closed && !ineligible;
  const showLoginBanner = publicPoll && needLogin && !voteCast;
  const pdslsUrl = d.pollUri ? `https://pdsls.dev/${d.pollUri}` : undefined;
  const votePath = sealed || d.optionUris?.some(Boolean) ? "blue.poll.poll.vote:poll.uri" : "blue.poll.poll.vote:subject.uri";
  const rawVotesUrl = d.pollUri
    ? `https://constellation.microcosm.blue/xrpc/blue.microcosm.links.getBacklinks?subject=${encodeURIComponent(d.pollUri)}&source=${encodeURIComponent(votePath)}`
    : undefined;
  const revealedVotes = d.isPublic && !sealedOpen
    ? (view.voters ?? []).flatMap((list, i) => list.map((did) => ({ did, option: i + 1 })))
    : [];

  return (
    <>
      <div class="rise">
      <div class="tilt" style="border-radius: 1.15rem">
      <FlipCard
        frontClass="ballot-card overflow-hidden p-7 sm:p-9"
        backClass="ballot-card p-6 sm:p-7"
        infoLabel={d.isPublic ? "Technical details & verification" : "About this poll"}
        front={() => (
        <>
        <div class="ballot-header">✦ poll.blue ballot ✦</div>
        <div class="flex items-start justify-between gap-4">
          <h1 class="text-3xl leading-tight sm:text-4xl">{d.question}</h1>
          <span class="flex shrink-0 items-center gap-2">
            {d.isPublic && <span class="rounded-full bg-amber-100 px-1.5 py-0.5 text-[0.58rem] font-extrabold uppercase tracking-wider text-amber-700" title="On-network polling is an alpha feature">Alpha</span>}
            <span class="pill">{sealed ? "🔒 Sealed poll" : d.isPublic ? "Public poll" : "Private poll"}</span>
          </span>
        </div>

        <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--color-ink-faint)]">
          {sealed
            ? <span>Votes are timelock-encrypted — results reveal when the poll closes, then anyone can decrypt & tally.</span>
            : d.isPublic
              ? <span>Every vote is a public record on the voter's own account — tap an avatar to see who.</span>
              : <span>Anonymous voting, tallied by poll.blue (legacy).</span>}
          {d.audience && (
            <span class="font-semibold text-[var(--color-brand-deep)]">
              🔒 {d.audience.gate === "followers" ? "Followers only" : "List only"}
            </span>
          )}
          {d.endsAt && (
            <span class="font-semibold" style={`color:${closed ? "var(--color-ink-faint)" : "var(--color-brand-deep)"}`}>
              {closed ? (sealed ? "🔓 Revealed" : "⏳ Voting closed") : `⏳ ${sealed ? "Reveals" : "Closes"} in ${fmtRemaining(remaining)}`}
            </span>
          )}
        </div>

        {ineligible && (
          <p class="mt-4 rounded-xl px-4 py-2.5 text-sm font-medium" style="background: rgba(244,63,94,0.1); color: #be123c">
            🚫 Voting is closed to you — this poll only accepts {d.audience!.gate === "followers" ? (creator ? `@${creator}'s followers` : "the creator's followers") : "members of its list"}.
          </p>
        )}

        {canVote && !voteCast && (
          <p class="mt-4 text-sm font-medium text-[var(--color-brand-deep)]">{sealed ? "Tap an option to seal your vote →" : "Tap an option to vote →"}</p>
        )}

        {showLoginBanner && (
          <div class="mt-6 rounded-2xl border p-4" style="border-color: var(--color-brand); background: var(--color-brand-tint)">
            <p class="font-semibold">Sign in to vote</p>
            <p class="mt-1 text-sm text-[var(--color-ink-soft)]">
              Public polls record your vote on your own account. Enter your handle to continue.
            </p>
            <div class="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                class="field flex-1"
                type="text"
                placeholder="oakley.bsky.social"
                value={handle}
                autocomplete="username"
                onInput={(e) => setHandle((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === "Enter") doSignInToVote(); }}
              />
              <button class="btn btn-primary" disabled={signinBusy || !handle.trim()} onClick={doSignInToVote}>
                {signinBusy ? "Redirecting…" : "Sign in & vote"}
              </button>
            </div>
          </div>
        )}

        {voteCast && (
          <p class="mt-6 rounded-xl px-4 py-2.5 text-sm font-medium" style="background: var(--color-brand-tint); color: var(--color-brand-deep)">
            {sealed
              ? "Your vote is sealed 🔒 — it stays encrypted until the poll closes, then reveals with everyone else's. Tap another option to change it, or tap the same one again to withdraw."
              : "Vote recorded to your account ✓ — tap another option to change it, or tap the same one again to remove it."}
          </p>
        )}
        {castError && <p class="mt-6 text-sm font-medium text-red-600">{castError}</p>}

        {sealedOpen ? (
          <div class="mt-7 space-y-3">
            <p class="text-sm text-[var(--color-ink-soft)]">
              🔒 {(d.cast ?? 0).toLocaleString()} {(d.cast ?? 0) === 1 ? "vote" : "votes"} sealed · tallies stay hidden until close.
            </p>
            {d.answers.map((ans, i) => {
              const isVoted = myVote === i + 1;
              return (
                <div
                  class={`punch-card flex items-center justify-between gap-3 px-4 py-3.5 transition-shadow ${canVote ? "cursor-pointer hover:shadow-[var(--shadow-lift)]" : ""} ${castFlash && highlight === i + 1 ? "stamping" : ""}`}
                  style={`border-color:${isVoted ? "var(--color-brand)" : "var(--color-line)"}`}
                  onClick={canVote ? () => requestVote(i + 1) : undefined}
                  role={canVote ? "button" : undefined}
                  tabIndex={canVote ? 0 : undefined}
                  onKeyDown={canVote ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); requestVote(i + 1); } } : undefined}
                >
                  <span class="flex items-center gap-2.5 text-lg font-medium">
                    <span class={`ballot-box ${isVoted ? "checked" : ""}`}>
                      {isVoted && <span class="stamp">✓</span>}
                      {castFlash && highlight === i + 1 && <span class="stamp-ripple"></span>}
                    </span>
                    <span class="col select-none">{String(i + 1).padStart(2, "0")}</span>
                    {ans}
                  </span>
                  <span class="select-none text-[var(--color-ink-faint)]">🔒</span>
                </div>
              );
            })}
          </div>
        ) : (
          <div class="mt-7 space-y-3.5">
          {votes.map((count, i) => {
            const pct = total > 0 ? (count / total) * 100 : 0;
            const isLeader = count === leader && total > 0;
            const isVoted = highlight === i + 1;
            const optionVoters = d.isPublic ? view.voters?.[i] ?? [] : [];
            const shownVoters = optionVoters.slice(0, 12);
            const extraVoters = count - shownVoters.length;
            return (
              <div
                class={`punch-card relative overflow-hidden transition-shadow ${canVote ? "cursor-pointer hover:shadow-[var(--shadow-lift)]" : ""} ${castFlash && highlight === i + 1 ? "stamping" : ""}`}
                style={`border-color:${isVoted ? "var(--color-brand)" : "var(--color-line)"}`}
                onClick={canVote ? () => requestVote(i + 1) : undefined}
                role={canVote ? "button" : undefined}
                tabIndex={canVote ? 0 : undefined}
                onKeyDown={canVote ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); requestVote(i + 1); } } : undefined}
              >
                <div
                  class="bar-fill absolute inset-y-0 left-0"
                  style={`width:${Math.max(pct, 1.5)}%; animation-delay:${120 + i * 120}ms; ${isLeader
                    ? "background:linear-gradient(90deg, rgba(17,133,254,0.34), rgba(17,133,254,0.16)); border-right:3px solid rgba(17,133,254,0.6)"
                    : "background:linear-gradient(90deg, rgba(125,163,210,0.30), rgba(125,163,210,0.12)); border-right:2px solid rgba(125,163,210,0.5)"}`}
                >
                </div>
                <div class="relative">
                  <div class="flex items-center justify-between gap-3 px-4 py-3.5">
                    <span class="flex items-center gap-2.5 text-lg font-medium">
                      <span class={`ballot-box ${isVoted ? "checked" : ""}`}>
                        {isVoted && <span class="stamp">✓</span>}
                        {castFlash && highlight === i + 1 && <span class="stamp-ripple"></span>}
                      </span>
                      <span class="col select-none">{String(i + 1).padStart(2, "0")}</span>
                      {d.answers[i]}
                    </span>
                    <span class="shrink-0 font-display text-2xl font-bold" style={`color:${isLeader ? "var(--color-brand-deep)" : "var(--color-ink-soft)"}`}>
                      {pct.toFixed(0)}% <span class="text-sm font-semibold text-[var(--color-ink-faint)]">({count})</span>
                    </span>
                  </div>
                  {shownVoters.length > 0 && (
                    <div class="flex flex-wrap items-center gap-1.5 px-4 pb-3">
                      <span class="mr-0.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">Voted</span>
                      {shownVoters.map((did) => {
                        const p = profiles[did];
                        return (
                          <a
                            href={`https://bsky.app/profile/${p?.handle ?? did}`}
                            target="_blank"
                            rel="noreferrer"
                            title={p ? `@${p.handle}` : did}
                            onClick={(e) => e.stopPropagation()}
                            class="block transition-transform hover:scale-110"
                          >
                            {p?.avatar
                              ? <img src={p.avatar} alt={p.handle} width={22} height={22} class="h-[22px] w-[22px] rounded-full object-cover ring-1 ring-white" />
                              : <span class="grid h-[22px] w-[22px] place-items-center rounded-full text-[10px] font-bold text-white ring-1 ring-white" style="background:linear-gradient(135deg,#1185fe,#073a86)">{p ? p.handle.charAt(0).toUpperCase() : "?"}</span>}
                          </a>
                        );
                      })}
                      {extraVoters > 0 && <span class="text-xs font-medium text-[var(--color-ink-faint)]">+{extraVoters}</span>}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          </div>
        )}

        <div class="mt-7 flex flex-wrap items-center justify-between gap-3 pt-5 text-sm text-[var(--color-ink-soft)]" style="border-top: 2px dashed rgba(120,160,210,0.5)">
          <span>
            {sealedOpen
              ? `${(d.cast ?? 0).toLocaleString()} ${(d.cast ?? 0) === 1 ? "vote" : "votes"} sealed`
              : (
                <>
                  {interactions.toLocaleString()} {d.isPublic ? (interactions === 1 ? "vote" : "votes") : (interactions === 1 ? "interaction" : "interactions")}
                  {d.cast != null && d.cast !== interactions && <span class="text-[var(--color-ink-faint)]"> of {d.cast.toLocaleString()} cast</span>}
                  {d.isPublic && !sealed && !closed && <span class="ml-2 text-[var(--color-ink-faint)]">· live ⟳</span>}
                </>
              )}
          </span>
          {d.post_uri && (
            <a class="font-semibold text-[var(--color-brand-deep)] hover:underline" href={postUriToBskyLink(d.post_uri)} target="_blank" rel="noreferrer">
              {creator ? `Posted by @${creator}` : "View on Bluesky"}{created ? ` · ${created.toLocaleDateString()}` : ""}
            </a>
          )}
        </div>

        </>
        )}
        back={() => (
        <>
          <div class="flex items-center gap-3.5">
            <span class={`verify-seal ${d.isPublic ? "" : "verify-seal--muted"}`} aria-hidden="true">{d.isPublic ? "✓" : "ⓘ"}</span>
            <div>
              <h2 class="text-2xl leading-none">{d.isPublic ? "Verify this poll" : "About this poll"}</h2>
              <p class="mt-1 text-[0.65rem] font-bold uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
                {d.isPublic ? (sealed ? "Timelock · self-verifiable" : "On-network · self-verifiable") : "Legacy · centrally tallied"}
              </p>
            </div>
          </div>
          <p class="mt-3 text-sm text-[var(--color-ink-soft)]">
            {d.isPublic
              ? <>Everything here is public on the AT&nbsp;Protocol network — you don't have to trust poll.blue; recount it yourself.</>
              : <>A legacy, centrally-tallied poll: votes are counted by poll.blue's backend (one per person, deduplicated by IP) rather than recorded on the network.</>}
          </p>

          <h3 class="tech-head mt-6 text-xs font-bold uppercase tracking-widest text-[var(--color-ink-faint)]">Poll {d.isPublic ? "record" : "details"}</h3>
          <dl class="receipt mt-2 space-y-1.5 p-3.5 text-sm">
            <div class="flex justify-between gap-3"><dt class="text-[var(--color-ink-faint)]">Mode</dt><dd class="font-medium">{d.isPublic ? (sealed ? "sealed · timelock" : d.audience ? "public · gated" : "public") : "centralized · poll.blue"}</dd></div>
            {d.created_at && <div class="flex justify-between gap-3"><dt class="text-[var(--color-ink-faint)]">Created</dt><dd>{new Date(d.created_at).toLocaleString()}</dd></div>}
            {d.endsAt && <div class="flex justify-between gap-3"><dt class="text-[var(--color-ink-faint)]">{sealed ? "Reveals" : "Closes"}</dt><dd>{new Date(d.endsAt).toLocaleString()}</dd></div>}
          </dl>
          {pdslsUrl && <p class="mt-2 break-all text-xs"><a class="text-[var(--color-brand-deep)] hover:underline" href={pdslsUrl} target="_blank" rel="noreferrer">{d.pollUri} ↗</a></p>}

          {d.isPublic && (
            <>
              <h3 class="tech-head mt-6 text-xs font-bold uppercase tracking-widest text-[var(--color-ink-faint)]">How it's tallied</h3>
              {sealed ? (
                <div class="mt-2 space-y-1.5 text-sm text-[var(--color-ink-soft)]">
                  <p>Each choice is timelock-encrypted (drand). Nobody — including poll.blue — can read votes before close.</p>
                  <p>Chain <code>{d.sealed?.chain ? d.sealed.chain.slice(0, 12) + "…" : "?"}</code>, round <code>{d.sealed?.round ?? "?"}</code>. Once that round publishes, anyone decrypts every ciphertext and counts.</p>
                </div>
              ) : (
                <p class="mt-2 text-sm text-[var(--color-ink-soft)]">Votes are records linking to the poll; tallied by counting those backlinks via Constellation (<code>{votePath}</code>).</p>
              )}
              {d.audience && <p class="mt-2 text-sm text-[var(--color-ink-soft)]">Gated: only {d.audience.gate === "followers" ? "the creator's followers" : "members of the list"} are counted (checked at tally).</p>}
              {rawVotesUrl && <p class="mt-2 text-xs"><a class="text-[var(--color-brand-deep)] hover:underline" href={rawVotesUrl} target="_blank" rel="noreferrer">Raw vote records (Constellation JSON) ↗</a></p>}

              <h3 class="tech-head mt-6 text-xs font-bold uppercase tracking-widest text-[var(--color-ink-faint)]">
                Votes{sealedOpen ? "" : ` · ${revealedVotes.length}${revealedVotes.length >= 24 ? "+" : ""}`}
              </h3>
              {sealedOpen ? (
                <p class="mt-2 text-sm text-[var(--color-ink-soft)]">🔒 {(d.cast ?? 0).toLocaleString()} sealed — individual choices are hidden until close.</p>
              ) : revealedVotes.length === 0 ? (
                <p class="mt-2 text-sm text-[var(--color-ink-faint)]">No votes yet.</p>
              ) : (
                <ul class="mt-2 divide-y" style="border-color: var(--color-line)">
                  {revealedVotes.map((v) => {
                    const p = profiles[v.did];
                    return (
                      <li class="flex items-center justify-between gap-3 py-2 text-sm">
                        <a class="min-w-0 flex-1 truncate font-medium text-[var(--color-brand-deep)] hover:underline" href={`https://bsky.app/profile/${p?.handle ?? v.did}`} target="_blank" rel="noreferrer">
                          @{p?.handle ?? `${v.did.slice(0, 18)}…`}
                        </a>
                        <span class="shrink-0 text-[var(--color-ink-soft)]">{d.answers[v.option - 1]}</span>
                        <a class="shrink-0 text-[var(--color-ink-faint)] hover:text-[var(--color-brand-deep)]" href={`https://pdsls.dev/${voteRecordUri(v.did, d.pollUri!)}`} target="_blank" rel="noreferrer" title="View the raw vote record">↗</a>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </>
        )}
      />
      </div>
      </div>

      {confirmOption > 0 && (
        <div class="fixed inset-0 z-50 grid place-items-center p-4" style="background: rgba(15,23,42,0.45)" onClick={() => setConfirmOption(0)}>
          <div class="card w-full max-w-md p-6 sm:p-7" onClick={(e) => e.stopPropagation()}>
            <h2 class="text-2xl">{sealed ? "Seal your vote?" : "Vote publicly?"}</h2>
            {sealed ? (
              <p class="mt-3 text-[var(--color-ink-soft)]">
                This writes an <span class="font-semibold">encrypted record</span> to your account
                {account ? <span class="font-semibold"> @{account.handle}</span> : null} for
                <span class="font-semibold text-[var(--color-ink)]"> "{d.answers[confirmOption - 1]}"</span>. Your choice stays secret — even from you — until the poll closes, then it's revealed and anyone can tally. You can change it before close.
              </p>
            ) : (
              <p class="mt-3 text-[var(--color-ink-soft)]">
                This writes a <span class="font-semibold">public record</span> to your account
                {account ? <span class="font-semibold"> @{account.handle}</span> : null}. Anyone on the network can see that you voted for
                <span class="font-semibold text-[var(--color-ink)]"> "{d.answers[confirmOption - 1]}"</span>. You can change or remove it anytime.
              </p>
            )}
            <label class="mt-5 flex cursor-pointer items-center gap-2.5 text-sm text-[var(--color-ink-soft)]">
              <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk((e.target as HTMLInputElement).checked)} />
              Don't show this again
            </label>
            <div class="mt-6 flex justify-end gap-3">
              <button class="btn btn-ghost" onClick={() => setConfirmOption(0)}>Cancel</button>
              <button class="btn btn-primary" onClick={confirmVote}>{sealed ? "Seal vote" : "Vote publicly"}</button>
            </div>
          </div>
        </div>
      )}

    </>
  );
}
