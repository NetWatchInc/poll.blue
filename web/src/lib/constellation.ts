// Constellation is microcosm's global atproto backlink index. Because a vote is
// just a record that links to a poll, we can tally polls purely client-side by
// asking Constellation "how many records link to this target?" — no backend,
// no firehose consumer, no database. https://constellation.microcosm.blue
//
// Note: Constellation only indexes records seen since it came online, which is
// fine — every poll.blue public poll is created after that point.

const CONSTELLATION = "https://constellation.microcosm.blue";

/** Count records that link to `subject` at the collection+path `source`
 *  (e.g. source = "blue.poll.poll.vote:optionLink"). */
export async function backlinkCount(subject: string, source: string): Promise<number> {
  const url =
    `${CONSTELLATION}/xrpc/blue.microcosm.links.getBacklinksCount` +
    `?subject=${encodeURIComponent(subject)}&source=${encodeURIComponent(source)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`constellation ${r.status}`);
  const j = (await r.json()) as { total?: number };
  return j.total ?? 0;
}

export interface BacklinkRecord {
  did: string;
  collection: string;
  rkey: string;
}

/** The actual records linking to `subject` at `source`, plus the total count.
 *  Used to show *who* voted (each record lives in that DID's repo). */
export async function backlinks(
  subject: string,
  source: string,
  limit = 30,
): Promise<{ total: number; records: BacklinkRecord[] }> {
  const url =
    `${CONSTELLATION}/xrpc/blue.microcosm.links.getBacklinks` +
    `?subject=${encodeURIComponent(subject)}&source=${encodeURIComponent(source)}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`constellation ${r.status}`);
  const j = (await r.json()) as { total?: number; records?: BacklinkRecord[] };
  return { total: j.total ?? 0, records: j.records ?? [] };
}

/** All records linking to `subject` at `source`, paging through cursors.
 *  Capped at `max` to avoid runaway. Used for gated tallies (must enumerate
 *  every voter to filter them). */
export async function backlinksAll(subject: string, source: string, max = 2000): Promise<BacklinkRecord[]> {
  const out: BacklinkRecord[] = [];
  let cursor: string | undefined;
  do {
    const url =
      `${CONSTELLATION}/xrpc/blue.microcosm.links.getBacklinks` +
      `?subject=${encodeURIComponent(subject)}&source=${encodeURIComponent(source)}&limit=100` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const r = await fetch(url);
    if (!r.ok) break;
    const j = (await r.json()) as { records?: BacklinkRecord[]; cursor?: string };
    out.push(...(j.records ?? []));
    cursor = j.cursor || undefined;
  } while (cursor && out.length < max);
  return out;
}
