// Server-side poll text + facet generation for the @-mention bot. Ported from
// the old Deno poll-utils. (The web frontend has its own copy for OAuth posts.)

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function generateId(length = 6): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function postLengthValid(text: string): boolean {
  if (byteLength(text) > 3000) return false;
  if ([...new Intl.Segmenter().segment(text)].length > 300) return false;
  return true;
}

export function postUriToBskyLink(postUri: string): string {
  if (!postUri) return "";
  const [did, , rkey] = postUri.split("/").slice(-3);
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

export type Enumeration = "upper" | "lower" | "number";
export interface Poll {
  question: string;
  answers: string[];
  enumeration: Enumeration;
}

// deno -> node: facet feature objects are plain JSON
interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<Record<string, unknown>>;
}
export interface PollPost {
  text: string;
  links: Facet[];
  pollFacets: Facet[];
}

interface Part {
  text: string;
  link?: string;
  pollFacet?: "question" | "option";
  truncate: boolean;
}

const EMOJI_NUMBERS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"];
const EMOJI_LETTERS = ["🅰", "🅱", "🅲", "🅳"];

export function generateBotPollText(opts: {
  visibleId: string;
  poll: Poll;
  author: string;
  postId: string;
}): PollPost {
  const { visibleId, poll, author, postId } = opts;
  const parts: Part[] = [
    { text: `"${poll.question}"`, pollFacet: "question", truncate: false },
    { text: ` asked by `, truncate: true },
    { text: `@${author}`, link: `https://bsky.app/profile/${author}/post/${postId}`, truncate: true },
    { text: `. Vote below!`, truncate: true },
    { text: `\n\n`, truncate: false },
  ];
  poll.answers.forEach((answer, i) => {
    const marker = poll.enumeration === "number" ? EMOJI_NUMBERS[i] : EMOJI_LETTERS[i];
    parts.push({ text: `${marker} `, truncate: false });
    parts.push({
      text: answer,
      link: `https://poll.blue/p/${visibleId}/${i + 1}`,
      pollFacet: "option",
      truncate: false,
    });
    parts.push({ text: "\n", truncate: false });
  });
  parts.push({ text: "\n", truncate: false });
  parts.push({ text: "📊 Show results", link: `https://poll.blue/p/${visibleId}/0`, truncate: false });

  let built = build(parts);
  if (!postLengthValid(built.text)) built = build(parts.filter((p) => !p.truncate));
  if (!postLengthValid(built.text)) throw new Error("post too long");
  return built;
}

function build(parts: Part[]): PollPost {
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
      pollFacets.push({ index: { byteStart: start, byteEnd: end }, features: [{ $type: "blue.poll.post.facet#question" }] });
    } else if (part.pollFacet === "option") {
      pollFacets.push({ index: { byteStart: start, byteEnd: end }, features: [{ $type: "blue.poll.post.facet#option", number: optionNumber++ }] });
    }
    len = end;
  }
  return { text: parts.map((p) => p.text).join(""), links, pollFacets };
}

// Build the "results after 24 hours" reply text.
export function generateResultsText(question: string, answers: string[], resultsWithAbstentions: number[]): string {
  const results = resultsWithAbstentions.slice(1);
  const total = results.reduce((a, b) => a + b, 0) || 1;
  const emoji = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"];
  const bar = (pct: number) => {
    const filled = Math.round(pct * 10);
    return "🟦".repeat(filled) + "⬜️".repeat(10 - filled);
  };
  const lines = [
    `Poll results after 24 hours: ${question}`,
    "",
    ...results.flatMap((count, i) => [`${emoji[i]} ${answers[i]}`, `${bar(count / total)} (${count})`, ""]),
  ];
  return lines.join("\n").trim();
}

// Parse a "@bot question\nA. one\nB. two" mention into a poll.
const REGEXES: [Enumeration, RegExp][] = [
  ["upper", /^.*?@([a-zA-Z0-9_.]+)[\s\n]*(.*)\s*\n+\s*A\s*[.\-:)]\s*(.*?)\s*\n\s*B\s*[.\-:)]\s*(.*?)\s*(?:\n\s*C\s*[.\-:)]\s*(.*?)\s*(?:\n\s*D\s*[.\-:)]\s*(.*?))?)?\s*$/m],
  ["lower", /^.*?@([a-zA-Z0-9_.]+)[\s\n]*(.*)\s*\n+\s*a\s*[.\-:)]\s*(.*?)\s*\n\s*b\s*[.\-:)]\s*(.*?)\s*(?:\n\s*c\s*[.\-:)]\s*(.*?)\s*(?:\n\s*d\s*[.\-:)]\s*(.*?))?)?\s*$/m],
  ["number", /^.*?@([a-zA-Z0-9_.]+)[\s\n]*(.*)\s*\n+\s*1\s*[.\-:)]\s*(.*?)\s*\n\s*2\s*[.\-:)]\s*(.*?)\s*(?:\n\s*3\s*[.\-:)]\s*(.*?)\s*(?:\n\s*4\s*[.\-:)]\s*(.*?))?)?\s*$/m],
];

export function parseMention(text: string): Poll | null {
  for (const [enumeration, regex] of REGEXES) {
    const m = regex.exec(text);
    if (m) {
      return {
        question: m[2],
        answers: m.slice(3).filter((a) => a !== undefined).map((a) => a.trim()),
        enumeration,
      };
    }
  }
  return null;
}
