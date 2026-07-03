// AT-Protocol-native ("public") polls. The poll lives as a record in the
// creator's repo; each vote is a record in the voter's repo that links to the
// poll. Tallying is done client-side via Constellation backlinks (see
// constellation.ts). No poll.blue backend is involved for public polls.
//
// Private polls keep using the existing centralized backend + anonymous link
// voting; none of this touches them.

import { backlinkCount, backlinks, backlinksAll } from "./constellation";

const APPVIEW = "https://public.api.bsky.app";

export interface Audience {
  gate: "followers" | "list";
  list?: string; // at-uri of an app.bsky.graph.list, when gate = "list"
}

export const POLL_NSID = "blue.poll.poll.poll";
export const OPTION_NSID = "blue.poll.poll.option";
export const VOTE_NSID = "blue.poll.poll.vote";

// The countable per-option target is env-independent (always the prod domain) so
// tallies are stable no matter where a vote was cast. The clickable links in the
// Bluesky post use the live origin (so dev works); the two are decoupled.
const CANON_ORIGIN = "https://poll.blue";

// ---- public-poll id <-> (did, rkey) --------------------------------------
// A public poll is addressed in the URL as `<did>~<rkey>` — a single path
// segment (DIDs and rkeys contain no "/"), so it slots into the existing
// /p/:id routes with zero routing changes.

export function encodePublicId(did: string, rkey: string): string {
  return `${did}~${rkey}`;
}

export function decodePublicId(id: string): { did: string; rkey: string } | null {
  const i = id.indexOf("~");
  if (i < 0) return null;
  const did = id.slice(0, i);
  const rkey = id.slice(i + 1);
  if (!did.startsWith("did:") || !rkey) return null;
  return { did, rkey };
}

export function isPublicId(id: string): boolean {
  return id.startsWith("did:") && id.includes("~");
}

export function pollAtUri(did: string, rkey: string): string {
  return `at://${did}/${POLL_NSID}/${rkey}`;
}

export function optionTarget(id: string, option: number): string {
  return `${CANON_ORIGIN}/p/${id}/${option}`;
}

// Deterministic vote rkey per poll → a voter has at most one vote record per
// poll (re-voting overwrites via putRecord), so per-option backlink counts are
// already deduped by identity. FNV-1a over the poll uri, base36.
function voteRkey(pollUri: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < pollUri.length; i++) {
    h ^= pollUri.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return "v" + (h >>> 0).toString(36);
}

/** The at-uri of a given voter's vote record for a poll (deterministic rkey). */
export function voteRecordUri(voterDid: string, pollUri: string): string {
  return `at://${voterDid}/${VOTE_NSID}/${voteRkey(pollUri)}`;
}

// deno-lint-ignore no-explicit-any
type Rpc = any;

export interface PublicPoll {
  id: string;
  postUri: string;
}

/** Create a public poll: write the poll record, the Bluesky post (via
 *  `makePost`, which composes the option links from the id), then best-effort
 *  link the record back to the post. Returns the shareable id + post uri. */
