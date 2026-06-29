// Helpers for resolving an atproto handle/DID to its PDS service endpoint,
// so poll.blue can talk to any PDS instead of assuming bsky.social.

/**
 * Resolve a handle to a DID. If a DID is passed in, it is returned unchanged.
 */
export async function getDidFromHandle(handleOrDid: string): Promise<string> {
    const identifier = handleOrDid.trim().replace(/^@/, "");
    if (identifier.startsWith("did:")) {
        return identifier;
    }
    const response = await fetch(
        `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${
            encodeURIComponent(identifier)
        }`,
    );
    if (!response.ok) {
        throw new Error(
            `failed to resolve handle "${identifier}" (status ${response.status})`,
        );
    }
    const json = await response.json();
    if (!json?.did) {
        throw new Error(`no DID found for handle "${identifier}"`);
    }
    return json.did;
}

/**
 * Build the URL where a DID document can be fetched, for the DID methods
 * atproto supports (did:plc and did:web).
 */
export function getDidDocPath(did: string): string {
    if (did.startsWith("did:plc:")) {
        return `https://plc.directory/${did}`;
    }
    if (did.startsWith("did:web:")) {
        // did:web:example.com            -> https://example.com/.well-known/did.json
        // did:web:example.com:foo:bar    -> https://example.com/foo/bar/did.json
        // (colon-encoded ports like %3A are decoded per-segment)
        const segments = did.slice("did:web:".length).split(":").map(
            decodeURIComponent,
        );
        const domain = segments[0];
        if (!domain) {
            throw new Error(`invalid did:web: ${did}`);
        }
        if (segments.length === 1) {
            return `https://${domain}/.well-known/did.json`;
        }
        return `https://${domain}/${segments.slice(1).join("/")}/did.json`;
    }
    throw new Error(`unsupported DID method: ${did}`);
}

// deno-lint-ignore no-explicit-any
export async function fetchDidDoc(did: string): Promise<any> {
    const response = await fetch(getDidDocPath(did));
    if (!response.ok) {
        throw new Error(
            `failed to fetch DID document for ${did} (status ${response.status})`,
        );
    }
    return response.json();
}

/**
 * Find the atproto Personal Data Server endpoint within a DID document.
 * The PDS is not guaranteed to be the first service entry, so we match it by
 * its conventional id/type rather than by position.
 */
// deno-lint-ignore no-explicit-any
export function getPdsFromDidDoc(didDoc: any): string {
    // deno-lint-ignore no-explicit-any
    const services: any[] = Array.isArray(didDoc?.service) ? didDoc.service : [];
    const pds = services.find((service) =>
        service?.id === "#atproto_pds" ||
        (typeof service?.id === "string" &&
            service.id.endsWith("#atproto_pds")) ||
        service?.type === "AtprotoPersonalDataServer"
    );
    const endpoint = pds?.serviceEndpoint;
    if (typeof endpoint !== "string" || endpoint.length === 0) {
        throw new Error("no atproto PDS endpoint found in DID document");
    }
    return endpoint;
}

/**
 * Resolve a handle or DID all the way to its PDS service endpoint.
 */
export async function getPds(handleOrDid: string): Promise<string> {
    const did = await getDidFromHandle(handleOrDid);
    return getPdsFromDidDoc(await fetchDidDoc(did));
}
