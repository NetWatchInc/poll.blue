import { fetchDidDoc, pdsFromDidDoc } from "./identity.ts";
import { POLL_NSID } from "./poll-id.ts";

// Unified private polls carry no registration: the poll lives only as a
// blue.poll.poll.poll record in the creator's repo, and we count votes against
// its at-uri. To keep anyone from spamming vote rows against arbitrary at-uris,
// the vote path lazily resolves the record (and caches its shape) before
// counting — that's the whole "verify" here.

interface PollShape {
  optionCount: number;
  centralized: boolean; // mode === "centralized" → tallied here (not on-network)
  expires: number;
}

const cache = new Map<string, PollShape>();
const TTL_MS = 10 * 60_000;
const NEG_TTL_MS = 60_000; // brief cache for "doesn't resolve", to blunt spam

function parseAtUri(uri: string): { did: string; collection: string; rkey: string } | null {
  if (!uri.startsWith("at://")) return null;
  const [did, collection, rkey] = uri.slice("at://".length).split("/");
  if (!did?.startsWith("did:") || !collection || !rkey) return null;
  return { did, collection, rkey };
}

/** Resolve (and cache) a poll record's shape. Returns null when the uri doesn't
 *  resolve to a valid blue.poll.poll.poll record. */
export async function resolvePollShape(pollUri: string): Promise<PollShape | null> {
  const now = Date.now();
  const hit = cache.get(pollUri);
  if (hit && hit.expires > now) return hit.optionCount > 0 ? hit : null;

  const at = parseAtUri(pollUri);
  if (!at || at.collection !== POLL_NSID) return null;

  const miss = (): null => {
    cache.set(pollUri, { optionCount: 0, centralized: false, expires: now + NEG_TTL_MS });
    return null;
  };

  let pds: string;
  try {
    pds = pdsFromDidDoc(await fetchDidDoc(at.did));
  } catch {
    return miss();
  }
  try {
    const url =
      `${pds}/xrpc/com.atproto.repo.getRecord` +
      `?repo=${encodeURIComponent(at.did)}&collection=${POLL_NSID}&rkey=${encodeURIComponent(at.rkey)}`;
    const r = await fetch(url);
    if (!r.ok) return miss();
    const j = (await r.json()) as { value?: { options?: unknown[]; mode?: string } };
    const opts = j.value?.options;
    if (!Array.isArray(opts) || opts.length < 2) return miss();
    const shape: PollShape = {
      optionCount: opts.length,
      centralized: j.value?.mode === "centralized",
      expires: now + TTL_MS,
    };
    cache.set(pollUri, shape);
    return shape;
  } catch {
    return miss();
  }
}