export async function createPublicPoll(
  rpc: Rpc,
  did: string,
  poll: { question: string; answers: string[]; endsAt?: string; audience?: Audience; mode?: "public" | "sealed"; sealed?: { round: number; chain: string } },
  makePost: (id: string) => Promise<{ uri: string; cid: string }>,
): Promise<PublicPoll> {
  const mode = poll.mode ?? "public";
  const sealed = mode === "sealed";
  const pollRkey = randomRkey();
  const id = encodePublicId(did, pollRkey);
  const pollUri = pollAtUri(did, pollRkey);
  const createdAt = new Date().toISOString();

  // Public polls give each option its own record (an at-uri backlink target for
  // per-option counting). Sealed polls hide the choice, so they don't need them.
  const optionRkeys = sealed ? [] : poll.answers.map(() => randomRkey());
  const optionUris = optionRkeys.map((rk) => `at://${did}/${OPTION_NSID}/${rk}`);

  const record: Record<string, unknown> = {
    $type: POLL_NSID,
    question: poll.question,
    options: sealed
      ? poll.answers.map((text) => ({ text }))
      : poll.answers.map((text, i) => ({ text, uri: optionUris[i] })),
    mode,
    createdAt,
    ...(poll.endsAt ? { endsAt: poll.endsAt } : {}),
    ...(poll.sealed ? { sealed: poll.sealed } : {}),
    ...(poll.audience ? { audience: poll.audience } : {}),
  };

  // Poll (+ option records for public) in one atomic transaction.
  const writes = [
    { $type: "com.atproto.repo.applyWrites#create", collection: POLL_NSID, rkey: pollRkey, value: record },
    ...optionRkeys.map((rk, i) => ({
      $type: "com.atproto.repo.applyWrites#create",
      collection: OPTION_NSID,
      rkey: rk,
      value: { $type: OPTION_NSID, text: poll.answers[i], index: i + 1, poll: pollUri, createdAt },
    })),
  ];
  const created = await rpc.post("com.atproto.repo.applyWrites", { input: { repo: did, writes } });
  if (!created.ok) throw new Error(created.data?.error ?? "Could not create the poll.");

  const post = await makePost(id); // creates the app.bsky.feed.post with option links

  // Best-effort: link the poll record to its post so the results page can offer
  // an "open on Bluesky" link. Failure here doesn't break the poll.
  rpc
    .post("com.atproto.repo.putRecord", {
      input: {
        repo: did,
        collection: POLL_NSID,
        rkey: pollRkey,
        record: { ...record, post: { uri: post.uri, cid: post.cid } },
      },
    })
    .catch(() => {});

  return { id, postUri: post.uri };
}

/** Record a vote for a public poll in the voter's repo. Overwrites any prior
 *  vote on this poll (deterministic rkey), so one vote per account. Native polls
 *  reference the chosen option's at-uri; old polls fall back to the legacy URL. */
export async function castVote(
  rpc: Rpc,
  voterDid: string,
  args: { pollUri: string; pollCid: string; id: string; option: number; optionUri?: string; sealedRound?: number },
): Promise<void> {
  const createdAt = new Date().toISOString();
  let record: Record<string, unknown>;
  if (args.sealedRound != null) {
    // Sealed: encrypt the choice to the poll's drand round. No option link — the
    // record only reveals that this account voted, not for what, until close.
    const { sealChoice } = await import("./timelock");
    const ciphertext = await sealChoice(args.sealedRound, String(args.option));
    record = {
      $type: VOTE_NSID,
      poll: { uri: args.pollUri, cid: args.pollCid },
      sealed: { ciphertext, round: args.sealedRound },
      createdAt,
    };
  } else if (args.optionUri) {
    record = {
      $type: VOTE_NSID,
      poll: { uri: args.pollUri, cid: args.pollCid },
      option: args.optionUri, // at-uri of the chosen option record
      index: args.option, // convenience: 1-based option number
      createdAt,
    };
  } else {
    // Legacy poll (no option records): keep the old URL-target shape.
    record = {
      $type: VOTE_NSID,
      subject: { uri: args.pollUri, cid: args.pollCid },
      option: args.option,
      optionLink: optionTarget(args.id, args.option),
      createdAt,
    };
  }
  const res = await rpc.post("com.atproto.repo.putRecord", {
    input: { repo: voterDid, collection: VOTE_NSID, rkey: voteRkey(args.pollUri), record },
  });
  if (!res.ok) throw new Error(res.data?.error ?? "Could not record your vote.");
}

export interface OptionTally {
  count: number; // eligible votes (== cast when ungated)
  voters: string[]; // sample of (eligible) voter DIDs for this option
  cast?: number; // total votes cast for this option, before gating
}

/** Tally a public poll straight from the network: for each option, ask
 *  Constellation for the vote records linking to it. Native polls link the
 *  option's at-uri; legacy polls (no option uri) link the old poll.blue URL.
 *  `optionUris[i]` is the at-uri for option i+1, or undefined for legacy. */
