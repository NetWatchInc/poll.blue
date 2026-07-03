// Bluesky richtext facet detection for the composer body. We keep the editor's
// plain text and derive facets (links / @mentions / #tags) from it at post time,
// with correct UTF-8 byte offsets — matching how the AT Protocol stores facets.

import { byteLength } from "./poll";

export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<Record<string, unknown>>;
}

const URL_RE = /https?:\/\/[^\s]+[^\s.,;:!?)\]}'"]/g;
// leading (^|\s) so we don't match mid-word; capture the token in group 2.
const TAG_RE = /(^|\s)(#[^\s#]{1,64})/g;
const MENTION_RE = /(^|\s)(@([a-zA-Z0-9][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9-]+)+))/g;

function facet(text: string, start: number, end: number, feature: Record<string, unknown>): Facet {
  return {
    index: { byteStart: byteLength(text.slice(0, start)), byteEnd: byteLength(text.slice(0, end)) },
    features: [feature],
  };
}

/** Resolve a handle to a DID via the public AppView (for @mention facets). */
export async function resolveHandle(handle: string): Promise<string | null> {
  try {
    const r = await fetch(
      `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
    );
    if (!r.ok) return null;
    return ((await r.json()) as { did?: string }).did ?? null;
  } catch {
    return null;
  }
}

/** Detect links, hashtags, and mentions in `text`, returning byte-offset facets.
 *  Mentions are resolved to DIDs (unresolvable ones are dropped). */
export async function detectFacets(text: string): Promise<Facet[]> {
  const facets: Facet[] = [];

  for (const m of text.matchAll(URL_RE)) {
    const val = m[0];
    const start = m.index ?? 0;
    facets.push(facet(text, start, start + val.length, { $type: "app.bsky.richtext.facet#link", uri: val }));
  }

  for (const m of text.matchAll(TAG_RE)) {
    const tag = m[2];
    const start = (m.index ?? 0) + m[1].length;
    facets.push(facet(text, start, start + tag.length, { $type: "app.bsky.richtext.facet#tag", tag: tag.slice(1) }));
  }

  for (const m of text.matchAll(MENTION_RE)) {
    const token = m[2]; // includes the leading @
    const handle = m[3];
    const start = (m.index ?? 0) + m[1].length;
    const did = await resolveHandle(handle);
    if (!did) continue;
    facets.push(facet(text, start, start + token.length, { $type: "app.bsky.richtext.facet#mention", did }));
  }

  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}
