import { useEffect, useState } from "preact/hooks";
import { postUriToBskyLink } from "../lib/poll";

interface PollResults {
  posted_by: string;
  created_at: string;
  post_uri?: string;
  question: string;
  answers: string[];
  results: number[]; // [abstentions, ...votesPerOption]
}

const EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"];

function readParams() {
  const url = new URL(location.href);
  const id = url.searchParams.get("id") ?? (location.pathname.match(/^\/p\/([^/]+)/)?.[1] ?? "");
  const voted = Number(url.searchParams.get("v") ?? "0");
  return { id, voted };
}

export default function Results() {
  const [state, setState] = useState<"loading" | "ok" | "notfound" | "error">("loading");
  const [data, setData] = useState<PollResults | null>(null);
  const [voted, setVoted] = useState(0);

  useEffect(() => {
    const { id, voted } = readParams();
    setVoted(voted);
    if (!id) return setState("notfound");
    (async () => {
      try {
        const resp = await fetch(`/api/poll/${encodeURIComponent(id)}`);
        if (resp.status === 404) return setState("notfound");
        if (!resp.ok) return setState("error");
        setData(await resp.json());
        setState("ok");
      } catch {
        setState("error");
      }
    })();
  }, []);

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
  const votes = d.results.slice(1);
  const total = votes.reduce((a, b) => a + b, 0);
  const interactions = d.results.reduce((a, b) => a + b, 0);
  const leader = total > 0 ? Math.max(...votes) : -1;
  const created = new Date(d.created_at);

  return (
    <div class="rise card overflow-hidden p-7 sm:p-9">
      <div class="flex items-start justify-between gap-4">
        <h1 class="text-3xl leading-tight sm:text-4xl">{d.question}</h1>
        <span class="pill shrink-0">Results</span>
      </div>

      <div class="mt-7 space-y-3.5">
        {votes.map((count, i) => {
          const pct = total > 0 ? (count / total) * 100 : 0;
          const isLeader = count === leader && total > 0;
          const isVoted = voted === i + 1;
          return (
            <div class="relative overflow-hidden rounded-2xl border" style={`border-color:${isVoted ? "var(--color-brand)" : "var(--color-line)"}`}>
              <div
                class="bar-fill absolute inset-y-0 left-0"
                style={`width:${Math.max(pct, 1.5)}%; animation-delay:${120 + i * 120}ms; background:${isLeader ? "var(--color-brand-tint)" : "rgba(226,232,244,0.55)"}`}
              >
              </div>
              <div class="relative flex items-center justify-between gap-3 px-4 py-3.5">
                <span class="flex items-center gap-2.5 font-medium">
                  <span class="select-none">{EMOJI[i]}</span>
                  {d.answers[i]}
                  {isVoted && <span class="pill !px-2 !py-0.5 text-[0.65rem]">your vote ✓</span>}
                </span>
                <span class="shrink-0 font-display text-lg font-bold" style={`color:${isLeader ? "var(--color-brand-deep)" : "var(--color-ink-soft)"}`}>
                  {pct.toFixed(0)}% <span class="text-sm font-semibold text-[var(--color-ink-faint)]">({count})</span>
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div class="mt-7 flex flex-wrap items-center justify-between gap-3 border-t pt-5 text-sm text-[var(--color-ink-soft)]" style="border-color: var(--color-line)">
        <span title="Voting or tapping 'Show results' counts as an interaction">
          {interactions.toLocaleString()} {interactions === 1 ? "interaction" : "interactions"}
        </span>
        {d.post_uri && (
          <a class="font-semibold text-[var(--color-brand-deep)] hover:underline" href={postUriToBskyLink(d.post_uri)} target="_blank" rel="noreferrer">
            {d.posted_by ? `Posted by @${d.posted_by}` : "View on Bluesky"} · {created.toLocaleDateString()}
          </a>
        )}
      </div>
    </div>
  );
}