export async function tallyPublicPoll(id: string, optionUris: Array<string | undefined>): Promise<OptionTally[]> {
  return Promise.all(
    optionUris.map((uri, i) => {
      const target = uri ?? optionTarget(id, i + 1);
      const source = uri ? `${VOTE_NSID}:option` : `${VOTE_NSID}:optionLink`;
      return backlinks(target, source, 24)
        .then((b) => ({ count: b.total, voters: b.records.map((r) => r.did) }))
        .catch(() => ({ count: 0, voters: [] as string[] }));
    }),
  );
}

// ---- audience gating (followers / list) ----------------------------------

/** Which of `voterDids` are eligible under `audience` (relative to the poll
 *  creator). Returns null when everyone is eligible (no gate). */
export async function resolveEligible(
  audience: Audience | undefined,
  creatorDid: string,
  voterDids: string[],
): Promise<Set<string> | null> {
  if (!audience) return null;
  const uniq = [...new Set(voterDids)].filter(Boolean);
  if (uniq.length === 0) return new Set();

  if (audience.gate === "followers") {
    // getRelationships(actor=creator, others=[voters]) → followedBy = voter follows creator.
    const eligible = new Set<string>();
    for (let i = 0; i < uniq.length; i += 30) {
      const qs = uniq.slice(i, i + 30).map((d) => `others=${encodeURIComponent(d)}`).join("&");
      try {
        const r = await fetch(`${APPVIEW}/xrpc/app.bsky.graph.getRelationships?actor=${encodeURIComponent(creatorDid)}&${qs}`);
        if (!r.ok) continue;
        const j = (await r.json()) as { relationships?: Array<{ did: string; followedBy?: string }> };
        for (const rel of j.relationships ?? []) if (rel.followedBy) eligible.add(rel.did);
      } catch { /* skip batch */ }
    }
    return eligible;
  }

  if (audience.gate === "list" && audience.list) {
    // Fetch the list's members; eligible voters = those in the list.
    const members = new Set<string>();
    let cursor: string | undefined;
    do {
      const url = `${APPVIEW}/xrpc/app.bsky.graph.getList?list=${encodeURIComponent(audience.list)}&limit=100` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      try {
        const r = await fetch(url);
        if (!r.ok) break;
        const j = (await r.json()) as { items?: Array<{ subject?: { did?: string } }>; cursor?: string };
        for (const it of j.items ?? []) if (it.subject?.did) members.add(it.subject.did);
        cursor = j.cursor || undefined;
      } catch { break; }
    } while (cursor);
    return new Set(uniq.filter((d) => members.has(d)));
  }
  return null;
}

/** Gated tally: enumerate every voter per option, then keep only eligible ones.
 *  Returns eligible counts + a sample of eligible voters + total cast. */
export async function tallyGatedPoll(
  id: string,
  optionUris: Array<string | undefined>,
  audience: Audience,
  creatorDid: string,
): Promise<OptionTally[]> {
  const perOption = await Promise.all(
    optionUris.map((uri, i) => {
      const target = uri ?? optionTarget(id, i + 1);
      const source = uri ? `${VOTE_NSID}:option` : `${VOTE_NSID}:optionLink`;
      return backlinksAll(target, source).then((recs) => recs.map((r) => r.did)).catch(() => [] as string[]);
    }),
  );
  const eligible = await resolveEligible(audience, creatorDid, perOption.flat());
  return perOption.map((voters) => {
    const elig = eligible ? voters.filter((v) => eligible.has(v)) : voters;
    return { count: elig.length, voters: elig.slice(0, 24), cast: voters.length };
  });
}

/** Is a single account eligible under the gate? (for the "your vote won't count" hint) */
export async function isEligible(audience: Audience, creatorDid: string, did: string): Promise<boolean> {
  const set = await resolveEligible(audience, creatorDid, [did]);
  return set ? set.has(did) : true;
}

// ---- sealed (timelock) tally ---------------------------------------------

