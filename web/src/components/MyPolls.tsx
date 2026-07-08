import { useEffect, useState } from "preact/hooks";
import { useStore } from "@nanostores/preact";
import { $account, $authReady, getAgent, initSession, signIn } from "../lib/session";
import { makeRpc } from "../lib/oauth";
import {
  deletePollRecord,
  encodePublicId,
  getPollRecord,
  listRecords,
  parsePollAtUri,
  POLL_NSID,
  pollOptionTexts,
  VOTE_NSID,
} from "../lib/atpoll";

interface CreatedPoll {
  id: string; // link target + backend-delete id: legacy visibleId or did~rkey
  question: string;
  endsAt?: string;
  createdAt?: string;
  manageable?: boolean; // private (centralized) poll — deletable here
  did?: string; // repo holding the record (for delete)
  rkey?: string; // record key (for delete)
}
interface VotedPoll {
  id: string;
  question: string;
  choice: string;
  createdAt?: string;
}

export default function MyPolls() {
  const account = useStore($account);
  const ready = useStore($authReady);
  const [created, setCreated] = useState<CreatedPoll[] | null>(null);
  const [votedOn, setVotedOn] = useState<VotedPoll[] | null>(null);
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null); // rkey being confirmed
  const [deleting, setDeleting] = useState<string | null>(null); // rkey being deleted
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    initSession();
  }, []);

  useEffect(() => {
    if (!account) return;
    const did = account.did;
    (async () => {
      // Polls you created — straight from your repo.
      try {
        const recs = await listRecords(did, POLL_NSID);
        const polls = recs
          .map((r) => {
            const parsed = parsePollAtUri(r.uri);
            if (!parsed) return null;
            const v = r.value as { question?: string; endsAt?: string; createdAt?: string; mode?: string; visibleId?: string };
            // Private polls (mode centralized) are manageable here — legacy ones
            // are addressed by their DB visibleId, unified ones by did~rkey.
            const manageable = v.mode === "centralized";
            return {
              id: manageable && v.visibleId ? v.visibleId : encodePublicId(parsed.did, parsed.rkey),
              question: v.question ?? "(untitled)",
              endsAt: v.endsAt,
              createdAt: v.createdAt,
              manageable,
              did: parsed.did,
              rkey: parsed.rkey,
            };
          })
          .filter(Boolean) as CreatedPoll[];
        polls.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
        setCreated(polls);
      } catch {
        setCreated([]);
      }

      // Polls you voted on — each vote record points at a poll; resolve it.
      try {
        const recs = await listRecords(did, VOTE_NSID);
        recs.sort((a, b) => String((b.value as { createdAt?: string }).createdAt ?? "").localeCompare(String((a.value as { createdAt?: string }).createdAt ?? "")));
        const out = await Promise.all(
          recs.map(async (r) => {
            // Native votes use { poll, option: at-uri, index }; legacy used { subject, option: n }.
            const v = r.value as { poll?: { uri?: string }; subject?: { uri?: string }; option?: number | string; index?: number; createdAt?: string };
            const uri = v.poll?.uri ?? v.subject?.uri;
            const parsed = uri ? parsePollAtUri(uri) : null;
            if (!parsed) return null;
            const id = encodePublicId(parsed.did, parsed.rkey);
            const idx = typeof v.index === "number" ? v.index : typeof v.option === "number" ? v.option : undefined;
            try {
              const rec = await getPollRecord(parsed.did, parsed.rkey);
              if (!rec?.value) return null;
              const opts = pollOptionTexts(rec);
              const choice = idx && idx >= 1 ? opts[idx - 1] ?? `Option ${idx}` : "—";
              return { id, question: rec.value.question, choice, createdAt: v.createdAt };
            } catch {
              return null;
            }
          }),
        );
        setVotedOn(out.filter(Boolean) as VotedPoll[]);
      } catch {
        setVotedOn([]);
      }
    })();
  }, [account?.did]);

  // Delete a private poll: remove the repo record (only the owner can — this is
  // the backend's proof of ownership), then purge its votes from the DB (keyed by
  // visibleId for legacy polls, by did~rkey at-uri for unified ones).
  async function handleDelete(p: CreatedPoll) {
    if (!p.manageable || !p.did || !p.rkey) return;
    setDeleteError("");
    setConfirmDelete(null);
    setDeleting(p.rkey);
    try {
      const agent = await getAgent();
      if (!agent) throw new Error("Your session expired — sign in again.");
      await deletePollRecord(makeRpc(agent), agent.sub, p.rkey);
      const resp = await fetch(`/api/poll/${encodeURIComponent(p.id)}`, { method: "DELETE" });
      if (!resp.ok && resp.status !== 404) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(typeof j.error === "string" ? j.error : "Removed from your repo, but the backend couldn't purge it.");
      }
      setCreated((list) => (list ?? []).filter((x) => x.rkey !== p.rkey));
    } catch (e) {
      setDeleteError((e as Error).message || "Could not delete the poll.");
    } finally {
      setDeleting(null);
    }
  }

  async function doSignIn() {
    const h = handle.trim().replace(/^@/, "");
    if (!h) return;
    setBusy(true);
    setError("");
    try {
      await signIn(h);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (!ready) {
    return (
      <div class="card grid place-items-center p-16 text-[var(--color-ink-soft)]">
        <div class="flex items-center gap-3">
          <span class="h-2.5 w-2.5 animate-ping rounded-full" style="background: var(--color-brand)"></span>
          Loading…
        </div>
      </div>
    );
  }

  if (!account) {
    return (
      <div class="card rise p-8 sm:p-10">
        <span class="pill">Sign in</span>
        <h2 class="mt-4 text-3xl">See your polls</h2>
        <p class="mt-2 max-w-md text-[var(--color-ink-soft)]">Sign in with your Bluesky handle to see the polls you've made and voted on.</p>
        <div class="mt-6 flex flex-col gap-3 sm:flex-row">
          <input
            class="field flex-1"
            type="text"
            placeholder="oakley.bsky.social"
            value={handle}
            autocomplete="username"
            onInput={(e) => setHandle((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === "Enter") doSignIn(); }}
          />
          <button class="btn btn-primary" disabled={busy || !handle.trim()} onClick={doSignIn}>
            {busy ? "Redirecting…" : "Continue"}
          </button>
        </div>
        {error && <p class="mt-4 text-sm font-medium text-red-600">{error}</p>}
      </div>
    );
  }

  const now = Date.now();

  return (
    <div class="rise space-y-10">
      <section>
        <h2 class="text-2xl">Polls you made</h2>
        {deleteError && <p class="mt-3 text-sm font-medium text-red-600">{deleteError}</p>}
        {created === null ? (
          <p class="mt-3 text-[var(--color-ink-faint)]">Loading…</p>
        ) : created.length === 0 ? (
          <p class="mt-3 text-[var(--color-ink-soft)]">No polls yet. <a class="font-semibold text-[var(--color-brand-deep)] hover:underline" href="/create">Make one →</a></p>
        ) : (
          <div class="mt-4 space-y-2.5">
            {created.map((p) => {
              const closed = p.endsAt && now >= new Date(p.endsAt).getTime();
              const isConfirming = confirmDelete === p.rkey;
              const isDeleting = deleting === p.rkey;
              return (
                <div class="card flex items-center justify-between gap-3 p-4 transition-shadow hover:shadow-[var(--shadow-lift)]">
                  <a href={`/p/${p.id}`} class="min-w-0 flex-1 font-medium hover:underline">{p.question}</a>
                  <div class="flex shrink-0 items-center gap-3">
                    <span class="text-xs font-semibold text-[var(--color-ink-faint)]"
                      data-tip={p.manageable ? "Anonymous poll — counted best-effort by poll.blue" : undefined}>
                      {p.manageable ? "anonymous" : p.endsAt ? (closed ? "closed" : "open") : "no end date"}
                    </span>
                    {p.manageable && (isConfirming ? (
                      <span class="flex items-center gap-2">
                        <button type="button" class="text-xs font-semibold text-red-600 hover:underline disabled:opacity-50" disabled={isDeleting} onClick={() => handleDelete(p)}>
                          {isDeleting ? "Deleting…" : "Delete?"}
                        </button>
                        <button type="button" class="text-xs font-semibold text-[var(--color-ink-faint)] hover:underline" disabled={isDeleting} onClick={() => setConfirmDelete(null)}>Cancel</button>
                      </span>
                    ) : (
                      <button type="button" class="text-xs font-semibold text-[var(--color-ink-faint)] transition-colors hover:text-red-600"
                        aria-label="Delete poll"
                        onClick={() => { setDeleteError(""); setConfirmDelete(p.rkey!); }}>
                        Delete
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <h2 class="text-2xl">Polls you voted on</h2>
        {votedOn === null ? (
          <p class="mt-3 text-[var(--color-ink-faint)]">Loading…</p>
        ) : votedOn.length === 0 ? (
          <p class="mt-3 text-[var(--color-ink-soft)]">You haven't voted on any public polls yet.</p>
        ) : (
          <div class="mt-4 space-y-2.5">
            {votedOn.map((p) => (
              <a href={`/p/${p.id}`} class="card flex items-center justify-between gap-4 p-4 transition-shadow hover:shadow-[var(--shadow-lift)]">
                <span class="font-medium">{p.question}</span>
                <span class="shrink-0 text-sm text-[var(--color-ink-soft)]">you voted <span class="font-semibold text-[var(--color-brand-deep)]">{p.choice}</span></span>
              </a>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
