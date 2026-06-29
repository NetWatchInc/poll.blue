// Resolve an atproto DID to its DID document / PDS endpoint (used to verify a
// poll's post by reading it straight from the author's PDS).

export interface DidDoc {
  alsoKnownAs?: string[];
  service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }>;
}

export function didDocUrl(did: string): string {
  if (did.startsWith("did:plc:")) {
    return `https://plc.directory/${did}`;
  }
  if (did.startsWith("did:web:")) {
    const segments = did.slice("did:web:".length).split(":").map(decodeURIComponent);
    const domain = segments[0];
    if (!domain) throw new Error(`invalid did:web: ${did}`);
    return segments.length === 1
      ? `https://${domain}/.well-known/did.json`
      : `https://${domain}/${segments.slice(1).join("/")}/did.json`;
  }
  throw new Error(`unsupported DID method: ${did}`);
}

export async function fetchDidDoc(did: string): Promise<DidDoc> {
  const resp = await fetch(didDocUrl(did));
  if (!resp.ok) throw new Error(`failed to fetch DID doc for ${did} (${resp.status})`);
  return resp.json() as Promise<DidDoc>;
}

export function pdsFromDidDoc(doc: DidDoc): string {
  const pds = (doc.service ?? []).find(
    (s) =>
      s.id === "#atproto_pds" ||
      s.id?.endsWith("#atproto_pds") ||
      s.type === "AtprotoPersonalDataServer",
  );
  if (!pds?.serviceEndpoint) throw new Error("no atproto PDS in DID document");
  return pds.serviceEndpoint;
}

export function handleFromDidDoc(doc: DidDoc, fallback: string): string {
  const aka = (doc.alsoKnownAs ?? []).find((a) => a.startsWith("at://"));
  return aka ? aka.slice("at://".length) : fallback;
}