/** Fetch any record's value straight from the author's PDS. */
export async function getRecordValue(did: string, collection: string, rkey: string): Promise<Record<string, any> | null> {
  const pds = await resolvePds(did);
  const r = await fetch(
    `${pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=${collection}&rkey=${encodeURIComponent(rkey)}`,
  );
  if (!r.ok) return null;
  return ((await r.json()) as { value?: Record<string, any> }).value ?? null;
}

/** Number of sealed votes cast (participation) — the choices stay hidden. */
export async function sealedVoteCount(pollUri: string): Promise<number> {
  return backlinkCount(pollUri, `${VOTE_NSID}:poll.uri`).catch(() => 0);
}

/** Tally a sealed poll AFTER close: enumerate the votes, fetch each ciphertext,
 *  timelock-decrypt it, and count per option. Throws per-vote errors are skipped
 *  (e.g. if the round isn't revealed yet — i.e. the poll hasn't actually closed). */
export async function tallySealedPoll(
  pollUri: string,
  optionCount: number,
  audience?: Audience,
  creatorDid?: string,
): Promise<OptionTally[]> {
  const recs = await backlinksAll(pollUri, `${VOTE_NSID}:poll.uri`);
  const { unsealChoice } = await import("./timelock");
  const perOption: string[][] = Array.from({ length: optionCount }, () => []);
  await Promise.all(
    recs.map(async (r) => {
      try {
        const val = await getRecordValue(r.did, VOTE_NSID, r.rkey);
        const ct = val?.sealed?.ciphertext as string | undefined;
        if (!ct) return;
        const choice = parseInt(await unsealChoice(ct), 10);
        if (choice >= 1 && choice <= optionCount) perOption[choice - 1].push(r.did);
      } catch { /* undecryptable/malformed → skip */ }
    }),
  );
  // Sealed composes with gating: filter the revealed voters by eligibility.
  const eligible = audience && creatorDid ? await resolveEligible(audience, creatorDid, perOption.flat()) : null;
  return perOption.map((voters) => {
    const elig = eligible ? voters.filter((v) => eligible.has(v)) : voters;
    return { count: elig.length, voters: elig.slice(0, 24), cast: eligible ? voters.length : undefined };
  });
}

