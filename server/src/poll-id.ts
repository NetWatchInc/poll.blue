// Shared poll-id helpers (server mirror of web/src/lib/atpoll.ts). A "public id"
// addresses a poll by its record: `<did>~<rkey>`, which always denotes the
// blue.poll.poll.poll collection (see the rkey-collision note in schema.sql).

export const POLL_NSID = "blue.poll.poll.poll";

export function isPublicId(id: string): boolean {
  return id.startsWith("did:") && id.includes("~");
}

export function decodePublicId(id: string): { did: string; rkey: string } | null {
  const i = id.indexOf("~");
  if (i < 0) return null;
  const did = id.slice(0, i);
  const rkey = id.slice(i + 1);
  if (!did.startsWith("did:") || !rkey) return null;
  return { did, rkey };
}

/** The blue.poll.poll.poll at-uri a public id points at. */
export function pollUriFromId(id: string): string | null {
  const dec = decodePublicId(id);
  return dec ? `at://${dec.did}/${POLL_NSID}/${dec.rkey}` : null;
}
