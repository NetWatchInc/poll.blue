// Pure poll helpers (ported from the Deno backend's poll-utils). No deps, runs
// in the browser. Produces the post text + richtext facets, including the
// blue.poll.* facets and the poll.blue/p/{id}/{n} option links the backend
// verifies against.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function generateId(length = 6): string {
  let result = "";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i++) result += ALPHABET[bytes[i] % ALPHABET.length];
  return result;
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

// One shared segmenter — constructing Intl.Segmenter per keystroke is wasteful.
let _seg: Intl.Segmenter | undefined;
function segmenter(): Intl.Segmenter {
  return (_seg ??= new Intl.Segmenter());
}

export function graphemeLen(s: string): number {
  return [...segmenter().segment(s)].length;
}

export function postLengthValid(text: string): boolean {
  if (byteLength(text) > 3000) return false;
  if (graphemeLen(text) > 300) return false;
  return true;
}

export function postUriToBskyLink(postUri: string): string {
  if (!postUri) return "";
  const [did, , rkey] = postUri.split("/").slice(-3);
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<Record<string, unknown>>;
}

interface TemplatePart {
  text: string;
  link?: string;
  pollFacet?: "question" | "option";
  truncate: boolean;
}

export interface PollText {
  text: string;
  links: Facet[];
  pollFacets: Facet[];
}

const EMOJI_NUMBERS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

// Compose the post's text parts: the free-form body, then the option lines, then
// "Show results". Shared by the facet builder and the plain-text length counter.
function composeParts(bodyText: string, answers: string[], base: string, visibleId: string): TemplatePart[] {
  const parts: TemplatePart[] = [{ text: `${bodyText}\n\n`, truncate: false }];
  answers.forEach((answer, i) => {
    parts.push({ text: `${EMOJI_NUMBERS[i]} `, truncate: false });
    parts.push({ text: answer, link: `${base}/p/${visibleId}/${i + 1}`, pollFacet: "option", truncate: false });
    parts.push({ text: "\n", truncate: false });
  });
  parts.push({ text: "\n", truncate: false });
  parts.push({ text: "📊 Show results", link: `${base}/p/${visibleId}/0`, truncate: false });
  return parts;
}

export function generatePollText(opts: {
  visibleId: string;
  body: { text: string; facets?: Facet[] };
  answers: string[];
  origin?: string;
}): PollText {
  const base = opts.origin ?? "https://poll.blue";
  const built = buildTemplate(composeParts(opts.body.text, opts.answers, base, opts.visibleId));
  // The body sits at offset 0, so its facets' byte offsets are already correct.
  if (opts.body.facets?.length) built.links = [...opts.body.facets, ...built.links];
  if (!postLengthValid(built.text)) {
    throw new Error("poll is too long");
  }
  return built;
}

/** The plain post text (no facets) — for the live grapheme counter + preview. */
export function composedText(bodyText: string, answers: string[]): string {
  return composeParts(bodyText, answers, "", "").map((p) => p.text).join("");
}

function buildTemplate(parts: TemplatePart[]): PollText {
  const links: Facet[] = [];
  const pollFacets: Facet[] = [];
  let optionNumber = 1;
  let len = 0;
  for (const part of parts) {
    const start = len;
    const end = len + byteLength(part.text);
    if (part.link) {
      links.push({
        index: { byteStart: start, byteEnd: end },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: part.link }],
      });
    }
    if (part.pollFacet === "question") {
      pollFacets.push({
        index: { byteStart: start, byteEnd: end },
        features: [{ $type: "blue.poll.post.facet#question" }],
      });
    } else if (part.pollFacet === "option") {
      pollFacets.push({
        index: { byteStart: start, byteEnd: end },
        features: [{ $type: "blue.poll.post.facet#option", number: optionNumber++ }],
      });
    }
    len = end;
  }
  return { text: parts.map((p) => p.text).join(""), links, pollFacets };
}