/** Parse a list reference (at-uri or bsky.app list URL) into an at-uri. */
export async function parseListUri(input: string): Promise<string | null> {
  const s = input.trim();
  if (s.startsWith("at://")) return s.includes("app.bsky.graph.list") ? s : null;
  const m = s.match(/bsky\.app\/profile\/([^/]+)\/lists\/([^/?#]+)/);
  if (!m) return null;
  let did = m[1];
  if (!did.startsWith("did:")) {
    try {
      const r = await fetch(`${APPVIEW}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(did)}`);
      if (!r.ok) return null;
      did = ((await r.json()) as { did: string }).did;
    } catch { return null; }
  }
  return `at://${did}/app.bsky.graph.list/${m[2]}`;
}

export interface Profile {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

/** Batch-resolve DIDs to profiles (handle + avatar) for display. Cosmetic. */
export async function resolveProfiles(dids: string[]): Promise<Record<string, Profile>> {
  const uniq = [...new Set(dids)].filter(Boolean);
  const out: Record<string, Profile> = {};
  for (let i = 0; i < uniq.length; i += 25) {
    const qs = uniq.slice(i, i + 25).map((d) => `actors=${encodeURIComponent(d)}`).join("&");
    try {
      const r = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles?${qs}`);
      if (!r.ok) continue;
      const j = (await r.json()) as { profiles?: Profile[] };
      for (const p of j.profiles ?? []) {
        out[p.did] = { did: p.did, handle: p.handle, displayName: p.displayName, avatar: p.avatar };
      }
    } catch { /* cosmetic */ }
  }
  return out;
}

// ---- reading a poll record (no auth) -------------------------------------

interface DidDoc {
  service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }>;
}

async function resolvePds(did: string): Promise<string> {
  let doc: DidDoc;
  if (did.startsWith("did:plc:")) {
    const r = await fetch(`https://plc.directory/${encodeURIComponent(did)}`);
    if (!r.ok) throw new Error("could not resolve did:plc");
    doc = (await r.json()) as DidDoc;
  } else if (did.startsWith("did:web:")) {
    const host = decodeURIComponent(did.slice("did:web:".length));
    const r = await fetch(`https://${host}/.well-known/did.json`);
    if (!r.ok) throw new Error("could not resolve did:web");
    doc = (await r.json()) as DidDoc;
  } else {
    throw new Error("unsupported did method");
  }
  const svc = (doc.service ?? []).find(
    (s) => s.id?.endsWith("#atproto_pds") || s.type === "AtprotoPersonalDataServer",
  );
  if (!svc?.serviceEndpoint) throw new Error("no PDS endpoint in did doc");
  return svc.serviceEndpoint.replace(/\/+$/, "");
}

export interface PollRecord {
  uri: string;
  cid: string;
  value: {
    question: string;
    options: Array<{ text?: string; uri?: string } | string>;
    createdAt?: string;
    endsAt?: string;
    audience?: Audience;
    mode?: string;
    sealed?: { round?: number; chain?: string };
    post?: { uri?: string };
  };
}

/** at://<did>/blue.poll.poll.poll/<rkey> → { did, rkey }. */
export function parsePollAtUri(uri: string): { did: string; rkey: string } | null {
  const m = uri.match(/^at:\/\/([^/]+)\/[^/]+\/([^/]+)$/);
  return m ? { did: m[1], rkey: m[2] } : null;
}

/** List a repo's records in a collection (public read via the author's PDS). */
export async function listRecords(
  did: string,
  collection: string,
  limit = 100,
): Promise<Array<{ uri: string; value: Record<string, unknown> }>> {
  const pds = await resolvePds(did);
  const r = await fetch(
    `${pds}/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(did)}&collection=${collection}&limit=${limit}`,
  );
  if (!r.ok) return [];
  const j = (await r.json()) as { records?: Array<{ uri: string; value: Record<string, unknown> }> };
  return j.records ?? [];
}

/** Fetch a poll record straight from the author's PDS. Returns null if absent. */
export async function getPollRecord(did: string, rkey: string): Promise<PollRecord | null> {
  const pds = await resolvePds(did);
  const url =
    `${pds}/xrpc/com.atproto.repo.getRecord` +
    `?repo=${encodeURIComponent(did)}&collection=${POLL_NSID}&rkey=${encodeURIComponent(rkey)}`;
  const r = await fetch(url);
  if (r.status === 400 || r.status === 404) return null;
  if (!r.ok) throw new Error(`getRecord ${r.status}`);
  return (await r.json()) as PollRecord;
}

export function pollOptionTexts(rec: PollRecord): string[] {
  return (rec.value.options ?? []).map((o) => (typeof o === "string" ? o : o?.text ?? ""));
}

/** Per-option at-uris (undefined for legacy polls that predate option records). */
export function pollOptionUris(rec: PollRecord): Array<string | undefined> {
  return (rec.value.options ?? []).map((o) => (typeof o === "object" && o ? o.uri : undefined));
}

// ---- pending vote (survive the OAuth sign-in redirect) -------------------
// Voting on a public poll requires a session. If the voter isn't signed in we
// stash their intent, send them through OAuth (which lands on /create), and
// /create bounces them back to /p/<id>/<option> to complete the vote.

const PENDING_KEY = "pb_pending_vote";
const PENDING_TTL = 10 * 60 * 1000;

export function setPendingVote(id: string, option: number): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ id, option, ts: Date.now() }));
  } catch { /* ignore */ }
}

export function getPendingVote(): { id: string; option: number } | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { id: string; option: number; ts: number };
    if (Date.now() - p.ts > PENDING_TTL) return null;
    return { id: p.id, option: p.option };
  } catch {
    return null;
  }
}

export function clearPendingVote(): void {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch { /* ignore */ }
}

// A short, valid record key. rkey charset allows [A-Za-z0-9._~-]; keep it alnum.
const RKEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
function randomRkey(len = 13): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += RKEY_ALPHABET[bytes[i] % RKEY_ALPHABET.length];
  return out;
}
